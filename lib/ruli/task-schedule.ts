import { validateScheduleRange, type ScheduleEntry } from "./scheduling.ts";

type Change =
  | { kind: "reassign"; taskId: string; ownerId: string }
  | { kind: "restore"; batchId: string }
  | { kind: "reopen"; taskId: string };

type Reservation = ScheduleEntry & { hoursPerDay: number; incoming: number };
type CapacityConflict = { memberId: string; date: string; hours: number; limit: number };
type Event = { hours: number; limit: number; count: number; incoming: number };
const DAY_MS = 86_400_000;

/** Check only intervals changed by this operation, including multi-day entries.
 * A sweep avoids expanding every reservation into thousands of calendar days.
 * Each participating plan's daily limit applies; completed work reserves nothing.
 */
function capacityConflict(rows: Reservation[]): CapacityConflict | null {
  const byMember = new Map<string, Map<number, Event[]>>();
  for (const row of rows) {
    const invalid = validateScheduleRange(row.startDate, row.endDate, row.hours, row.hoursPerDay);
    if (invalid) throw new Error(`Invalid stored schedule: ${invalid}`);
    const start = Date.parse(row.startDate);
    const end = Date.parse(row.endDate) + DAY_MS;
    const hours = row.hours / ((end - start) / DAY_MS);
    const events = byMember.get(row.memberId) ?? new Map<number, Event[]>();
    for (const [date, count] of [[start, 1], [end, -1]]) {
      const changes = events.get(date) ?? [];
      changes.push({ hours: hours * count, limit: row.hoursPerDay, count, incoming: row.incoming * count });
      events.set(date, changes);
    }
    byMember.set(row.memberId, events);
  }
  for (const [memberId, events] of byMember) {
    let hours = 0;
    let incoming = 0;
    const limits = new Map<number, number>();
    for (const [date, changes] of [...events].sort(([a], [b]) => a - b)) {
      for (const change of changes) {
        hours += change.hours;
        incoming += change.incoming;
        const count = (limits.get(change.limit) ?? 0) + change.count;
        if (count) limits.set(change.limit, count);
        else limits.delete(change.limit);
      }
      if (!incoming) continue;
      const limit = Math.min(...limits.keys());
      if (hours > limit + 1e-7) {
        return { memberId, date: new Date(date).toISOString().slice(0, 10), hours, limit };
      }
    }
  }
  return null;
}

/** Read the prospective workload before a task mutation. The caller must compare
 * the root version it read BEFORE this query and bump that version in the same
 * atomic batch as the mutation, so a concurrent plan cannot invalidate the check.
 */
export async function taskScheduleConflict(db: D1Database, change: Change): Promise<string | null> {
  let memberSql = "s.member_id";
  let incomingSql: string;
  let activeSql = "t.deleted_at IS NULL AND p.deleted_at IS NULL AND t.status<>'done'";
  const params: Array<string> = [];
  if (change.kind === "reassign") {
    memberSql = "CASE WHEN t.id=? THEN ? ELSE s.member_id END";
    incomingSql = "CASE WHEN t.id=? THEN 1 ELSE 0 END";
    params.push(change.taskId, change.ownerId, change.taskId);
  } else if (change.kind === "restore") {
    incomingSql = "CASE WHEN t.deletion_batch_id=? OR p.deletion_batch_id=? THEN 1 ELSE 0 END";
    activeSql = `(t.deleted_at IS NULL OR t.deletion_batch_id=?)
      AND (p.deleted_at IS NULL OR p.deletion_batch_id=?) AND t.status<>'done'`;
    params.push(change.batchId, change.batchId, change.batchId, change.batchId);
  } else {
    incomingSql = "CASE WHEN t.id=? THEN 1 ELSE 0 END";
    activeSql = "t.deleted_at IS NULL AND p.deleted_at IS NULL AND (t.status<>'done' OR t.id=?)";
    params.push(change.taskId, change.taskId);
  }
  const result = await db.prepare(`SELECT s.task_id AS taskId,${memberSql} AS memberId,t.title,
    s.start_date AS startDate,s.end_date AS endDate,s.hours,
    COALESCE(sp.hours_per_day,8) AS hoursPerDay,${incomingSql} AS incoming
    FROM schedule_entries s JOIN tasks t ON t.id=s.task_id JOIN tasks p ON p.id=s.plan_task_id
    LEFT JOIN schedule_plans sp ON sp.task_id=s.plan_task_id
    WHERE t.kind='leaf' AND ${activeSql}`).bind(...params).all<Reservation>();
  const conflict = capacityConflict(result.results);
  if (!conflict) return null;
  const member = await db.prepare("SELECT name FROM members WHERE id=?").bind(conflict.memberId).first<{ name: string }>();
  const hours = Number(conflict.hours.toFixed(2));
  return `На ${conflict.date} нагрузка исполнителя «${member?.name ?? conflict.memberId}» составит ${hours} ч при лимите ${conflict.limit} ч. Сначала освободите время или измените график.`;
}
