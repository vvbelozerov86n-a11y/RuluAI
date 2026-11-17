"use server";
import { redirect } from "next/navigation";
import { getD1 } from "../db";
import { requireAccess, canManage, canWriteChannel } from "../lib/ruli/access";
import { loadTree, getMembers } from "../lib/ruli/data";
import { findPath, isISODate } from "../lib/ruli/model";
import { taskChannelMembers, scheduleSelect, workloadSelect, type ScheduleRow, type ScheduleWorkloadRow } from "../lib/ruli/collaboration";
import { generateSchedule, scheduleCapacityOnDate, validateScheduleOptions, validateScheduleRange } from "../lib/ruli/scheduling";
import type { ActionState } from "../lib/ruli/action-state";
import { validateAiReply, requestAiReply, aiErrorMessage } from "../lib/ruli/ai";

function value(form:FormData,key:string) { return String(form.get(key)??"").trim(); }
function destination(id:string,channel:string|null=null):string {
  const base=id==="root"?"/":`/t/${encodeURIComponent(id)}`;
  return `${base}?chat=${encodeURIComponent(channel||"general")}`;
}
function finish(id:string,message:string,error=false,channel:string|null=null):never {
  redirect(`${destination(id,channel)}&${error?"error":"flash"}=${encodeURIComponent(message)}#collaboration`);
}
function failure(form:FormData,message:string):ActionState {
  return {error:message,values:Object.fromEntries([...form.entries()].filter((e):e is [string,string]=>typeof e[1]==="string"))};
}
async function postMessage(form:FormData):Promise<ActionState|undefined> {
  const viewer=await requireAccess();
  const taskId=value(form,"taskId");
  const channel=value(form,"channelMemberId")||null;
  const body=value(form,"body");
  const clientId=value(form,"clientId");
  const node=findPath(taskId,await loadTree())?.at(-1);
  if (!node) return failure(form,"Задача удалена или недоступна.");
  const allowed=taskChannelMembers(node,await getMembers(),viewer);
  if (!canWriteChannel(viewer,channel) || (channel && !allowed.some(m=>m.id===channel))) return failure(form,"У вас нет доступа к этому диалогу.");
  if (!body || body.length>5000) return failure(form,"Сообщение должно содержать от 1 до 5000 символов. Текст сохранён в форме.");
  if (!/^[a-zA-Z0-9_-]{8,120}$/.test(clientId)) return failure(form,"Обновите страницу перед отправкой сообщения.");
  const db=getD1();
  const previous=await db.prepare("SELECT task_id,channel_member_id,body FROM task_messages WHERE author_user_id=? AND client_id=?")
    .bind(viewer.userId,clientId).first<{task_id:string;channel_member_id:string|null;body:string}>();
  if (previous) {
    return previous.task_id===taskId && previous.channel_member_id===channel && previous.body===body ? undefined : failure(form,"Это сообщение уже было отправлено. Обновите диалог для нового сообщения.");
  }
  const result=await db.prepare(`INSERT INTO task_messages
    (id,task_id,channel_member_id,author_id,author_user_id,author_name,body,client_id,created_at)
    SELECT ?,id,?,?,?,?,?,?,? FROM tasks WHERE id=? AND deleted_at IS NULL
    ON CONFLICT(author_user_id,client_id) DO NOTHING`).bind(
      crypto.randomUUID(),channel,viewer.memberId,viewer.userId,viewer.displayName,body,clientId,new Date().toISOString(),taskId).run();
  if (!result.meta.changes) {
    const retry=await db.prepare("SELECT id FROM task_messages WHERE author_user_id=? AND client_id=? AND task_id=? AND channel_member_id IS ? AND body=?")
      .bind(viewer.userId,clientId,taskId,channel,body).first();
    if (!retry) return failure(form,"Задача изменилась. Обновите страницу; текст сохранён в форме.");
  }
}
export async function sendMessageState(_previous:ActionState,form:FormData):Promise<ActionState> {
  // The private bot is resolved on the server: removing a hidden field cannot
  // turn its channel into a human-only conversation or target another bot.
  const channel=value(form,"channelMemberId")||null;
  const members=await getMembers();
  const channelBot=channel ? members.find(member=>member.id===channel&&member.type==="bot") : undefined;
  const botMemberId=channelBot?.id||value(form,"botMemberId");
  const aiInput={taskId:value(form,"taskId"),channelMemberId:channel,botMemberId,clientId:value(form,"clientId")};
  if(botMemberId) {
    try { await validateAiReply(aiInput); }
    catch(error) { return failure(form,aiErrorMessage(error)); }
  }
  const error=await postMessage(form);
  if (error) return error;
  const acknowledged:ActionState={sentClientId:value(form,"clientId")};
  if(!botMemberId)return acknowledged;
  try {
    const run=await requestAiReply(aiInput);
    return {...acknowledged,aiRunId:run.id,aiStatus:run.status,notice:run.error||
      (run.status==="pending"?"AI уже готовит ответ.":run.status==="stale"?"Задача изменилась. Ответ сохранён в истории запусков.":"AI ответил в чате.")};
  } catch(error) {
    // The human message is already durable. A provider failure must not keep
    // its draft around and cause a duplicate message on the next submission.
    return {...acknowledged,aiStatus:"failed",notice:aiErrorMessage(error)};
  }
}
export async function sendMessage(form:FormData):Promise<void> {
  const state=await sendMessageState({},form);
  finish(value(form,"taskId"),state.error||state.notice||"Сообщение отправлено",Boolean(state.error)||state.aiStatus==="failed",value(form,"channelMemberId")||null);
}

