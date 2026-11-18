// Each company has its own task tree, local member IDs and unique constraints.
// The original tables remain the legacy workspace and the migration-owned schema template.
const workspaceTables = new Set([
  "members", "tasks", "task_participants", "team_accounts", "task_messages",
  "schedule_entries", "schedule_plans", "ai_runs", "bot_configs", "bot_webhook_outbox",
  "bot_api_idempotency", "company_profile", "removed_team_accounts",
]);

export async function lookupIdentityWorkspace(
  raw: D1Database, user: {userId: string; email: string}, ownerEmail?: string,
): Promise<string | null> {
  const email = user.email.trim().toLowerCase();
  const row = await raw.prepare(`SELECT workspace_id,user_id FROM workspace_accounts
    WHERE user_id=? OR email=?
    ORDER BY CASE WHEN user_id=? THEN 0 ELSE 1 END LIMIT 1`)
    .bind(user.userId, email, user.userId).first<{workspace_id: string; user_id: string | null}>();
  if (row) return !row.user_id || row.user_id === user.userId ? row.workspace_id : null;
  return ownerEmail?.trim().toLowerCase() === email && email ? "legacy" : null;
}

function workspacePrefix(id: string): string {
  if (id === "legacy") return "";
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid workspace identifier");
  return `w_${id}_`;
}

// Tokenize SQL identifiers so text values, bound parameters and comments stay intact.
const sqlTokens = /'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*/g;

function namespaceSql(sql: string, prefix: string, names: ReadonlySet<string>): string {
  let previous = "";
  return sql.replace(sqlTokens, token => {
    if (token.startsWith("--") || token.startsWith("/*")) return token;
    if (token.startsWith("'")) {
      if (["from","join","into","update","table","references"].includes(previous)) {
        throw new Error("Use identifier quotes for workspace table names");
      }
      previous = "";
      return token;
    }
    const quoted = ['"', "`", "["].includes(token[0]);
    const id = (quoted ? token.slice(1,-1) : token).toLowerCase();
    previous = quoted ? "" : id;
    if (id === "workspaces" || id === "workspace_accounts" || /^w_[a-f0-9]{32}_/.test(id)
      || id.startsWith("sqlite_")) throw new Error("System tables require the directory database");
    if (!names.has(id)) return token;
    return quoted ? token[0] + prefix + id + token.at(-1) : prefix + id;
  });
}

export function workspaceDatabase(raw: D1Database, id: string): D1Database {
  const prefix = workspacePrefix(id);
  const scope = (query: string) => namespaceSql(query, prefix, workspaceTables);
  return {
    prepare: query => raw.prepare(scope(query)),
    batch: statements => raw.batch(statements),
    exec: query => raw.exec(scope(query)),
    withSession(bookmark) {
      const session = raw.withSession(bookmark);
      return {
        prepare: query => session.prepare(scope(query)),
        batch: statements => session.batch(statements),
        getBookmark: () => session.getBookmark(),
      };
    },
    dump: async () => { throw new Error("Workspace dumps must not include other companies"); },
  };
}

export async function workspaceSchemaStatements(raw: D1Database, id: string): Promise<D1PreparedStatement[]> {
  const prefix = workspacePrefix(id);
  if (!prefix) throw new Error("The legacy workspace already has its schema");
  const tables = Array.from(workspaceTables);
  // Only copy schema, never business rows, automatic indexes or directory triggers.
  const placeholders = tables.map(() => "?").join(",");
  const {results} = await raw.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE tbl_name IN (${placeholders}) AND type IN ('table','index') AND sql IS NOT NULL
    ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name`)
    .bind(...tables).all<{type: string; name: string; sql: string}>();
  if (results.filter(row => row.type === "table").length !== tables.length) {
    throw new Error("Company registration requires the current database migrations");
  }
  const schemaNames = new Set([...tables, ...results.map(row => row.name)]);
  return results.map(row => raw.prepare(namespaceSql(row.sql, prefix, schemaNames)));
}
