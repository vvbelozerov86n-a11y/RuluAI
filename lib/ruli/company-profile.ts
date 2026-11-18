import { env } from "cloudflare:workers";
import { requireChatGPTUser, type ChatGPTUser } from "../../app/chatgpt-auth";
import { getCurrentWorkspaceId, getD1, getSystemD1 } from "../../db";
import { requireAccess, requireManager } from "./access";

export async function canOpenCurrentTeam(user: ChatGPTUser): Promise<boolean> {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return false;
  const email = user.email.trim().toLowerCase();
  if (workspaceId !== "legacy" || email !== env.RULI_OWNER_EMAIL?.trim().toLowerCase()) return true;

  // The configured address can claim an empty owner seat, but changing the
  // setting does not entitle a different account to an occupied seat.
  const eligible = await getSystemD1().prepare(`SELECT 1 WHERE
    NOT EXISTS (SELECT 1 FROM team_accounts WHERE member_id='me')
    OR EXISTS (SELECT 1 FROM team_accounts WHERE user_id=? OR (user_id IS NULL AND email=?))`)
    .bind(user.userId, email).first();
  return Boolean(eligible);
}

export async function getManagerCompanyProfile() {
  await requireManager("/register");
  return (await getD1()).prepare("SELECT name,invite_token AS inviteToken FROM company_profile WHERE id='workspace'")
    .first<{ name: string; inviteToken: string }>();
}

export async function getCurrentCompanyName(): Promise<string | null> {
  await requireAccess("/team");
  const row = await (await getD1()).prepare("SELECT name FROM company_profile WHERE id='workspace'").first<{name: string}>();
  return row?.name ?? null;
}

export async function getCompanyRegistrationAccess() {
  await requireChatGPTUser("/register");
  if (!await getCurrentWorkspaceId()) return { kind: "new" } as const;
  const viewer = await requireAccess("/register");
  if (viewer.role !== "manager") return { kind: "member" } as const;
  const profile = await (await getD1()).prepare("SELECT id FROM company_profile WHERE id='workspace'").first();
  return { kind: "manager", displayName: viewer.displayName, memberId: viewer.memberId, registered: Boolean(profile) } as const;
}
