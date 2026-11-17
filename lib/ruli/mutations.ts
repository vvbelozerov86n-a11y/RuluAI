/** D1 batches are transactional. A unique token gates every dependent write. */
export type SqlValue = string | number | null;
export type Statement = { sql: string; params: SqlValue[] };
export type Mutation = {
  id: string;
  version: number;
  deleted?: boolean;
  status?: string;
  guard?: Statement;
  set?: Statement;
  statements?: (gate: Statement, token: string) => Statement[];
  touchAncestors?: boolean;
};

export function planMutation(mutation: Mutation, token: string, now: string): Statement[] {
  const condition = ["id = ?", "version = ?", mutation.deleted ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"];
  const checks: SqlValue[] = [mutation.id, mutation.version];
  if (mutation.status !== undefined) {
    condition.push("status = ?");
    checks.push(mutation.status);
  }
  if (mutation.guard) {
    condition.push(`(${mutation.guard.sql})`);
    checks.push(...mutation.guard.params);
  }
  const set = mutation.set ? `${mutation.set.sql}, ` : "";
  const gate: Statement = {
    sql: "EXISTS (SELECT 1 FROM tasks WHERE id = ? AND last_mutation_id = ?)",
    params: [mutation.id, token],
  };
  const statements: Statement[] = [{
    sql: `UPDATE tasks SET ${set}version = version + 1, updated_at = ?, last_mutation_id = ? WHERE ${condition.join(" AND ")}`,
    params: [...(mutation.set?.params ?? []), now, token, ...checks],
  }, ...(mutation.statements?.(gate, token) ?? [])];
  if (mutation.touchAncestors !== false) {
    statements.push({
      sql: `WITH RECURSIVE ancestors(id) AS (
        SELECT parent_id FROM tasks WHERE id = ?
        UNION ALL SELECT t.parent_id FROM tasks t JOIN ancestors a ON t.id = a.id WHERE t.parent_id IS NOT NULL
      ) UPDATE tasks SET version = version + 1, updated_at = ?, last_mutation_id = ?
        WHERE deleted_at IS NULL AND id IN (SELECT id FROM ancestors) AND ${gate.sql}`,
      params: [mutation.id, now, token, ...gate.params],
    });
  }
  return statements;
}

export async function runMutation(db: D1Database, mutation: Mutation): Promise<boolean> {
  const statements = planMutation(mutation, crypto.randomUUID(), new Date().toISOString());
  const results = await db.batch(statements.map(({ sql, params }) => db.prepare(sql).bind(...params)));
  return Number(results[0]?.meta?.changes ?? 0) === 1;
}
