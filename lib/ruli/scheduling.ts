import { addDaysISO, isISODate, type TaskNode } from "./model.ts";

export type ScheduleEntry = {
  id?: string;
  taskId: string;
  memberId: string;
  title: string;
  startDate: string;
  endDate: string;
  hours: number;
};

/** Active reservations only; completed work belongs in display history. */
export type ScheduleWorkloadEntry = ScheduleEntry & { hoursPerDay?: number };

export type ScheduleOptions = {
  startDate: string;
  hoursPerDay: number;
  estimatedHoursPerTask?: number;
  weekdaysOnly: boolean;
};

export const MAX_SCHEDULE_ENTRIES = 2000;
export const MAX_SCHEDULE_DAYS = 3660;
export const MAX_EXISTING_SCHEDULE_ENTRIES = 20_000;
export const MAX_ESTIMATED_HOURS_PER_TASK = 240;
export const DEFAULT_ESTIMATED_HOURS_PER_TASK = 4;
const DAY_MS = 86_400_000;
const EPSILON = 1e-7;

function dayNumber(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getTime() / DAY_MS;
}

/** Every plan sharing a member/day keeps its limit, including a stricter one. */
export function scheduleCapacityOnDate(
  entries: ScheduleWorkloadEntry[], memberId: string, date: string, hoursPerDay = 12,
): { hours: number; limit: number } {
  let hours = 0, limit = hoursPerDay;
  for (const entry of entries) {
    if (entry.memberId !== memberId || entry.startDate > date || entry.endDate < date) continue;
    hours += entry.hours / (dayNumber(entry.endDate) - dayNumber(entry.startDate) + 1);
    limit = Math.min(limit, entry.hoursPerDay ?? 12);
  }
  return { hours, limit };
}

/** Inclusive calendar range; no host timezone or DST arithmetic. */
export function validateScheduleRange(startDate: string, endDate: string, hours: number, hoursPerDay = 12): string | null {
  if (!isISODate(startDate) || !isISODate(endDate)) return "Укажите существующие даты начала и окончания";
  if (endDate < startDate) return "Окончание не может быть раньше начала";
  const days = dayNumber(endDate) - dayNumber(startDate) + 1;
  if (days > MAX_SCHEDULE_DAYS) return `Интервал не может превышать ${MAX_SCHEDULE_DAYS} дней`;
  if (!Number.isFinite(hoursPerDay) || hoursPerDay < 1 || hoursPerDay > 12) return "Рабочий день должен содержать от 1 до 12 часов";
  if (!Number.isFinite(hours) || hours <= 0) return "Количество часов должно быть положительным числом";
  if (hours > days * hoursPerDay + EPSILON) return "Количество часов превышает вместимость выбранного интервала";
  return null;
}

export function validateScheduleOptions(options: ScheduleOptions): string | null {
  if (!options || !isISODate(options.startDate)) return "Укажите существующую дату начала графика";
  if (!Number.isFinite(options.hoursPerDay) || options.hoursPerDay < 1 || options.hoursPerDay > 12) {
    return "Рабочий день должен содержать от 1 до 12 часов";
  }
  const estimate = options.estimatedHoursPerTask ?? DEFAULT_ESTIMATED_HOURS_PER_TASK;
  if (!Number.isFinite(estimate) || estimate < 0.25 || estimate > MAX_ESTIMATED_HOURS_PER_TASK) {
    return `Оценка поручения должна быть от 0,25 до ${MAX_ESTIMATED_HOURS_PER_TASK} часов`;
  }
  if (typeof options.weekdaysOnly !== "boolean") return "Укажите, нужно ли исключать выходные";
  return null;
}

type Deadline = { id: string; title: string; date: string };
type Candidate = { task: TaskNode; deadlines: Deadline[] };

/**
 * Deterministic capacity planning, not an AI estimate. Tasks follow tree order;
 * each owner works sequentially, different owners can work on the same date.
 * Generated entries are daily (startDate === endDate), preserving exact hours
 * and gaps. Existing multi-day entries spread their total hours evenly over
 * inclusive CALENDAR days; existing daily entries retain their exact hours.
 * Callers replacing a plan must exclude its former entries from `existing`.
 * Invalid input throws. Capacity, deadline and generation-limit issues are
 * warnings; an incomplete task is never returned as a partially filled plan.
 */
