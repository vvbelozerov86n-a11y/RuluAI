import { getSystemD1 } from "../../db";
import { lookupIdentityWorkspace, workspaceDatabase } from "../../db/workspace-storage";
import { env } from "cloudflare:workers";
import type { ChatGPTUser } from "../../app/chatgpt-auth";

export function createInviteToken(): string {
  return crypto.randomUUID();
}

export function isInviteToken(token: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token);
}

export async function getCompanyInvitation(token: string) {
  if (!isInviteToken(token)) return null;
  return getSystemD1().prepare("SELECT name,id AS workspaceId FROM workspaces WHERE invite_token=? AND name IS NOT NULL")
    .bind(token).first<{name: string; workspaceId: string}>();
}

type InviteMember = {foreign:true; bound?:never; displayName?:never} | {foreign?:false; displayName:string; bound:boolean};

export async function getExistingInviteMember(user: Pick<ChatGPTUser, "userId" | "email">, workspaceId: string): Promise<InviteMember | null> {
  const raw = getSystemD1();
  const email = user.email.trim().toLowerCase();
  // The normal sign-in lookup also reserves the configured legacy owner's address.
  // A verified email bound to another user may not be used to create a second account.
  const assigned = await lookupIdentityWorkspace(raw, user, env.RULI_OWNER_EMAIL) ??
    await raw.prepare("SELECT workspace_id FROM workspace_accounts WHERE email=?").bind(email).first<string>("workspace_id");
  if (assigned && assigned !== workspaceId) return {foreign:true};
  // Pending manual registrations belong only to their originating company.
  // An unbound account may therefore exist locally without any directory row.
  const row = await workspaceDatabase(raw, workspaceId).prepare(`SELECT m.name AS displayName, a.user_id AS userId
    FROM team_accounts a JOIN members m ON m.id=a.member_id
    WHERE m.removed_at IS NULL AND m.type='human' AND a.role IN ('manager','executor','viewer')
      AND (a.user_id=? OR (a.user_id IS NULL AND a.email=?))
    ORDER BY a.user_id IS NULL LIMIT 1`)
    .bind(user.userId, email).first<{displayName: string; userId: string | null}>();
  return row ? {displayName:row.displayName, bound:row.userId !== null} : null;
}
