"use server";

import { redirect } from "next/navigation";
import { getD1 } from "../db";
import { getMembers, loadTree } from "../lib/ruli/data";
import { requireAccess } from "../lib/ruli/access";
import { canManage, canSubmit } from "../lib/ruli/policy";
import type { ActionState } from "../lib/ruli/action-state";
import { runMutation, type Statement } from "../lib/ruli/mutations";
import {
  countNodes, findPath, isBlockSize, isBlockTheme, isTaskPriority, isTaskStatus,
  MAX_DEPTH, MAX_NODES, ROOT_ID, validateDueDateInput, dueLabelFromISO,
  taskHref, type TaskNode, type TaskPriority,
} from "../lib/ruli/model";
import { notifyTaskChangeForAgents, retryAgentDelivery } from "../lib/ruli/agent-runtime";

const CONFLICT = "Задача изменилась в другой вкладке или у другого участника. Ваш текст сохранён в форме. Обновите данные перед повторной отправкой.";
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

class FormError extends Error {
  constructor(message: string, readonly fieldErrors?: Record<string, string>) { super(message); }
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function str(form: FormData, key: string): string { return text(form, key).trim(); }

function valuesOf(form: FormData): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(form.keys())) {
    if (key.startsWith("$ACTION")) continue;
    const values = form.getAll(key).filter((value): value is string => typeof value === "string");
    result[key] = key === "participants" ? values : values[0] ?? "";
  }
  return result;
}

function versionOf(form: FormData, key = "version"): number {
  const raw = str(form, key);
  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) throw new FormError("Обновите страницу: не удалось проверить версию задачи.");
  return value;
}

function taskId(form: FormData, key = "id"): string {
  const id = str(form, key);
  if (!ID_PATTERN.test(id)) throw new FormError("Задача не найдена.");
  return id;
}

function bounded(value: string, maximum: number, field: string, label: string): string {
  if (value.length > maximum) throw new FormError(`${label}: не более ${maximum} символов. Текст не был обрезан.`, { [field]: `Максимум ${maximum} символов; сейчас ${value.length}.` });
  return value;
}

async function access(form: FormData, manager = true) {
  const ctx = await requireAccess(taskHref(str(form, "id") || ROOT_ID));
  if (manager && !canManage(ctx)) throw new FormError("Это действие доступно только руководителю.");
  return ctx;
}

async function nodeFor(form: FormData) {
  const id = taskId(form);
  const tree = await loadTree();
  const path = findPath(id, tree);
  if (!path) throw new FormError("Задача удалена или не найдена. Обновите страницу.");
  const node = path.at(-1)!;
  const version = versionOf(form);
  if (node.version !== version) throw new FormError(CONFLICT);
  return { tree, path, node, version };
}

async function fields(form: FormData) {
  const title = bounded(text(form, "title"), 200, "title", "Название").trim();
  if (!title) throw new FormError("Введите название задачи.", { title: "Введите название." });
  const description = bounded(text(form, "description"), 2000, "description", "Описание");
  const due = validateDueDateInput(str(form, "due"));
  if (!due.valid) throw new FormError(due.error, { due: due.error });
  const ownerId = str(form, "owner");
  const memberIds = new Set((await getMembers()).map(member => member.id));
  if (!memberIds.has(ownerId)) throw new FormError("Выберите ответственного из команды.", { owner: "Участник не найден." });
  const participants = [...new Set(form.getAll("participants").filter((value): value is string => typeof value === "string" && value !== ownerId))];
  if (participants.some(id => !memberIds.has(id))) throw new FormError("Состав команды изменился. Проверьте участников.");
  const size = str(form, "size");
  const theme = str(form, "theme");
  if (!isBlockSize(size) || !isBlockTheme(theme)) throw new FormError("Выберите форму и цвет карточки задачи.");
  const priorityRaw = str(form, "priority");
  let priority: TaskPriority | null = null;
  if (priorityRaw) {
    if (!isTaskPriority(priorityRaw)) throw new FormError("Выберите приоритет: высокий, средний или низкий.", { priority: "Недопустимый приоритет." });
    priority = priorityRaw;
  }
  return { title, description, ownerId, participants, size, theme, priority, dueDate: due.date, dueLabel: due.date ? dueLabelFromISO(due.date) : "Без срока" };
}

