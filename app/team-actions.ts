"use server";
import { redirect } from "next/navigation";
import { getD1 } from "../db";
import { requireManager } from "../lib/ruli/access";
import type { ActionState } from "../lib/ruli/action-state";

async function registerTeamMember(form: FormData): Promise<ActionState> {
  await requireManager("/team");
  const email=String(form.get("email")||"").trim().toLowerCase();
  const name=String(form.get("name")||"").trim();
  const role=String(form.get("role")||"executor");
  let memberId=String(form.get("memberId")||"").trim();
  const fail=(message:string):ActionState=>({error:message,values:Object.fromEntries(["name","email","role","memberId"].map(key=>[key,String(form.get(key)??"")]))});
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254) return fail("Введите корректную почту участника");
  if (!name || name.length>120) return fail("Укажите имя до 120 символов");
  if (!["executor","viewer"].includes(role)) return fail("Выберите роль участника");
  const db=getD1();
  if (await db.prepare("SELECT email FROM team_accounts WHERE email=?").bind(email).first()) return fail("Эта почта уже добавлена");
  const statements:D1PreparedStatement[]=[];
  if (memberId) {
    const member=await db.prepare("SELECT id FROM members WHERE id=? AND type='human' AND id<>'me'").bind(memberId).first();
    if (!member) return fail("Выберите исполнителя-человека");
    if (await db.prepare("SELECT email FROM team_accounts WHERE member_id=?").bind(memberId).first()) return fail("Исполнитель уже связан с аккаунтом");
  } else {
    memberId=`member-${crypto.randomUUID()}`;
    const initials=name.split(/\s+/).slice(0,2).map(p=>p[0].toUpperCase()).join("");
    statements.push(db.prepare("INSERT INTO members (id,name,short_name,role,initials,color,type) VALUES (?,?,?,?,?,'rose','human')")
      .bind(memberId,name,name.split(/\s+/)[0],role==="viewer"?"Наблюдатель":"Исполнитель",initials));
  }
  statements.push(db.prepare("INSERT INTO team_accounts (email,member_id,role) VALUES (?,?,?)").bind(email,memberId,role));
  try { await db.batch(statements); }
  catch { return fail("Участник уже изменён в другой вкладке. Обновите страницу."); }
  return {notice:"Сотрудник зарегистрирован. Разрешите ему доступ к сайту в Sites и передайте ссылку для входа."};
}

export async function addTeamMemberState(_previous:ActionState,form:FormData):Promise<ActionState> {
  const state=await registerTeamMember(form);
  if(state.error)return state;
  redirect(`/team?flash=${encodeURIComponent(state.notice!)}#register-employee`);
}

export async function addTeamMember(form:FormData):Promise<void> {
  const state=await registerTeamMember(form);
  redirect(`/team?${state.error?"error":"flash"}=${encodeURIComponent(state.error||state.notice!)}#register-employee`);
}

/** Correct a registration typo only before the first verified sign-in. */
export async function updatePendingEmailState(_previous:ActionState,form:FormData):Promise<ActionState> {
  await requireManager("/team");
  const email=String(form.get("email")??"").trim().toLowerCase();
  const expectedEmail=String(form.get("expectedEmail")??"").trim().toLowerCase();
  const memberId=String(form.get("memberId")??"").trim();
  const fail=(error:string):ActionState=>({error,values:Object.fromEntries(["email","expectedEmail","memberId"].map(key=>[key,String(form.get(key)??"")]))});
  const validEmail=(value:string)=>value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if(!validEmail(email))return fail("Введите корректную почту сотрудника.");
  if(!validEmail(expectedEmail)||!memberId||memberId.length>150)return fail("Обновите список зарегистрированных аккаунтов.");
  const db=getD1();
  let changed=0;
  try {
    const result=await db.prepare(`UPDATE OR IGNORE team_accounts SET email=?
      WHERE member_id=? AND email=? AND user_id IS NULL AND role IN ('executor','viewer')
      AND EXISTS (SELECT 1 FROM members WHERE id=team_accounts.member_id AND type='human' AND id<>'me')`)
      .bind(email,memberId,expectedEmail).run();
    changed=result.meta.changes;
  } catch {return fail("Не удалось сохранить почту. Введённый адрес сохранён; повторите попытку.");}
  if(!changed)return fail("Почта уже занята или регистрация изменилась. Исправление доступно только до первого входа сотрудника. Обновите список аккаунтов.");
  redirect(`/team?flash=${encodeURIComponent("Почта исправлена. Задачи и переписка сотрудника сохранены. Проверьте его доступ к сайту в Sites и передайте ссылку для входа.")}#register-employee`);
}
