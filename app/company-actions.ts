"use server";

import { redirect } from "next/navigation";
import { getD1, getSystemD1 } from "../db";
import { workspaceDatabase, workspaceSchemaStatements } from "../db/workspace-storage";
import type { ActionState } from "../lib/ruli/action-state";
import { createInviteToken } from "../lib/ruli/company-invites";
import { getCompanyRegistrationAccess } from "../lib/ruli/company-profile";
import { workspaceDirectoryTriggers } from "../lib/ruli/workspace-directory";
import { requireChatGPTUser } from "./chatgpt-auth";

export async function registerCompanyState(_previous: ActionState, form: FormData): Promise<ActionState> {
  const user = await requireChatGPTUser("/register");
  const access = await getCompanyRegistrationAccess();
  if (access.kind === "member") redirect("/access-denied");
  if (access.kind === "manager" && access.registered) redirect("/team#company-invite");
  const read = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" ? value : "";
  };
  const values = { companyName: read("companyName"), managerName: read("managerName") };
  const companyName = values.companyName.trim();
  const managerName = values.managerName.trim();
  const fieldErrors: Record<string, string> = {};
  if (!companyName || companyName.length > 120) fieldErrors.companyName = "Укажите название компании до 120 символов.";
  if (!managerName || managerName.length > 120) fieldErrors.managerName = "Укажите имя руководителя до 120 символов.";
  if (Object.keys(fieldErrors).length) return { error: "Проверьте данные регистрации.", fieldErrors, values };

  const token = createInviteToken();
  const words = managerName.split(/\s+/);
  const initials = words.slice(0, 2).map(word => Array.from(word)[0].toLocaleUpperCase("ru")).join("");
  const email = user.email.trim().toLowerCase();
  if (!user.userId || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Не удалось подтвердить почту руководителя. Повторите вход через ChatGPT.", values };
  }
  try {
    if (access.kind === "new") {
      const id = crypto.randomUUID().replaceAll("-", "");
      const raw = getSystemD1();
      const db = workspaceDatabase(raw, id);
      await raw.batch([
        raw.prepare("INSERT INTO workspaces(id) VALUES (?)").bind(id),
        ...await workspaceSchemaStatements(raw, id),
        ...workspaceDirectoryTriggers(raw, id),
        db.prepare(`INSERT INTO members(id,name,short_name,initials,role,type)
          VALUES ('me',?,?,?,'Руководитель','human')`).bind(managerName, words[0], initials),
        db.prepare("INSERT INTO tasks(id,kind,title,owner_id) VALUES ('root','group','Все задачи','me')"),
        db.prepare("INSERT INTO team_accounts(email,user_id,member_id,role) VALUES (?,?,'me','manager')")
          .bind(email, user.userId),
        db.prepare("INSERT INTO company_profile(id,name,invite_token) VALUES ('workspace',?,?)").bind(companyName, token),
      ]);
    } else {
      const db = await getD1();
      const [profile] = await db.batch([
        db.prepare(`INSERT INTO company_profile (id,name,invite_token)
          SELECT 'workspace',?,? FROM team_accounts a JOIN members m ON m.id=a.member_id
          WHERE a.member_id=? AND a.user_id=? AND a.role='manager' AND m.type='human' AND m.removed_at IS NULL
          ON CONFLICT(id) DO NOTHING`).bind(companyName, token, access.memberId, user.userId),
        // Only the winning registration may also rename its manager.
        db.prepare(`UPDATE members SET name=?,short_name=?,initials=? WHERE id=? AND EXISTS
          (SELECT 1 FROM company_profile WHERE id='workspace' AND invite_token=?)`)
          .bind(managerName, words[0], initials, access.memberId, token),
      ]);
      if (!profile.meta.changes && !await db.prepare("SELECT id FROM company_profile WHERE id='workspace'").first()) {
        return { error: "Не удалось подтвердить права руководителя. Обновите страницу.", values };
      }
    }
  } catch {
    return { error: "Не удалось зарегистрировать компанию. Проверьте, не привязан ли аккаунт к другой команде, и повторите попытку.", values };
  }
  redirect("/team#company-invite");
}