function participantWrites(id: string, participants: string[], gate: Statement, replace: boolean): Statement[] {
  return [
    ...(replace ? [{ sql: `DELETE FROM task_participants WHERE task_id = ? AND ${gate.sql}`, params: [id, ...gate.params] }] : []),
    ...participants.map(memberId => ({
      sql: `INSERT INTO task_participants (task_id, member_id) SELECT ?, ? WHERE ${gate.sql}`,
      params: [id, memberId, ...gate.params],
    })),
  ];
}

type Success = { id: string; message: string; target?: string };
type Operation = (form: FormData) => Promise<Success>;

async function perform(form: FormData, operation: Operation): Promise<ActionState> {
  let outcome: Success;
  try {
    outcome = await operation(form);
  } catch (error) {
    // Authentication redirects are framework control flow, not form failures.
    if (error && typeof error === "object" && "digest" in error && String(error.digest).startsWith("NEXT_REDIRECT")) throw error;
    if (error instanceof FormError) return { error: error.message, fieldErrors: error.fieldErrors, values: valuesOf(form) };
    console.error("Ruli action failed", error instanceof Error ? error.name : "UnknownError");
    return { error: "Не удалось сохранить изменения. Введённые значения сохранены в форме; попробуйте ещё раз.", values: valuesOf(form) };
  }
  const params = new URLSearchParams({ flash: outcome.message });
  const mode = str(form, "mode");
  if (mode === "view" || mode === "build") params.set("mode", mode);
  redirect(`${outcome.target ?? taskHref(outcome.id)}?${params.toString()}`);
}

async function ordinary(form: FormData, operation: Operation, fallback?: string): Promise<void> {
  const state = await perform(form, operation);
  const id = ID_PATTERN.test(str(form, "id")) ? str(form, "id") : ROOT_ID;
  const params = new URLSearchParams({ error: state.error ?? "Не удалось выполнить действие." });
  const mode = str(form, "mode");
  if (mode === "view" || mode === "build") params.set("mode", mode);
  redirect(`${fallback ?? taskHref(id)}?${params.toString()}`);
}

async function ensureChanged(changed: boolean) { if (!changed) throw new FormError(CONFLICT); }

function rootVersionGuard(rootVersion: number, guard?: Statement): Statement {
  return {
    sql: `${guard ? `(${guard.sql}) AND ` : ""}EXISTS (SELECT 1 FROM tasks WHERE id='root' AND version=?)`,
    params: [...(guard?.params ?? []), rootVersion],
  };
}

const create: Operation = async form => {
  await access(form);
  const parentId = str(form, "parent") || ROOT_ID;
  const parentVersion = versionOf(form, "parentVersion");
  const tree = await loadTree();
  const path = findPath(parentId, tree);
  const parent = path?.at(-1);
  if (!path || !parent || parent.kind !== "group") throw new FormError("Добавлять подзадачи можно только внутрь группы.");
  if (parent.version !== parentVersion) throw new FormError(CONFLICT);
  if (path.length >= MAX_DEPTH) throw new FormError(`Можно создать до ${MAX_DEPTH} вложенных уровней.`);
  if (countNodes(tree) >= MAX_NODES) throw new FormError(`Можно создать до ${MAX_NODES} задач и групп.`);
  const f = await fields(form);
  const nested = form.get("nested") !== null;
  const id = `task-${crypto.randomUUID()}`;
  await ensureChanged(await runMutation(getD1(), {
    id: parentId, version: parentVersion,
    guard: { sql: "kind = 'group' AND (SELECT COUNT(*) FROM tasks WHERE deleted_at IS NULL) < ?", params: [MAX_NODES] },
    statements: gate => [{
      sql: `INSERT INTO tasks (id,parent_id,kind,title,owner_id,status,priority,due_label,due_date,description,result,size,theme,position)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE((SELECT MAX(position)+1 FROM tasks WHERE parent_id=? AND deleted_at IS NULL),0) WHERE ${gate.sql}`,
      params: [id,parentId,nested ? "group" : "leaf",f.title,f.ownerId,nested ? null : "todo",f.priority,f.dueLabel,f.dueDate,f.description,"",f.size,f.theme,parentId,...gate.params],
    }, ...participantWrites(id, f.participants, gate, false)],
  }));
  await notifyTaskChangeForAgents(getD1(), null, {
    id, title: f.title, description: f.description, status: nested ? null : "todo",
    priority: f.priority, due: f.dueDate, parentId, ownerId: f.ownerId, participants: f.participants,
  });
  return { id, message: nested ? "Группа задач создана — добавьте подзадачи." : "Задача создана." };
};