export async function generateTaskSchedule(form:FormData):Promise<void> {
  const viewer=await requireAccess();
  const id=value(form,"taskId");
  if (!canManage(viewer)) finish(id,"График формирует руководитель",true);
  const tree=await loadTree();
  const node=findPath(id,tree)?.at(-1);
  if (!node) finish("root","Задача не найдена",true);
  const version=Number(value(form,"version"));
  if (!Number.isSafeInteger(version)||version<0) finish(id,"Обновите график перед изменением",true);
  const options={startDate:value(form,"startDate"),hoursPerDay:Number(value(form,"hoursPerDay")),estimatedHoursPerTask:Number(value(form,"estimatedHoursPerTask")),weekdaysOnly:form.get("weekdaysOnly")!==null};
  const invalid=validateScheduleOptions(options);
  if (invalid) finish(id,invalid,true);
  const db=getD1();
  const existing=await db.prepare(`${workloadSelect} AND s.plan_task_id<>?`).bind(id).all<ScheduleWorkloadRow>();
  const current=await db.prepare("SELECT id FROM schedule_entries WHERE plan_task_id=? LIMIT 1").bind(id).first();
  if (current && !form.has("replaceConfirmed")) finish(id,"Подтвердите замену текущего графика и ручных правок.",true);
  let plan:ReturnType<typeof generateSchedule>;
  try { plan=generateSchedule(node,options,existing.results); }
  catch (error) { finish(id,error instanceof Error?error.message:"Не удалось рассчитать график",true); }
  if (!plan.entries.length) finish(id,plan.warnings[0]||"Нет незавершённых поручений для планирования",true);
  const plannedTasks=new Set(plan.entries.map(entry=>entry.taskId));
  const overlap=existing.results.find(entry=>plannedTasks.has(entry.taskId));
  if (overlap) {
    const otherTitle=findPath(overlap.planTaskId,tree)?.at(-1)?.title||"другой задачи";
    finish(id,`Часть поручений уже запланирована в «${otherTitle}». Сначала удалите тот график, чтобы не планировать одну работу дважды.`,true);
  }
  // Root version serializes writes across plans: two generators cannot reserve the same capacity.
  const token=crypto.randomUUID();
  const guard="EXISTS (SELECT 1 FROM tasks WHERE id='root' AND last_mutation_id=?)";
  const batch=[
    db.prepare("INSERT INTO schedule_plans (task_id,version) VALUES (?,0) ON CONFLICT(task_id) DO NOTHING").bind(id),
    db.prepare(`UPDATE tasks SET version=version+1,last_mutation_id=? WHERE id='root' AND version=? AND
      EXISTS (SELECT 1 FROM schedule_plans WHERE task_id=? AND version=?) AND
      EXISTS (SELECT 1 FROM tasks WHERE id=? AND deleted_at IS NULL AND version=?)`).bind(token,tree.version,id,version,id,node.version),
    db.prepare(`UPDATE schedule_plans SET version=version+1,last_mutation_id=?,hours_per_day=?,weekdays_only=? WHERE task_id=? AND ${guard}`)
      .bind(token,options.hoursPerDay,options.weekdaysOnly?1:0,id,token),
    db.prepare(`DELETE FROM schedule_entries WHERE plan_task_id=? AND ${guard}`).bind(id,token),
    ...plan.entries.map(entry=>db.prepare(`INSERT INTO schedule_entries (id,plan_task_id,task_id,member_id,title,start_date,end_date,hours)
      SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`).bind(crypto.randomUUID(),id,entry.taskId,entry.memberId,entry.title,entry.startDate,entry.endDate,entry.hours,token)),
  ];
  const result=await db.batch(batch);
  if (!result[1].meta.changes) finish(id,"Задачи или график изменились в другой вкладке. Обновите страницу и повторите расчёт.",true);
  const summary=plan.warnings.length ? `График сохранён. ${plan.warnings.slice(0,3).join(" ")}${plan.warnings.length>3?` Ещё предупреждений: ${plan.warnings.length-3}.`:""}` : "График сформирован с учётом загрузки исполнителей";
  finish(id,summary);
}

