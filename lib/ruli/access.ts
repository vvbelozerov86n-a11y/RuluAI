import { cache } from "react";
import { env } from "cloudflare:workers";
import { redirect } from "next/navigation";
import { requireChatGPTUser } from "../../app/chatgpt-auth";
import { getCurrentWorkspaceId, getD1 } from "../../db";
import { initRuli } from "./bootstrap";
import { canManage, type AccessContext } from "./policy";
export { canManage, canSubmit, canReadChannel, canWriteChannel } from "./policy";
export type { AccessContext } from "./policy";

type Account = {email:string;user_id:string|null;member_id:string;role:string;name:string};

export const requireAccess = cache(async (returnTo = "/"): Promise<AccessContext> => {
  const user = await requireChatGPTUser(returnTo);
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) redirect("/access-denied");
  await initRuli();
  const db = await getD1();
  const email = user.email.trim().toLowerCase();
  const ownerEmail = workspaceId === "legacy" ? env.RULI_OWNER_EMAIL?.trim().toLowerCase() : undefined;
  const accountSelect = "SELECT a.*,m.name FROM team_accounts a JOIN members m ON m.id=a.member_id AND m.removed_at IS NULL";
  // A verified user's existing stable binding takes precedence over an email
  // change. Updating the owner setting must never transfer another account.
  let account = await db.prepare(`${accountSelect} WHERE a.user_id=?`).bind(user.userId).first<Account>();
  if (account && account.member_id === "me" && account.role === "manager"
      && ownerEmail === email && account.email !== email) {
    // An occupied address is left untouched; the established owner still signs
    // in through userId. This avoids stealing or overwriting another account.
    try {
      await db.prepare(`UPDATE OR IGNORE team_accounts SET email=?
        WHERE user_id=? AND member_id='me' AND role='manager' AND email=?`)
        .bind(email,user.userId,account.email).run();
    } catch (error) {
      // A verified email change may conflict with a membership in another company.
      // The stable user still owns their original account.
      if (!(error instanceof Error) || !/conflict|already|constraint|occupied/i.test(error.message)) throw error;
    }
  }
  // Initial ownership is configured at deployment. Conflicts with an existing
  // member, email or identity never replace that binding or promote its role.
  if (!account && ownerEmail && email === ownerEmail) {
    await db.prepare("INSERT INTO team_accounts (email,user_id,member_id,role) VALUES (?,?, 'me','manager') ON CONFLICT DO NOTHING")
      .bind(email,user.userId).run();
  }
  account ??= await db.prepare(`${accountSelect} WHERE a.user_id=? OR (a.email=? AND a.user_id IS NULL)
    ORDER BY CASE WHEN a.user_id=? THEN 0 ELSE 1 END LIMIT 1`).bind(user.userId,email,user.userId).first<Account>();
  if (!account) redirect("/access-denied");
  if (!account.user_id) {
    await db.prepare("UPDATE team_accounts SET user_id=? WHERE email=? AND user_id IS NULL").bind(user.userId,email).run();
    account = await db.prepare(`${accountSelect} WHERE a.email=? AND a.user_id=?`)
      .bind(email,user.userId).first<Account>();
    if (!account) redirect("/access-denied");
  }
  if (!["manager","executor","viewer"].includes(account.role)) redirect("/access-denied");
  return {workspaceId,userId:user.userId,memberId:account.member_id,role:account.role as AccessContext["role"],displayName:account.name};
});

export async function requireManager(returnTo = "/"): Promise<AccessContext> {
  const viewer = await requireAccess(returnTo);
  if (!canManage(viewer)) redirect("/access-denied");
  return viewer;
}

export async function listAccessAccounts() {
  await requireManager("/team");
  const result=await (await getD1()).prepare(`SELECT a.member_id AS memberId,a.email,a.role,a.user_id AS userId,m.name
    FROM team_accounts a JOIN members m ON m.id=a.member_id WHERE m.removed_at IS NULL ORDER BY m.name`).all<{
      memberId:string;email:string;role:string;userId:string|null;name:string;
    }>();
  return result.results;
}
