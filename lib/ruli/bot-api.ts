/** Входящий HTTP API для внешних агентов Grok Bot. Без сессии ChatGPT. */

import { isTaskStatus, type TaskStatus } from "./model";
import { AGENT_PROVIDER, type TaskSnapshot } from "./agent-webhook";
import { isBotSlug } from "./bot-catalog";
import { ACTIVE_TASK_ACCESS_SQL, activeTaskAccessSql, PRIVATE_CHANNEL_ACCESS_SQL, taskHasPrivateChannel } from "./agent-channels";

export const BOT_API_MAX_TEXT = 5000;
export const BOT_AUTHOR_PREFIX = "bot:";

export type BotApiAgent = {
  memberId: string;
  name: string;
  shortName: string;
  slug: string;
  enabled: boolean;
};

export type BotApiDependencies = {
  db: D1Database;
  token?: string;
  baseUrl?: string;
  now?: () => Date;
  uuid?: () => string;
  onMessage?: (task: TaskSnapshot, message: {
    id: string; authorId: string; authorName: string; authorKind: "human" | "bot";
    text: string; channelMemberId: string | null;
  }) => Promise<void>;
};

export type IdempotentResponse = { status: number; body: unknown };

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

export function timingSafeEqualText(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length, 1);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0 && left.length === right.length && left.length > 0;
}

export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  return match?.[1] ?? null;
}

export async function findAgentBySlug(db: D1Database, slug: string): Promise<BotApiAgent | null> {
  if (!isBotSlug(slug)) return null;
  const row = await db.prepare(`SELECT m.id AS memberId,m.name,m.short_name AS shortName,c.slug,c.enabled
    FROM bot_configs c JOIN members m ON m.id=c.member_id
    WHERE c.provider=? AND c.slug=?`).bind(AGENT_PROVIDER, slug).first<BotApiAgent & { enabled: number | boolean }>();
  if (!row) return null;
  return { memberId: row.memberId, name: row.name, shortName: row.shortName, slug: row.slug, enabled: Boolean(row.enabled) };
}

async function loadTask(db: D1Database, id: string) {
  return db.prepare(`SELECT id,parent_id AS parentId,kind,title,owner_id AS ownerId,status,priority,
    due_date AS due,description,result,version,deleted_at AS deletedAt
    FROM tasks WHERE id=? AND ${ACTIVE_TASK_ACCESS_SQL}`).bind(id, id).first<{
      id: string; parentId: string | null; kind: string; title: string; ownerId: string;
      status: string | null; priority: string | null; due: string | null; description: string;
      result: string; version: number; deletedAt: string | null;
    }>();
}

async function loadParticipants(db: D1Database, taskId: string): Promise<string[]> {
  const result = await db.prepare("SELECT member_id AS memberId FROM task_participants WHERE task_id=?").bind(taskId).all<{ memberId: string }>();
  return result.results.map(row => row.memberId);
}

export function botCanAccessTask(task: { ownerId: string; deletedAt: string | null }, participants: string[], botMemberId: string): boolean {
  if (task.deletedAt) return false;
  return task.ownerId === botMemberId || participants.includes(botMemberId);
}

export function allowedBotStatusTransition(current: string | null, next: TaskStatus, hasResult: boolean): string | null {
  if (next === "review" && !hasResult) return "Опишите результат перед отправкой на проверку.";
  if (current === next) return null;
  if ((current === "todo" || current === "doing") && (next === "todo" || next === "doing")) return null;
  if ((current === "todo" || current === "doing") && next === "review") return null;
  if (current === "review" && next === "doing") return null;
  if (current === "review" && next === "done") {
    return hasResult ? null : "Чтобы передать задачу на принятие, сначала укажите результат или отправьте статус «На проверке» с результатом.";
  }
  if (next === "done") return "Готово доступно только из статуса «На проверке».";
  return "Этот переход статуса недоступен для исполнителя.";
}

function toSnapshot(task: Awaited<ReturnType<typeof loadTask>> & object, participants: string[]): TaskSnapshot {
  return {
    id: task!.id, title: task!.title, description: task!.description, status: task!.status,
    priority: task!.priority, due: task!.due, parentId: task!.parentId, ownerId: task!.ownerId, participants,
  };
}

