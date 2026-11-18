"use server";
import { redirect } from "next/navigation";
import { getD1 } from "../db";
import { requireManager } from "../lib/ruli/access";
import type { ActionState } from "../lib/ruli/action-state";
import { runMutation } from "../lib/ruli/mutations";

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
  const db=await getD1();
  if (await db.prepare("SELECT email FROM team_accounts WHERE email=?").bind(email).first()) return fail("Эта почта уже добавлена");
  const statements:D1PreparedStatement[]=[];
  if (memberId) {
    const member=await db.prepare("SELECT id FROM members WHERE id=? AND type='human' AND removed_at IS NULL AND id<>'me'").bind(memberId).first();
    if (!member) return fail("Выберите исполнителя-человека");
    if (await db.prepare("SELECT email FROM team_accounts WHERE member_id=?").bind(memberId).first()) return fail("Исполнитель уже связан с аккаунтом");
  } else {
    memberId=`member-${crypto.randomUUID()}`;
    const initials=name.split(/\s+/).slice(0,2).map(p=>p[0].toUpperCase()).join("");
    statements.push(db.prepare("INSERT INTO members (id,name,short_name,role,initials,color,type) VALUES (?,?,?,?,?,'rose','human')")
      .bind(memberId,name,name.split(/\s+/)[0],role==="viewer"?"Наблюдатель":"Исполнитель",initials));
  }
  statements.push(db.prepare(`INSERT INTO team_accounts (email,member_id,role)
    SELECT ?,id,? FROM members WHERE id=? AND type='human' AND removed_at IS NULL AND id<>'me'`).bind(email,role,memberId));
  try {
    const results=await db.batch(statements);
    if(!results.at(-1)?.meta.changes)return fail("Состав команды изменился. Обновите страницу.");
  }
  catch { return fail("Участник уже изменён в другой вкладке. Обновите страницу."); }
  return {notice:"Сотрудник зарегистрирован. Передайте ему ссылку по инструкции «Вход после добавления по почте»."};
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
  const db=await getD1();
  let changed=0;
  try {
    const result=await db.prepare(`UPDATE OR IGNORE team_accounts SET email=?
      WHERE member_id=? AND email=? AND user_id IS NULL AND role IN ('executor','viewer')
      AND EXISTS (SELECT 1 FROM members WHERE id=team_accounts.member_id AND type='human' AND removed_at IS NULL AND id<>'me')`)
      .bind(email,memberId,expectedEmail).run();
    changed=result.meta.changes;
  } catch {return fail("Не удалось сохранить почту. Введённый адрес сохранён; повторите попытку.");}
  if(!changed)return fail("Почта уже занята или регистрация изменилась. Исправление доступно только до первого входа сотрудника. Обновите список аккаунтов.");
  redirect(`/team?flash=${encodeURIComponent("Почта исправлена. Задачи и переписка сохранены. Передайте сотруднику ссылку по инструкции «Вход после добавления по почте».")}#register-employee`);
}

export async function removeTeamMemberState(_previous: ActionState, form: FormData): Promise<ActionState> {
  const viewer = await requireManager("/team");
  const memberId = String(form.get("memberId") ?? "").trim();
  if (form.get("confirmed") !== "yes") return { error: "Подтвердите удаление сотрудника из команды." };
  if (!memberId || memberId.length > 150 || memberId === "me" || memberId === viewer.memberId) {
    return { error: "Выберите сотрудника из списка команды." };
  }

  const db = await getD1();
  const now = new Date().toISOString();
  const scheduleAffected = "s.member_id=? OR s.task_id IN (SELECT id FROM tasks WHERE owner_id=?)";
  try {
    const root = await db.prepare("SELECT version FROM tasks WHERE id='root'").first<{version: number}>();
    if (!root) return { error: "Не удалось загрузить команду. Обновите страницу." };
    const changed = await runMutation(db, {
      id: "root", version: root.version, touchAncestors: false,
      guard: {
        sql: `EXISTS (SELECT 1 FROM members m WHERE m.id=? AND m.type='human' AND m.removed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM team_accounts a WHERE a.member_id=m.id AND a.role='manager'))`,
        params: [memberId],
      },
      statements: (gate, token) => [{
        sql: `UPDATE schedule_plans SET version=version+1,last_mutation_id=?
          WHERE task_id IN (SELECT s.plan_task_id FROM schedule_entries s WHERE ${scheduleAffected}) AND ${gate.sql}`,
        params: [token, memberId, memberId, ...gate.params],
      }, {
        sql: `UPDATE schedule_entries AS s
          SET member_id=COALESCE((SELECT NULLIF(t.owner_id,?) FROM tasks t WHERE t.id=s.task_id),'me'),version=version+1
          WHERE (${scheduleAffected}) AND ${gate.sql}`,
        params: [memberId, memberId, memberId, ...gate.params],
      }, {
        // A task owner already participates implicitly.
        sql: `DELETE FROM task_participants WHERE member_id='me'
          AND task_id IN (SELECT id FROM tasks WHERE owner_id=?) AND ${gate.sql}`,
        params: [memberId, ...gate.params],
      }, {
        // Undo/restore and open forms also depend on versions of groups and trashed tasks.
        sql: `WITH RECURSIVE affected(id,parent_id) AS (
          SELECT id,parent_id FROM tasks WHERE owner_id=? OR id IN (SELECT task_id FROM task_participants WHERE member_id=?)
          UNION SELECT p.id,p.parent_id FROM tasks p JOIN affected child ON child.parent_id=p.id
        ) UPDATE tasks SET owner_id=CASE WHEN owner_id=? THEN 'me' ELSE owner_id END,
          version=version+1,updated_at=?,last_mutation_id=?
          WHERE id<>'root' AND id IN (SELECT id FROM affected) AND ${gate.sql}`,
        params: [memberId, memberId, memberId, now, token, ...gate.params],
      }, {
        sql: `DELETE FROM task_participants WHERE member_id=? AND ${gate.sql}`,
        params: [memberId, ...gate.params],
      }, {
        sql: `INSERT INTO removed_team_accounts (member_id,email,user_id)
          SELECT member_id,email,user_id FROM team_accounts WHERE member_id=? AND ${gate.sql}`,
        params: [memberId, ...gate.params],
      }, {
        sql: `DELETE FROM team_accounts WHERE member_id=? AND ${gate.sql}`,
        params: [memberId, ...gate.params],
      }, {
        sql: `UPDATE members SET removed_at=? WHERE id=? AND ${gate.sql}`,
        params: [now, memberId, ...gate.params],
      }],
    });
    if (!changed) return { error: "Обновите список команды. Удалить можно только действующего сотрудника без прав руководителя." };
  } catch {
    return { error: "Не удалось удалить сотрудника. Попробуйте ещё раз." };
  }
  redirect(`/team?result=removed&flash=${encodeURIComponent("Сотрудник удалён из команды. Доступ к Рули закрыт, его задачи переданы руководителю.")}#team-people`);
}