const update: Operation = async form => {
  await access(form);
  const { node, version, tree } = await nodeFor(form);
  if (node.id === ROOT_ID) throw new FormError("Общую группу задач нельзя изменить.");
  const f = await fields(form);
  const db = getD1();
  const reassign = node.ownerId !== f.ownerId;
  // Schedules are no longer managed in the UI. Preserve their rows and atomic
  // ownership transfer without letting historical capacity block task work.
  await ensureChanged(await runMutation(db, {
    id: node.id, version,
    guard: reassign ? rootVersionGuard(tree.version) : undefined,
    set: { sql: "title=?,owner_id=?,size=?,theme=?,priority=?,due_date=?,due_label=?,description=?", params: [f.title,f.ownerId,f.size,f.theme,f.priority,f.dueDate,f.dueLabel,f.description] },
    statements: (gate, token) => [
      ...participantWrites(node.id, f.participants, gate, true),
      ...(reassign ? [{
        sql: `UPDATE schedule_entries SET member_id=?,version=version+1 WHERE task_id=? AND ${gate.sql}`,
        params: [f.ownerId, node.id, ...gate.params],
      }, {
        sql: `UPDATE schedule_plans SET version=version+1,last_mutation_id=?
          WHERE task_id IN (SELECT plan_task_id FROM schedule_entries WHERE task_id=?) AND ${gate.sql}`,
        params: [token, node.id, ...gate.params],
      }] : []),
    ],
  }));
  await notifyTaskChangeForAgents(getD1(), {
    id: node.id, title: node.title, description: node.description, status: node.status,
    priority: node.priority ?? null, due: node.dueDate, parentId: node.parentId,
    ownerId: node.ownerId, participants: node.participants,
  }, {
    id: node.id, title: f.title, description: f.description, status: node.status,
    priority: f.priority, due: f.dueDate, parentId: node.parentId,
    ownerId: f.ownerId, participants: f.participants,
  });
  return { id: node.id, message: node.kind === "group" ? "Группа задач обновлена." : "Задача обновлена." };
};

export async function createTaskState(_previous: ActionState, form: FormData): Promise<ActionState> { return perform(form, create); }
export async function updateTaskState(_previous: ActionState, form: FormData): Promise<ActionState> { return perform(form, update); }
export async function createTask(form: FormData): Promise<void> { return ordinary(form, create); }
export async function updateTask(form: FormData): Promise<void> { return ordinary(form, update); }

