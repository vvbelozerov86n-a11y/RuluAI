/** These triggers mirror migration 0008 for newly provisioned companies. A
 * conflict must abort even when a caller uses INSERT/UPDATE OR IGNORE. */
export function workspaceDirectoryTriggers(db: D1Database, id: string): D1PreparedStatement[] {
  if (id !== "legacy" && !/^[a-f0-9]{32}$/.test(id)) throw new Error("Некорректный идентификатор компании");
  const prefix = id === "legacy" ? "" : `w_${id}_`;
  const accounts = `${prefix}team_accounts`;
  const profile = `${prefix}company_profile`;
  // Only the original site had globally routable invitations issued by email.
  // A manager in a new workspace cannot reserve an unverified address across the site.
  const verifiedOnly = id === "legacy" ? "" : " WHEN NEW.user_id IS NOT NULL";
  const conflict = `SELECT RAISE(ABORT,'account already belongs to another workspace')
    WHERE ${id === "legacy" ? "" : "NEW.user_id IS NOT NULL AND "}EXISTS (SELECT 1 FROM workspace_accounts WHERE workspace_id<>'${id}'
      AND (email=lower(trim(NEW.email)) OR user_id=NEW.user_id));`;
  const copyProfile = `SELECT RAISE(ABORT,'invitation already exists') WHERE EXISTS
    (SELECT 1 FROM workspaces WHERE id<>'${id}' AND invite_token=NEW.invite_token);
    UPDATE workspaces SET name=NEW.name,invite_token=NEW.invite_token WHERE id='${id}';`;
  const accountUpdate = id === "legacy"
    ? `UPDATE workspace_accounts SET email=lower(trim(NEW.email)),user_id=NEW.user_id
        WHERE workspace_id='${id}' AND email=lower(trim(OLD.email));`
    : `DELETE FROM workspace_accounts WHERE workspace_id='${id}' AND email=lower(trim(OLD.email)) AND OLD.user_id IS NOT NULL;
      INSERT INTO workspace_accounts(email,user_id,workspace_id)
        SELECT lower(trim(NEW.email)),NEW.user_id,'${id}' WHERE NEW.user_id IS NOT NULL;`;
  return [
    `CREATE TRIGGER ${prefix}directory_account_insert AFTER INSERT ON ${accounts}${verifiedOnly} BEGIN
      ${conflict}
      INSERT INTO workspace_accounts(email,user_id,workspace_id) VALUES (lower(trim(NEW.email)),NEW.user_id,'${id}'); END`,
    `CREATE TRIGGER ${prefix}directory_account_update AFTER UPDATE OF email,user_id ON ${accounts} BEGIN
      ${conflict}
      ${accountUpdate} END`,
    `CREATE TRIGGER ${prefix}directory_account_delete AFTER DELETE ON ${accounts} BEGIN
      DELETE FROM workspace_accounts WHERE workspace_id='${id}' AND email=lower(trim(OLD.email)); END`,
    `CREATE TRIGGER ${prefix}directory_profile_insert AFTER INSERT ON ${profile} BEGIN ${copyProfile} END`,
    `CREATE TRIGGER ${prefix}directory_profile_update AFTER UPDATE OF name,invite_token ON ${profile} BEGIN ${copyProfile} END`,
    `CREATE TRIGGER ${prefix}directory_profile_delete AFTER DELETE ON ${profile} BEGIN
      UPDATE workspaces SET name=NULL,invite_token=NULL WHERE id='${id}'; END`,
  ].map(sql => db.prepare(sql));
}
