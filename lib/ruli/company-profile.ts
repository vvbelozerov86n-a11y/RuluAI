import { env } from "cloudflare:workers";
import { requireChatGPTUser } from "../../app/chatgpt-auth";
import { getD1, getSystemD1 } from "../../db";
import { lookupIdentityWorkspace } from "../../db/workspace-storage";
import { requireAccess, requireManager } from "./access";

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
  const user = await requireChatGPTUser("/register");
  const workspaceId = await lookupIdentityWorkspace(getSystemD1(), user, env.RULI_OWNER_EMAIL);
  if (!workspaceId) return { kind: "new" } as const;
  const viewer = await requireAccess("/register");
  if (viewer.role !== "manager") return { kind: "member" } as const;
  const profile = await (await getD1()).prepare("SELECT id FROM company_profile WHERE id='workspace'").first();
  return { kind: "manager", displayName: viewer.displayName, memberId: viewer.memberId, registered: Boolean(profile) } as const;
}
