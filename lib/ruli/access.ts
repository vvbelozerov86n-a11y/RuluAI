import { cache } from "react";
import { env } from "cloudflare:workers";
import { redirect } from "next/navigation";
import { requireChatGPTUser } from "../../app/chatgpt-auth";
import { getD1 } from "../../db";
import { initRuli } from "./bootstrap";
import { canManage, type AccessContext } from "./policy";
export { canManage, canSubmit, canReadChannel, canWriteChannel } from "./policy";
export type { AccessContext } from "./policy";

type Account = {email:string;user_id:string|null;member_id:string;role:string;name:string};

export const requireAccess = cache(async (returnTo = "/"): Promise<AccessContext> => {
  const user = await requireChatGPTUser(returnTo);
  await initRuli();
  const db = getD1();
  const email = user.email.trim().toLowerCase();
  const ownerEmail = env.RULI_OWNER_EMAIL?.trim().toLowerCase();
  // Owner identity is configured at deployment, never granted to the first visitor.
  if (ownerEmail && email === ownerEmail) {
    await db.prepare("INSERT INTO team_accounts (email,user_id,member_id,role) VALUES (?,?, 'me','manager') ON CONFLICT(email) DO NOTHING")
      .bind(email,user.userId).run();
  }
  let account = await db.prepare(`SELECT a.*,m.name FROM team_accounts a
    JOIN members m ON m.id=a.member_id WHERE a.user_id=? OR (a.email=? AND a.user_id IS NULL)
    ORDER BY CASE WHEN a.user_id=? THEN 0 ELSE 1 END LIMIT 1`).bind(user.userId,email,user.userId).first<Account>();
  if (!account) redirect("/access-denied");
  if (!account.user_id) {
    await db.prepare("UPDATE team_accounts SET user_id=? WHERE email=? AND user_id IS NULL").bind(user.userId,email).run();
    account = await db.prepare(`SELECT a.*,m.name FROM team_accounts a JOIN members m ON m.id=a.member_id WHERE a.email=? AND a.user_id=?`)
      .bind(email,user.userId).first<Account>();
    if (!account) redirect("/access-denied");
  }
  if (!["manager","executor","viewer"].includes(account.role)) redirect("/access-denied");
  return {userId:user.userId,memberId:account.member_id,role:account.role as AccessContext["role"],displayName:account.name};
});

export async function requireManager(returnTo = "/"): Promise<AccessContext> {
  const viewer = await requireAccess(returnTo);
  if (!canManage(viewer)) redirect("/access-denied");
  return viewer;
}

export async function listAccessAccounts() {
  await requireManager("/team");
  const result=await getD1().prepare(`SELECT a.member_id AS memberId,a.email,a.role,a.user_id AS userId,m.name
    FROM team_accounts a JOIN members m ON m.id=a.member_id ORDER BY m.name`).all<{
      memberId:string;email:string;role:string;userId:string|null;name:string;
    }>();
  return result.results;
}