async function authorize(request: Request, deps: BotApiDependencies, slug: string): Promise<BotApiAgent | Response> {
  const expected = deps.token?.trim() ?? "";
  const provided = readBearerToken(request) ?? "";
  if (!expected || !timingSafeEqualText(provided, expected)) {
    return json({ error: "Нужен действительный токен бота." }, 401);
  }
  const agent = await findAgentBySlug(deps.db, slug);
  if (!agent || !agent.enabled) return json({ error: "Бот не найден или выключен." }, 403);
  return agent;
}

function requestPath(url: URL): string {
  return `${url.pathname}${url.search}`;
}

type IdempotencyContext = { key: string; method: string; path: string; hash: string; completed?: boolean };
type IdempotencyRow = { method: string; path: string; requestHash: string | null; status: number; body: string };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function idempotencyContext(request: Request, url: URL, body: Record<string, unknown>): Promise<IdempotencyContext | Response | null> {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return null;
  if (key.length < 8 || key.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(key)) {
    return json({ error: "Некорректный заголовок Idempotency-Key." }, 400);
  }
  if (request.method === "GET") return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(body)));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return { key, method: request.method, path: requestPath(url), hash };
}

async function readIdempotency(deps: BotApiDependencies, agent: BotApiAgent, context: IdempotencyContext | null): Promise<Response | null> {
  if (!context) return null;
  const row = await deps.db.prepare(`SELECT method,path,request_hash AS requestHash,status,body FROM bot_api_idempotency
    WHERE bot_member_id=? AND idempotency_key=?`).bind(agent.memberId, context.key).first<IdempotencyRow>();
  if (!row) return null;
  if (row.method !== context.method || row.path !== context.path || (row.requestHash !== null && row.requestHash !== context.hash)) {
    return json({ error: "Этот Idempotency-Key уже использован для другого запроса." }, 409);
  }
  return json(JSON.parse(row.body), row.status, { "Idempotency-Replayed": "true" });
}

