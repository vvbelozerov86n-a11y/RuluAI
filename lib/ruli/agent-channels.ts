/** taskIdExpression is an internal SQL expression, never request input. */
export function activeTaskAccessSql(taskIdExpression: string): string {
  return `EXISTS (
    WITH RECURSIVE ancestors(id,parent_id,deleted_at) AS (
      SELECT id,parent_id,deleted_at FROM tasks WHERE id=${taskIdExpression}
      UNION
      SELECT t.id,t.parent_id,t.deleted_at FROM tasks t JOIN ancestors a ON t.id=a.parent_id
    )
    SELECT 1 FROM ancestors WHERE NOT EXISTS (SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL)
  )`;
}

export const ACTIVE_TASK_ACCESS_SQL = activeTaskAccessSql("?");

/** The same active subtree used to offer a private channel in the task UI.
 * Bind taskId, memberId, memberId. Keep this predicate inside writes as well as reads.
 */
export const PRIVATE_CHANNEL_ACCESS_SQL = `EXISTS (
  WITH RECURSIVE root AS (
    SELECT id,parent_id,owner_id,kind,deleted_at FROM tasks WHERE id=?
  ), ancestors(id,parent_id,deleted_at) AS (
    SELECT id,parent_id,deleted_at FROM root
    UNION
    SELECT t.id,t.parent_id,t.deleted_at FROM tasks t JOIN ancestors a ON t.id=a.parent_id
  ), subtree(id,owner_id,kind) AS (
    SELECT id,owner_id,kind FROM root WHERE deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL)
    UNION
    SELECT t.id,t.owner_id,t.kind FROM tasks t JOIN subtree p ON t.parent_id=p.id
      WHERE p.kind='group' AND t.deleted_at IS NULL
  )
  SELECT 1 FROM subtree s WHERE s.owner_id=?
    OR EXISTS (SELECT 1 FROM task_participants p WHERE p.task_id=s.id AND p.member_id=?)
)`;

export async function taskHasPrivateChannel(db: D1Database, taskId: string, memberId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS allowed WHERE ${PRIVATE_CHANNEL_ACCESS_SQL}`)
    .bind(taskId, memberId, memberId).first<{ allowed: number }>();
  return Boolean(row);
}