export function generateSchedule(
  node: TaskNode,
  options: ScheduleOptions,
  existing: ScheduleWorkloadEntry[] = [],
): { entries: ScheduleEntry[]; warnings: string[] } {
  const error = validateScheduleOptions(options);
  if (error) throw new RangeError(error);
  if (!Array.isArray(existing) || existing.length > MAX_EXISTING_SCHEDULE_ENTRIES) {
    throw new RangeError(`Для расчёта допустимо до ${MAX_EXISTING_SCHEDULE_ENTRIES} существующих записей`);
  }
  const entries: ScheduleEntry[] = [];
  const warnings: string[] = [];
  const candidates: Candidate[] = [];
  const deadlineIssues = new Map<string, Deadline & { endDate: string }>();
  const missingOwner: string[] = [];
  const collect = (task: TaskNode, deadlines: Deadline[]) => {
    if (task.deletedAt) return;
    const next = [...deadlines];
    if (task.dueDate) {
      if (isISODate(task.dueDate)) next.push({ id: task.id, title: task.title, date: task.dueDate });
      else warnings.push(`«${task.title}»: некорректный срок не использован при расчёте.`);
    }
    if (task.kind === "group") {
      for (const child of task.children) collect(child, next);
    } else if (task.status !== "done") {
      if (task.ownerId) candidates.push({ task, deadlines: next });
      else missingOwner.push(task.title);
    }
  };
  collect(node, []);
  if (missingOwner.length) warnings.push(`Не назначен ответственный: ${missingOwner.join(", ")}. Эти поручения не запланированы.`);
  if (!candidates.length) return { entries, warnings };

  const estimate = options.estimatedHoursPerTask ?? DEFAULT_ESTIMATED_HOURS_PER_TASK;
  const start = dayNumber(options.startDate);
  const horizon = Math.min(MAX_SCHEDULE_DAYS, dayNumber("9999-12-31") - start + 1);
  const startWeekday = new Date(`${options.startDate}T12:00:00Z`).getUTCDay();
  const owners = new Set(candidates.map(({ task }) => task.ownerId));
  const workload = new Map<string, Map<number, number>>();
  const limits = new Map<string, Map<number, number>>();
  for (const owner of owners) {
    workload.set(owner, new Map());
    limits.set(owner, new Map());
  }
  for (const item of existing) {
    if (!item || typeof item.taskId !== "string" || !item.taskId || typeof item.memberId !== "string" || !item.memberId) {
      throw new RangeError("Существующая запись графика должна содержать задачу и исполнителя");
    }
    const issue = validateScheduleRange(item.startDate, item.endDate, item.hours, item.hoursPerDay ?? 12);
    if (issue) throw new RangeError(`Некорректная запись графика «${item.title || item.taskId}»: ${issue}`);
    const reserved = workload.get(item.memberId);
    if (!reserved) continue;
    const dailyLimits = limits.get(item.memberId)!;
    const from = dayNumber(item.startDate) - start;
    const to = dayNumber(item.endDate) - start;
    const dailyHours = item.hours / (to - from + 1);
    for (let day = Math.max(0, from); day <= Math.min(horizon - 1, to); day++) {
      reserved.set(day, (reserved.get(day) ?? 0) + dailyHours);
      dailyLimits.set(day, Math.min(dailyLimits.get(day) ?? options.hoursPerDay, item.hoursPerDay ?? 12));
    }
  }
  const isWorkingDay = (day: number) => !options.weekdaysOnly || ![0, 6].includes((startWeekday + day) % 7);
  for (const [owner, reserved] of workload) {
    const overloaded = [...reserved].filter(([day, hours]) => isWorkingDay(day) && hours > (limits.get(owner)!.get(day) ?? options.hoursPerDay) + EPSILON).length;
    if (overloaded) warnings.push(`Исполнитель ${owner}: существующая загрузка превышает дневной лимит в ${overloaded} днях. Новые часы в эти дни не добавлены.`);
  }

  const cursor = new Map<string, number>();
  const notScheduled: string[] = [];
  let entryLimitReached = false;
  for (const { task, deadlines } of candidates) {
    if (entryLimitReached) { notScheduled.push(task.title); continue; }
    const reserved = workload.get(task.ownerId)!;
    const dailyLimits = limits.get(task.ownerId)!;
    let day = cursor.get(task.ownerId) ?? 0;
    let remaining = estimate;
    const allocation: { day: number; hours: number }[] = [];
    while (remaining > EPSILON && day < horizon) {
      if (isWorkingDay(day)) {
        const available = Math.max(0, (dailyLimits.get(day) ?? options.hoursPerDay) - (reserved.get(day) ?? 0));
        if (available > EPSILON) {
          if (entries.length + allocation.length >= MAX_SCHEDULE_ENTRIES) { entryLimitReached = true; break; }
          const hours = Math.min(remaining, available);
          allocation.push({ day, hours });
          remaining -= hours;
        }
      }
      if (remaining > EPSILON) day++;
    }
    if (remaining > EPSILON) {
      notScheduled.push(task.title);
      // Do not commit a partial task; other owners can still use the horizon.
      if (!entryLimitReached) cursor.set(task.ownerId, horizon);
      continue;
    }
    for (const part of allocation) {
      const date = addDaysISO(options.startDate, part.day);
      const hours = Math.round(part.hours * 1e8) / 1e8;
      reserved.set(part.day, (reserved.get(part.day) ?? 0) + part.hours);
      entries.push({ taskId: task.id, memberId: task.ownerId, title: task.title, startDate: date, endDate: date, hours });
    }
    cursor.set(task.ownerId, day);
    const endDate = addDaysISO(options.startDate, day);
    for (const deadline of deadlines) {
      if (endDate > deadline.date && endDate > (deadlineIssues.get(deadline.id)?.endDate ?? "")) {
        deadlineIssues.set(deadline.id, { ...deadline, endDate });
      }
    }
  }
  for (const deadline of deadlineIssues.values()) {
    warnings.push(`«${deadline.title}»: срок ${deadline.date} не соблюдается при текущем порядке задач и заданной загрузке; расчётное окончание ${deadline.endDate}.`);
  }
  if (notScheduled.length) {
    const reason = entryLimitReached ? `лимит ${MAX_SCHEDULE_ENTRIES} записей` : `горизонт ${horizon} календарных дней`;
    warnings.push(`Не запланировано поручений: ${notScheduled.length}; достигнут ${reason}. Измените дату, загрузку или объём: ${notScheduled.slice(0, 5).join(", ")}${notScheduled.length > 5 ? "…" : ""}.`);
  }
  return { entries, warnings };
}
