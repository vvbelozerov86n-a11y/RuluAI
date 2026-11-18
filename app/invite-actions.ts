"use server";

import { redirect } from "next/navigation";
import { getD1, getSystemD1 } from "../db";
import { workspaceDatabase } from "../db/workspace-storage";
import { env } from "cloudflare:workers";
import { requireManager } from "../lib/ruli/access";
import type { ActionState } from "../lib/ruli/action-state";
import { createInviteToken, getCompanyInvitation, getExistingInviteMember, isInviteToken } from "../lib/ruli/company-invites";
import { requireChatGPTUser } from "./chatgpt-auth";

const invalidInvite = "Эта ссылка-приглашение недействительна. Попросите руководителя прислать актуальную ссылку.";
const foreignAccount = "Аккаунт уже связан с другой компанией. Для вступления используйте другой аккаунт ChatGPT.";
const hasCurrentInvite = "EXISTS (SELECT 1 FROM company_profile WHERE id='workspace' AND invite_token=?)";

export async function acceptCompanyInviteState(_previous: ActionState, form: FormData): Promise<ActionState> {
  const token = form.get("token");
  if (typeof token !== "string" || !isInviteToken(token)) return {error: invalidInvite};
  const user = await requireChatGPTUser(`/join/${token}`);
  const email = user.email.trim().toLowerCase();
  const submitted = form.get("name");
  const name = typeof submitted === "string" ? submitted.trim() : "";
  const values = {name};
  if (!name || name.length > 120) {
    const error = "Укажите имя длиной от 1 до 120 символов.";
    return {error, fieldErrors:{name:error}, values};
  }
  if (!user.userId || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {error:"Не удалось подтвердить почту. Повторите вход через ChatGPT.", values};
  }

  const memberId = `member-${crypto.randomUUID()}`;
  const words = name.split(/\s+/);
  const initials = words.slice(0, 2).map(word => Array.from(word)[0].toUpperCase()).join("");
  try {
    const company = await getCompanyInvitation(token);
    if (!company) return {error:invalidInvite, values};
    const existingMember = await getExistingInviteMember(user, company.workspaceId);
    if (existingMember?.foreign) return {error:foreignAccount, values};
    const db = workspaceDatabase(getSystemD1(), company.workspaceId);
    // Recheck the invitation in the writes, including when a stale form was left open.
    const result = await db.batch([
      db.prepare(`UPDATE team_accounts SET user_id=?
        WHERE email=? AND user_id IS NULL AND role IN ('executor','viewer') AND member_id<>'me'
          AND EXISTS (SELECT 1 FROM members WHERE id=team_accounts.member_id AND type='human' AND removed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM team_accounts WHERE user_id=?) AND ${hasCurrentInvite}`)
        .bind(user.userId, email, user.userId, token),
      db.prepare(`INSERT INTO members (id,name,short_name,role,initials,color,type)
        SELECT ?,?,?,'Исполнитель',?,'rose','human' WHERE ${hasCurrentInvite} AND ?<>?
          AND NOT EXISTS (SELECT 1 FROM team_accounts WHERE email=? OR user_id=?)
          AND NOT EXISTS (SELECT 1 FROM removed_team_accounts WHERE email=? OR user_id=?)`)
        .bind(memberId, name, words[0], initials, token, email, env.RULI_OWNER_EMAIL?.trim().toLowerCase() || "",
          email, user.userId, email, user.userId),
      db.prepare(`INSERT INTO team_accounts (email,user_id,member_id,role)
        SELECT ?,?,id,'executor' FROM members WHERE id=?`).bind(email, user.userId, memberId),
    ]);
    // A previous submission or an already registered user can reuse a current link.
    if (!result[0].meta.changes && !result[2].meta.changes) {
      if (!await getCompanyInvitation(token)) return {error:invalidInvite, values};
      const existing = await getExistingInviteMember(user, company.workspaceId);
      if (!existing?.bound) return {error:"Не удалось присоединить этот аккаунт. Обратитесь к руководителю команды.", values};
    }
  } catch {
    return {error:"Не удалось завершить регистрацию. Повторите попытку.", values};
  }
  redirect("/");
}

export async function rotateCompanyInviteState(_previous: ActionState, form: FormData): Promise<ActionState> {
  await requireManager("/team");
  const expected = form.get("expectedToken");
  const stale = "Ссылка уже изменилась. Обновите страницу команды и скопируйте актуальную ссылку.";
  if (typeof expected !== "string" || !isInviteToken(expected)) return {error:stale};
  try {
    const result = await (await getD1()).prepare("UPDATE company_profile SET invite_token=? WHERE id='workspace' AND invite_token=?")
      .bind(createInviteToken(), expected).run();
    if (!result.meta.changes) return {error:stale};
  } catch {
    return {error:"Не удалось заменить ссылку. Повторите попытку."};
  }
  redirect(`/team?result=invite&flash=${encodeURIComponent("Ссылка обновлена. Предыдущая ссылка больше не действует.")}#company-invite`);
}