async function storeIdempotency(deps: BotApiDependencies, agent: BotApiAgent, context: IdempotencyContext, response: Response): Promise<Response> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const body = await response.clone().text();
  const inserted = await deps.db.prepare(`INSERT OR IGNORE INTO bot_api_idempotency
    (bot_member_id,idempotency_key,method,path,request_hash,status,body,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(agent.memberId, context.key, context.method, context.path, context.hash, response.status, body, now).run();
  return inserted.meta.changes ? response : (await readIdempotency(deps, agent, context)) ?? response;
}

function unusedKeyGuard(agent: BotApiAgent, context: IdempotencyContext | null): { sql: string; params: string[] } {
  return context ? {
    sql: " AND NOT EXISTS (SELECT 1 FROM bot_api_idempotency WHERE bot_member_id=? AND idempotency_key=?)",
    params: [agent.memberId, context.key],
  } : { sql: "", params: [] };
}

function currentAgentGuard(agent: BotApiAgent): { sql: string; params: string[] } {
  return {
    sql: " AND EXISTS (SELECT 1 FROM bot_configs c WHERE c.member_id=? AND c.provider=? AND c.slug=? AND c.enabled=1)",
    params: [agent.memberId, AGENT_PROVIDER, agent.slug],
  };
}

/** A response and its mutation commit together; a lost response can be replayed safely. */
async function commitBotMutation(
  deps: BotApiDependencies, agent: BotApiAgent, context: IdempotencyContext | null,
  mutation: D1PreparedStatement, successGuard: string, successParams: unknown[], response: Response,
): Promise<{ changed: boolean; response: Response | null }> {
  if (!context) {
    const result = await mutation.run();
    return { changed: Boolean(result.meta.changes), response: null };
  }
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const body = await response.clone().text();
  const results = await deps.db.batch([
    mutation,
    deps.db.prepare(`INSERT OR IGNORE INTO bot_api_idempotency
      (bot_member_id,idempotency_key,method,path,request_hash,status,body,created_at)
      SELECT ?,?,?,?,?,?,?,? WHERE ${successGuard}`)
      .bind(agent.memberId, context.key, context.method, context.path, context.hash, response.status, body, now, ...successParams),
  ]);
  const changed = Boolean(results[0].meta.changes);
  if (changed) {
    context.completed = true;
    return { changed, response };
  }
  const replay = await readIdempotency(deps, agent, context);
  if (replay) context.completed = true;
  return { changed, response: replay };
}

async function parsedBody(request: Request): Promise<Record<string, unknown> | Response> {
  if (request.method === "GET") return {};
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ error: "Ожидается JSON-объект." }, 400);
    return value as Record<string, unknown>;
  } catch {
    return json({ error: "Некорректный JSON." }, 400);
  }
}

function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

async function listTasks(deps: BotApiDependencies, agent: BotApiAgent, statusFilter: string | null) {
  if (statusFilter && !isTaskStatus(statusFilter)) return json({ error: "Неизвестный статус." }, 400);
  const rows = await deps.db.prepare(`SELECT t.id,t.title,t.description,t.status,t.priority,t.due_date AS due,
    t.parent_id AS parentId,t.owner_id AS ownerId,t.result,t.updated_at AS updatedAt
    FROM tasks t
    WHERE t.deleted_at IS NULL AND t.kind='leaf' AND ${activeTaskAccessSql("t.id")}
      AND (t.owner_id=? OR EXISTS (SELECT 1 FROM task_participants p WHERE p.task_id=t.id AND p.member_id=?))
      ${statusFilter ? "AND t.status=?" : ""}
    ORDER BY t.updated_at DESC,t.id
    LIMIT 200`).bind(...(statusFilter ? [agent.memberId, agent.memberId, statusFilter] : [agent.memberId, agent.memberId]))
    .all();
  return json({ bot: { slug: agent.slug, name: agent.name }, tasks: rows.results });
}

async function getTask(deps: BotApiDependencies, agent: BotApiAgent, id: string, configBase?: string) {
  const task = await loadTask(deps.db, id);
  if (!task || task.deletedAt) return json({ error: "Задача не найдена." }, 404);
  const participants = await loadParticipants(deps.db, id);
  if (!botCanAccessTask(task, participants, agent.memberId)) return json({ error: "Нет доступа к этой задаче." }, 403);
  const messages = await deps.db.prepare(`SELECT id,author_name AS authorName,author_id AS authorId,body,created_at AS createdAt,
    channel_member_id AS channelMemberId FROM task_messages
    WHERE task_id=? AND (channel_member_id IS NULL OR channel_member_id=?)
    ORDER BY created_at DESC,id DESC LIMIT 50`).bind(id, agent.memberId).all();
  const people = await deps.db.prepare("SELECT id,name,type FROM members").all<{ id: string; name: string; type: string }>();
  const names = new Map(people.results.map(row => [row.id, row]));
  return json({
    bot: { slug: agent.slug, name: agent.name },
    task: {
      id: task.id, title: task.title, description: task.description, status: task.status,
      priority: task.priority, due: task.due, parentId: task.parentId, result: task.result,
      url: (configBase || "").replace(/\/+$/, "") + (task.id === "root" ? "/" : `/t/${encodeURIComponent(task.id)}`),
      owner: names.get(task.ownerId) ? { name: names.get(task.ownerId)!.name, kind: names.get(task.ownerId)!.type === "bot" ? "bot" : "human" } : { name: task.ownerId, kind: "human" },
      participants: [task.ownerId, ...participants].filter((id, index, all) => all.indexOf(id) === index).map(memberId => ({
        name: names.get(memberId)?.name || memberId,
        kind: names.get(memberId)?.type === "bot" ? "bot" : "human",
      })),
    },
    messages: messages.results.slice().reverse(),
  });
}

async function replyChannel(deps: BotApiDependencies, agent: BotApiAgent, id: string, body: Record<string, unknown>): Promise<{ memberId: string | null } | Response> {
  if (body.replyToEventId === undefined) return { memberId: null };
  if (typeof body.replyToEventId !== "string" || !body.replyToEventId.trim() || body.replyToEventId.length > 200) {
    return json({ error: "Укажите действительный replyToEventId." }, 400);
  }
  const event = await deps.db.prepare(`SELECT event,payload FROM bot_webhook_outbox
    WHERE id=? AND task_id=? AND bot_member_id=?`)
    .bind(body.replyToEventId.trim(), id, agent.memberId).first<{ event: string; payload: string }>();
  if (!event) return json({ error: "Событие недоступно для этого бота и задачи." }, 403);
  let payload: { message?: { id?: unknown } };
  try { payload = JSON.parse(event.payload); }
  catch { return json({ error: "Не удалось определить канал исходного события." }, 409); }
  if (!payload || typeof payload !== "object") return json({ error: "Не удалось определить канал исходного события." }, 409);
  if (!payload.message && (event.event === "task.assigned" || event.event === "task.updated")) return { memberId: null };
  if (typeof payload.message?.id !== "string" || !payload.message.id) return json({ error: "Не удалось определить канал исходного сообщения." }, 409);
  const message = await deps.db.prepare("SELECT channel_member_id AS memberId FROM task_messages WHERE id=? AND task_id=?")
    .bind(payload.message.id, id).first<{ memberId: string | null }>();
  if (!message) return json({ error: "Исходное сообщение недоступно." }, 409);
  if (message.memberId !== null && message.memberId !== agent.memberId) return json({ error: "Нет доступа к этому личному диалогу." }, 403);
  return message;
}

async function postMessage(deps: BotApiDependencies, agent: BotApiAgent, id: string, body: Record<string, unknown>, context: IdempotencyContext | null) {
  const text = field(body, "text");
  if (!text.trim() || text.length > BOT_API_MAX_TEXT) {
    return json({ error: `Сообщение должно содержать от 1 до ${BOT_API_MAX_TEXT} символов.` }, 400);
  }
  const task = await loadTask(deps.db, id);
  if (!task || task.deletedAt) return json({ error: "Задача не найдена." }, 404);
  const participants = await loadParticipants(deps.db, id);
  const channel = await replyChannel(deps, agent, id, body);
  if (channel instanceof Response) return channel;
  const permitted = channel.memberId
    ? await taskHasPrivateChannel(deps.db, id, agent.memberId)
    : botCanAccessTask(task, participants, agent.memberId);
  if (!permitted) return json({ error: "Нет доступа к этой задаче или диалогу." }, 403);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const messageId = (deps.uuid ?? (() => crypto.randomUUID()))();
  const clientId = context?.key || messageId;
  const authorUserId = `${BOT_AUTHOR_PREFIX}${agent.memberId}`;
  const keyGuard = unusedKeyGuard(agent, context);
  const agentGuard = currentAgentGuard(agent);
  const access = channel.memberId
    ? { sql: PRIVATE_CHANNEL_ACCESS_SQL, params: [id, agent.memberId, agent.memberId] }
    : { sql: "(owner_id=? OR EXISTS (SELECT 1 FROM task_participants p WHERE p.task_id=tasks.id AND p.member_id=?))", params: [agent.memberId, agent.memberId] };
  const mutation = deps.db.prepare(`INSERT INTO task_messages
    (id,task_id,channel_member_id,author_id,author_user_id,author_name,body,client_id,created_at)
    SELECT ?,id,?,?,?,?,?,?,? FROM tasks WHERE id=? AND deleted_at IS NULL
      AND ${ACTIVE_TASK_ACCESS_SQL} AND ${access.sql}${agentGuard.sql}${keyGuard.sql}
    ON CONFLICT(author_user_id,client_id) DO NOTHING`)
    .bind(messageId, channel.memberId, agent.memberId, authorUserId, agent.name, text, clientId, now, id, id, ...access.params, ...agentGuard.params, ...keyGuard.params);
  const success = json({ id: messageId, taskId: id, channelMemberId: channel.memberId, text, createdAt: now, replayed: false }, 201);
  const committed = await commitBotMutation(deps, agent, context, mutation,
    "EXISTS (SELECT 1 FROM task_messages WHERE id=?)", [messageId], success);
  if (committed.changed && deps.onMessage) {
    await deps.onMessage(toSnapshot(task, participants), {
      id: messageId, authorId: agent.memberId, authorName: agent.name, authorKind: "bot", text, channelMemberId: channel.memberId,
    });
  }
  if (committed.response) return committed.response;
  if (committed.changed) return success;
  // Recover old message retries which predate atomic response persistence.
  const stored = await deps.db.prepare(`SELECT id,task_id AS taskId,channel_member_id AS channelMemberId,body,created_at AS createdAt
    FROM task_messages WHERE author_user_id=? AND client_id=?`).bind(authorUserId, clientId)
    .first<{ id: string; taskId: string; channelMemberId: string | null; body: string; createdAt: string }>();
  if (!stored || stored.taskId !== id || stored.channelMemberId !== channel.memberId || stored.body !== text) {
    return json({ error: "Задача или доступ изменились. Обновите данные перед повторной отправкой." }, 409);
  }
  return json({ id: stored.id, taskId: id, channelMemberId: stored.channelMemberId, text: stored.body, createdAt: stored.createdAt, replayed: true });
}

async function postStatus(deps: BotApiDependencies, agent: BotApiAgent, id: string, body: Record<string, unknown>, context: IdempotencyContext | null) {
  const status = field(body, "status").trim();
  if (!isTaskStatus(status)) return json({ error: "Укажите допустимый статус: todo, doing, review или done." }, 400);
  const resultText = typeof body.result === "string" ? body.result : undefined;
  if (resultText !== undefined && resultText.length > BOT_API_MAX_TEXT) {
    return json({ error: `Результат: не более ${BOT_API_MAX_TEXT} символов.` }, 400);
  }
  const task = await loadTask(deps.db, id);
  if (!task || task.deletedAt) return json({ error: "Задача не найдена." }, 404);
  if (task.kind !== "leaf") return json({ error: "Статус меняется только у отдельных поручений." }, 400);
  const participants = await loadParticipants(deps.db, id);
  if (!botCanAccessTask(task, participants, agent.memberId)) return json({ error: "Нет доступа к этой задаче." }, 403);
  const nextResult = resultText !== undefined ? resultText : task.result;
  if (task.status === "done" && (status !== "done" || nextResult !== task.result)) {
    return json({ error: "Принятый результат нельзя изменить. Руководитель должен сначала вернуть задачу в работу." }, 409);
  }
  const denied = allowedBotStatusTransition(task.status, status, Boolean(nextResult.trim()));
  if (denied) return json({ error: denied }, 409);
  if (task.status === status && task.result === nextResult) return json({ id, status, result: nextResult, version: task.version });
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const token = (deps.uuid ?? (() => crypto.randomUUID()))();
  const keyGuard = unusedKeyGuard(agent, context);
  const agentGuard = currentAgentGuard(agent);
  const mutation = deps.db.prepare(`UPDATE tasks SET status=?,result=?,version=version+1,updated_at=?,last_mutation_id=?
    WHERE id=? AND version=? AND deleted_at IS NULL AND kind='leaf' AND ${ACTIVE_TASK_ACCESS_SQL}
      AND (owner_id=? OR EXISTS (SELECT 1 FROM task_participants p WHERE p.task_id=tasks.id AND p.member_id=?))${agentGuard.sql}${keyGuard.sql}`)
    .bind(status, nextResult, now, token, id, task.version, id, agent.memberId, agent.memberId, ...agentGuard.params, ...keyGuard.params);
  const success = json({ id, status, result: nextResult, version: task.version + 1 });
  const committed = await commitBotMutation(deps, agent, context, mutation,
    "EXISTS (SELECT 1 FROM tasks WHERE id=? AND last_mutation_id=?)", [id, token], success);
  if (committed.response) return committed.response;
  return committed.changed ? success : json({ error: "Задача или доступ изменились. Повторите запрос." }, 409);
}

export async function handleBotApi(request: Request, deps: BotApiDependencies): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/bot/tasks[/:id[/(messages|status)]]
  if (segments[0] !== "api" || segments[1] !== "bot" || segments[2] !== "tasks") {
    return json({ error: "Маршрут не найден." }, 404);
  }
  const taskId = segments[3];
  const action = segments[4];
  if (segments.length > 5) return json({ error: "Маршрут не найден." }, 404);
  const body = await parsedBody(request);
  if (body instanceof Response) return body;
  const slug = (url.searchParams.get("bot") || field(body, "bot")).trim();
  const agentOrError = await authorize(request, deps, slug);
  if (agentOrError instanceof Response) return agentOrError;
  const agent = agentOrError;
  const context = await idempotencyContext(request, url, body);
  if (context instanceof Response) return context;
  const replay = await readIdempotency(deps, agent, context);
  if (replay) return replay;

  let response: Response;
  if (!taskId && request.method === "GET") response = await listTasks(deps, agent, url.searchParams.get("status"));
  else if (taskId && !action && request.method === "GET") response = await getTask(deps, agent, taskId, deps.baseUrl);
  else if (taskId && action === "messages" && request.method === "POST") response = await postMessage(deps, agent, taskId, body, context);
  else if (taskId && action === "status" && request.method === "POST") response = await postStatus(deps, agent, taskId, body, context);
  else response = json({ error: "Маршрут не найден." }, 404);

  if (context && !context.completed && response.status < 500) return storeIdempotency(deps, agent, context, response);
  return response;
}

export function botApiDepsFromEnv(db: D1Database, env: { RULI_BOT_API_TOKEN?: string; RULI_BASE_URL?: string }, extra: Partial<BotApiDependencies> = {}): BotApiDependencies {
  return { db, token: env.RULI_BOT_API_TOKEN, baseUrl: env.RULI_BASE_URL, ...extra };
}