export async function deleteTask(form: FormData): Promise<void> {
  return ordinary(form, async form => {
    await access(form);
    const { node, path, version } = await nodeFor(form);
    if (node.id === ROOT_ID) throw new FormError("Нельзя удалить все задачи.");
    const batchId = `delete-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await ensureChanged(await runMutation(getD1(), {
      id: node.id, version,
      set: { sql: "deleted_at=?,deletion_batch_id=?", params: [now,batchId] },
      statements: (gate, token) => [{
        sql: `WITH RECURSIVE subtree(id) AS (
          SELECT id FROM tasks WHERE parent_id=? AND deleted_at IS NULL
          UNION ALL SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id=s.id WHERE t.deleted_at IS NULL
        ) UPDATE tasks SET deleted_at=?,deletion_batch_id=?,version=version+1,updated_at=?,last_mutation_id=?
          WHERE id IN (SELECT id FROM subtree) AND ${gate.sql}`,
        params: [node.id,now,batchId,now,token,...gate.params],
      }],
    }));
    return { id: path.at(-2)!.id, message: node.kind === "group"
      ? "Группа и её задачи перемещены в корзину. Их можно восстановить."
      : "Задача перемещена в корзину. Её можно восстановить." };
  });
}

export async function listDeletedTasks(): Promise<Array<{ id: string; title: string; deletedAt: string; deletionBatchId: string; version: number; parentId: string | null }>> {
  const ctx = await requireAccess("/trash");
  if (!canManage(ctx)) return [];
  const result = await getD1().prepare(`SELECT t.id,t.title,t.deleted_at AS deletedAt,t.deletion_batch_id AS deletionBatchId,t.version,t.parent_id AS parentId
    FROM tasks t WHERE t.deleted_at IS NOT NULL AND t.deletion_batch_id LIKE 'delete-%'
    AND NOT EXISTS (SELECT 1 FROM tasks p WHERE p.id=t.parent_id AND p.deletion_batch_id=t.deletion_batch_id)
    ORDER BY t.deleted_at DESC`).all<{ id: string; title: string; deletedAt: string; deletionBatchId: string; version: number; parentId: string | null }>();
  return result.results;
}

export async function restoreTask(form: FormData): Promise<void> {
  return ordinary(form, async form => {
    await access(form);
    const id = taskId(form);
    const version = versionOf(form);
    const batchId = str(form, "batchId") || str(form, "deletionBatchId");
    if (!/^delete-[a-zA-Z0-9-]+$/.test(batchId)) throw new FormError("Выберите удалённую задачу или группу в корзине.");
    const db = getD1();
    const deleted = await db.prepare("SELECT parent_id AS parentId FROM tasks WHERE id=? AND version=? AND deleted_at IS NOT NULL AND deletion_batch_id=?").bind(id,version,batchId).first<{ parentId: string }>();
    if (!deleted) throw new FormError(CONFLICT);
    const tree = await loadTree();
    const parentPath = findPath(deleted.parentId, tree);
    if (!parentPath || parentPath.at(-1)!.kind !== "group") throw new FormError("Сначала восстановите родительскую группу. Восстановление внутрь удалённой группы невозможно.");
    const depth = await db.prepare(`WITH RECURSIVE branch(id,depth) AS (
      SELECT id,1 FROM tasks WHERE id=? AND deletion_batch_id=?
      UNION ALL SELECT t.id,b.depth+1 FROM tasks t JOIN branch b ON t.parent_id=b.id WHERE t.deletion_batch_id=?
    ) SELECT MAX(depth) AS depth FROM branch`).bind(id,batchId,batchId).first<{ depth: number }>();
    if (parentPath.length + Number(depth?.depth ?? 1) > MAX_DEPTH) throw new FormError(`Восстановление превысит ${MAX_DEPTH} уровней.`);
    const restored = await runMutation(db, {
      id,version,deleted:true,
      guard: rootVersionGuard(tree.version, { sql: `deletion_batch_id=? AND EXISTS (SELECT 1 FROM tasks p WHERE p.id=? AND p.kind='group' AND p.deleted_at IS NULL)
        AND (SELECT COUNT(*) FROM tasks WHERE deleted_at IS NULL OR deletion_batch_id=?)<=?`, params: [batchId,deleted.parentId,batchId,MAX_NODES] }),
      set: {
        sql: "deleted_at=NULL,deletion_batch_id=NULL,position=COALESCE((SELECT MAX(position)+1 FROM tasks sibling WHERE sibling.parent_id=? AND sibling.deleted_at IS NULL),0)",
        params: [deleted.parentId],
      },
      statements: (gate,token) => [{
        sql: `UPDATE tasks SET deleted_at=NULL,deletion_batch_id=NULL,version=version+1,updated_at=?,last_mutation_id=? WHERE deletion_batch_id=? AND ${gate.sql}`,
        params: [new Date().toISOString(),token,batchId,...gate.params],
      }],
    });
    if (!restored) throw new FormError("Не удалось восстановить: данные изменились, родительская группа удалена или превышен лимит задач. Обновите корзину.");
    return { id: deleted.parentId, message: "Задача восстановлена вместе с подзадачами и участниками." };
  }, "/trash");
}

export async function moveTask(form: FormData): Promise<void> {
  return ordinary(form, async form => {
    await access(form);
    const { node, path, version } = await nodeFor(form);
    const delta = Number(str(form,"delta"));
    if (node.id === ROOT_ID || ![-1,1].includes(delta)) throw new FormError("Задачу нельзя переместить.");
    const parent = path.at(-2)!;
    const index = parent.children.findIndex(item => item.id === node.id);
    const neighbor = parent.children[index + delta];
    if (!neighbor) throw new FormError("Задача уже находится на краю списка.");
    await ensureChanged(await runMutation(getD1(), {
      id: node.id,version,
      guard: { sql: "EXISTS (SELECT 1 FROM tasks WHERE id=? AND version=? AND deleted_at IS NULL AND parent_id=?)", params: [neighbor.id,neighbor.version,parent.id] },
      set: { sql:"position=?",params:[neighbor.position] },
      statements: (gate,token) => [{
        sql:`UPDATE tasks SET position=?,version=version+1,updated_at=?,last_mutation_id=? WHERE id=? AND ${gate.sql}`,
        params:[node.position,new Date().toISOString(),token,neighbor.id,...gate.params],
      }],
    }));
    return { id:parent.id,message:delta < 0 ? "Задача перемещена раньше." : "Задача перемещена позже." };
  });
}

export async function nestTask(form: FormData): Promise<void> {
  return ordinary(form, async form => {
    await access(form);
    const { node,path,tree,version } = await nodeFor(form);
    if (node.kind !== "leaf") throw new FormError("Это уже группа задач.");
    if (path.length >= MAX_DEPTH || countNodes(tree) >= MAX_NODES) throw new FormError("Достигнут лимит задач или вложенности.");
    const childId = `step-${crypto.randomUUID()}`;
    await ensureChanged(await runMutation(getD1(), {
      id:node.id,version,
      guard:{sql:"kind='leaf' AND (SELECT COUNT(*) FROM tasks WHERE deleted_at IS NULL) < ?",params:[MAX_NODES]},
      set:{sql:"kind='group',status=NULL,result=''",params:[]},
      statements:gate => [{
        sql:`INSERT INTO tasks (id,parent_id,kind,title,owner_id,status,priority,due_label,due_date,description,result,size,theme,position,split_source_id)
          SELECT ?,?,'leaf',?,?,?,?,?,?,?,?,'small',?,0,? WHERE ${gate.sql}`,
        params:[childId,node.id,node.title,node.ownerId,node.status ?? "todo",node.priority ?? null,node.dueLabel,node.dueDate,node.description,node.result,node.theme,node.id,...gate.params],
      },{
        sql:`INSERT INTO task_participants (task_id,member_id) SELECT ?,member_id FROM task_participants WHERE task_id=? AND ${gate.sql}`,
        params:[childId,node.id,...gate.params],
      },{
        sql:`UPDATE schedule_entries SET task_id=?,version=version+1 WHERE task_id=? AND ${gate.sql}`,
        params:[childId,node.id,...gate.params],
      }],
    }));
    return {id:node.id,message:"Задача преобразована в группу задач. Пока внутри только исходная копия, разбиение можно отменить."};
  });
}

export async function unnestTask(form: FormData): Promise<void> {
  return ordinary(form, async form => {
    await access(form);
    const {node,version} = await nodeFor(form);
    const child = node.children[0];
    if (node.kind !== "group" || node.children.length !== 1 || child.kind !== "leaf" || child.splitSourceId !== node.id) throw new FormError("Отмена доступна, только пока группа содержит одну исходную копию задачи.");
    const sameParticipants = JSON.stringify([...new Set(node.participants)].sort()) === JSON.stringify([...new Set(child.participants)].sort());
    if (node.title !== child.title || node.ownerId !== child.ownerId || node.dueDate !== child.dueDate || node.description !== child.description || !sameParticipants) {
      throw new FormError("Группа и исходная задача уже изменены по-разному. Отмена недоступна, чтобы не потерять правки названия, описания или участников.");
    }
    const activity = await getD1().prepare(`SELECT
      (SELECT COUNT(*) FROM task_messages WHERE task_id=?) +
      (SELECT COUNT(*) FROM schedule_entries WHERE plan_task_id=?) +
      (SELECT COUNT(*) FROM schedule_plans WHERE task_id=?) AS count`)
      .bind(child.id,child.id,child.id).first<{ count: number }>();
    if (Number(activity?.count ?? 0) > 0) throw new FormError("В подзадаче уже есть переписка или сохранённый график, созданный отдельно для неё. Отмена разбиения скрыла бы эту работу, поэтому недоступна.");
    const now = new Date().toISOString();
    const batchId = `split-undo-${crypto.randomUUID()}`;
    await ensureChanged(await runMutation(getD1(), {
      id:node.id,version,
      guard:{sql:`kind='group' AND (SELECT COUNT(*) FROM tasks WHERE parent_id=? AND deleted_at IS NULL)=1
        AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND version=? AND kind='leaf' AND split_source_id=? AND deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM task_messages WHERE task_id=?)
        AND NOT EXISTS (SELECT 1 FROM schedule_entries WHERE plan_task_id=?)
        AND NOT EXISTS (SELECT 1 FROM schedule_plans WHERE task_id=?)`,params:[node.id,child.id,child.version,node.id,child.id,child.id,child.id]},
      set:{sql:"kind='leaf',title=?,owner_id=?,status=?,priority=?,due_label=?,due_date=?,description=?,result=?",params:[child.title,child.ownerId,child.status,child.priority ?? null,child.dueLabel,child.dueDate,child.description,child.result]},
      statements:(gate,token)=>[...participantWrites(node.id,child.participants,gate,true),{
        sql:`UPDATE schedule_entries SET task_id=?,version=version+1 WHERE task_id=? AND ${gate.sql}`,
        params:[node.id,child.id,...gate.params],
      },{
        sql:`UPDATE tasks SET deleted_at=?,deletion_batch_id=?,version=version+1,updated_at=?,last_mutation_id=? WHERE id=? AND ${gate.sql}`,
        params:[now,batchId,now,token,child.id,...gate.params],
      }],
    }));
    return {id:node.id,message:"Разбиение отменено. Содержание исходной задачи сохранено."};
  });
}

function expectedStatus(form: FormData, node: TaskNode): string {
  const expected = str(form,"expectedStatus");
  if (!isTaskStatus(expected) || expected !== node.status) throw new FormError(CONFLICT);
  return expected;
}

export async function setStatus(form: FormData): Promise<void> {
  return ordinary(form,async form => {
    await access(form);
    const {node,version,tree} = await nodeFor(form);
    const expected = expectedStatus(form,node);
    const status = str(form,"status");
    const allowed = (status === "done" && expected === "review" && Boolean(node.result.trim())) ||
      (status === "doing" && ["review","done","todo"].includes(expected)) ||
      (status === "todo" && expected === "doing");
    if (node.kind !== "leaf" || !allowed) throw new FormError("Этот переход статуса недоступен. Принять можно только результат, переданный на проверку.");
    const reopen = expected === "done" && status === "doing";
    await ensureChanged(await runMutation(getD1(),{
      id:node.id,version,status:expected,
      guard:reopen ? rootVersionGuard(tree.version,{sql:"kind='leaf'",params:[]}) : {sql:"kind='leaf'",params:[]},
      set:{sql:"status=?",params:[status]},
    }));
    return {id:node.id,message:status === "done" ? "Результат принят." : status === "doing" ? "Задача возвращена в работу." : "Задача возвращена в очередь."};
  });
}

const submit: Operation = async form => {
  const ctx = await access(form,false);
  const {node,version} = await nodeFor(form);
  if (!canSubmit(ctx,node)) throw new FormError("Отправить результат может руководитель или участник этой задачи.");
  const expected = expectedStatus(form,node);
  if (node.kind !== "leaf" || !["todo","doing"].includes(expected)) throw new FormError("Результат уже на проверке или принят. Обновите страницу.");
  const result = bounded(text(form,"result"),5000,"result","Результат");
  if (!result.trim()) throw new FormError("Опишите результат перед отправкой.",{result:"Введите результат."});
  const permission: Statement = canManage(ctx) ? {sql:"1=1",params:[]} : {
    sql:"(owner_id=? OR EXISTS (SELECT 1 FROM task_participants p WHERE p.task_id=tasks.id AND p.member_id=?))",
    params:[ctx.memberId,ctx.memberId],
  };
  await ensureChanged(await runMutation(getD1(),{
    id:node.id,version,status:expected,
    guard:{sql:`kind='leaf' AND ${permission.sql}`,params:permission.params},
    set:{sql:"result=?,status='review'",params:[result]},
  }));
  return {id:node.id,message:"Результат передан на проверку."};
};

export async function submitResultState(_previous: ActionState, form: FormData): Promise<ActionState> { return perform(form,submit); }
export async function submitResult(form: FormData): Promise<void> { return ordinary(form,submit); }

export async function listChildren(parentId: string) {
  await requireAccess(taskHref(parentId));
  const tree = await loadTree();
  return findPath(parentId,tree)?.at(-1)?.children ?? [];
}

export async function retryBotWebhook(form: FormData): Promise<void> {
  return ordinary(form, async form => {
    await access(form);
    const id = taskId(form);
    const eventId = str(form, "eventId");
    if (!/^[a-zA-Z0-9_-]+$/.test(eventId)) throw new FormError("Событие не найдено.");
    const row = await retryAgentDelivery(getD1(), eventId, id);
    if (!row) throw new FormError("Событие не найдено.");
    return { id, message: row.status === "delivered" ? "Событие повторно передано боту." : "Не удалось повторно передать событие боту." };
  });
}