export async function updateScheduleEntry(form:FormData):Promise<void> {
  const viewer=await requireAccess();
  const taskId=value(form,"taskId");
  if (!canManage(viewer)) finish(taskId,"Изменять график может руководитель",true);
  const tree=await loadTree();
  if (!findPath(taskId,tree)) finish("root","Задача не найдена",true);
  const id=value(form,"id"), start=value(form,"startDate"), end=value(form,"endDate"), hours=Number(value(form,"hours"));
  const version=Number(value(form,"version")), planVersion=Number(value(form,"planVersion"));
  if (![version,planVersion].every(n=>Number.isSafeInteger(n)&&n>=1)) finish(taskId,"Обновите график перед изменением",true);
  const db=getD1();
  const settings=await db.prepare("SELECT hours_per_day AS hoursPerDay,weekdays_only AS weekdaysOnly FROM schedule_plans WHERE task_id=?")
    .bind(taskId).first<{hoursPerDay:number;weekdaysOnly:number}>();
  if (!settings) finish(taskId,"Сначала сформируйте график",true);
  const invalid=validateScheduleRange(start,end,hours,settings.hoursPerDay);
  if (invalid) finish(taskId,invalid,true);
  const entry=await db.prepare(`${scheduleSelect} AND s.id=? AND s.plan_task_id=?`).bind(id,taskId).first<ScheduleRow>();
  if (!entry) finish(taskId,"Этап уже изменён или удалён",true);
  const path=findPath(entry.taskId,tree);
  const active=path?.at(-1)?.kind==="leaf" && path.at(-1)?.status!=="done";
  const all=active ? await db.prepare(`${workloadSelect} AND s.member_id=? AND s.id<>?`).bind(entry.memberId,id).all<ScheduleWorkloadRow>() : {results:[] as ScheduleWorkloadRow[]};
  const dayMs=86400000, count=(Date.parse(end)-Date.parse(start))/dayMs+1;
  for (let d=Date.parse(start);d<=Date.parse(end);d+=dayMs) {
    const date=new Date(d), iso=date.toISOString().slice(0,10);
    if (settings.weekdaysOnly && [0,6].includes(date.getUTCDay())) finish(taskId,"В этом графике выходные исключены. Выберите рабочий день или пересоздайте график.",true);
    const capacity=scheduleCapacityOnDate(all.results,entry.memberId,iso,settings.hoursPerDay);
    if (active && capacity.hours+hours/count>capacity.limit+1e-7) finish(taskId,`На ${iso} превышена дневная загрузка исполнителя (${capacity.limit} ч).`,true);
  }
  const token=crypto.randomUUID();
  const guard="EXISTS (SELECT 1 FROM tasks WHERE id='root' AND last_mutation_id=?)";
  const result=await db.batch([
    db.prepare(`UPDATE tasks SET version=version+1,last_mutation_id=? WHERE id='root' AND version=? AND
      EXISTS (SELECT 1 FROM schedule_entries WHERE id=? AND plan_task_id=? AND version=?) AND
      EXISTS (SELECT 1 FROM schedule_plans WHERE task_id=? AND version=?)`).bind(token,tree.version,id,taskId,version,taskId,planVersion),
    db.prepare(`UPDATE schedule_entries SET start_date=?,end_date=?,hours=?,version=version+1 WHERE id=? AND ${guard}`).bind(start,end,hours,id,token),
    db.prepare(`UPDATE schedule_plans SET version=version+1,last_mutation_id=? WHERE task_id=? AND ${guard}`).bind(token,taskId,token),
  ]);
  if (!result[0].meta.changes) finish(taskId,"График изменён в другой вкладке. Обновите страницу.",true);
  const deadlines=(path??[]).filter(task=>task.dueDate && isISODate(task.dueDate) && end>task.dueDate);
  const warning=deadlines.map(task=>`«${task.title}»: срок ${task.dueDate}, окончание этапа ${end}.`).join(" ");
  finish(taskId,`Этап графика обновлён.${warning?` Предупреждение: нарушены сроки. ${warning}`:""}`);
}

export async function clearTaskSchedule(form:FormData):Promise<void> {
  const viewer=await requireAccess();
  const taskId=value(form,"taskId");
  if (!canManage(viewer)) finish(taskId,"Удалять график может руководитель",true);
  if (value(form,"confirmClear")!=="yes") finish(taskId,"Подтвердите удаление графика и ручных правок.",true);
  const tree=await loadTree();
  if (!findPath(taskId,tree)) finish("root","Задача не найдена",true);
  const version=Number(value(form,"version"));
  if (!Number.isSafeInteger(version)||version<1) finish(taskId,"Обновите график перед удалением",true);
  const token=crypto.randomUUID(),db=getD1();
  const guard="EXISTS (SELECT 1 FROM tasks WHERE id='root' AND last_mutation_id=?)";
  const result=await db.batch([
    db.prepare(`UPDATE tasks SET version=version+1,last_mutation_id=? WHERE id='root' AND version=? AND
      EXISTS (SELECT 1 FROM schedule_plans WHERE task_id=? AND version=?)`).bind(token,tree.version,taskId,version),
    db.prepare(`DELETE FROM schedule_entries WHERE plan_task_id=? AND ${guard}`).bind(taskId,token),
    db.prepare(`UPDATE schedule_plans SET version=version+1,last_mutation_id=? WHERE task_id=? AND ${guard}`).bind(token,taskId,token),
  ]);
  if (!result[0].meta.changes) finish(taskId,"График изменён в другой вкладке. Обновите страницу.",true);
  finish(taskId,"График удалён. Задачи и переписка сохранены.");
}
