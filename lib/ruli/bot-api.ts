/** Входящий HTTP API для внешних агентов Grok Bot. Без сессии ChatGPT. */

import { isTaskStatus, type TaskStatus } from "./model";
import { AGENT_PROVIDER, type TaskSnapshot } from "./agent-webhook";
import { isBotSlug } from "./bot-catalog";

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
    FROM tasks WHERE id=?`).bind(id).first<{
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

async function readIdempotency(deps: BotApiDependencies, agent: BotApiAgent, request: Request, url: URL): Promise<Response | null> {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return null;
  if (key.length < 8 || key.length > 200 || !/^[a-zA-Z0-9._:-]+$/.test(key)) {
    return json({ error: "Некорректный заголовок Idempotency-Key." }, 400);
  }
  const row = await deps.db.prepare(`SELECT method,path,status,body FROM bot_api_idempotency
    WHERE bot_member_id=? AND idempotency_key=?`).bind(agent.memberId, key).first<{ method: string; path: string; status: number; body: string }>();
  if (!row) return null;
  if (row.method !== request.method || row.path !== requestPath(url)) {
    return json({ error: "Этот Idempotency-Key уже использован для другого запроса." }, 409);
  }
  return json(JSON.parse(row.body), row.status, { "Idempotency-Replayed": "true" });
}

async function storeIdempotency(deps: BotApiDependencies, agent: BotApiAgent, request: Request, url: URL, status: number, body: unknown) {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return;
  const now = (deps.now ?? (() => new Date()))().toISOString();
  await deps.db.prepare(`INSERT OR IGNORE INTO bot_api_idempotency
    (bot_member_id,idempotency_key,method,path,status,body,created_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(agent.memberId, key, request.method, requestPath(url), status, JSON.stringify(body), now).run();
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
    WHERE t.deleted_at IS NULL AND t.kind='leaf'
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

async function postMessage(deps: BotApiDependencies, agent: BotApiAgent, id: string, body: Record<string, unknown>, request: Request) {
  const text = field(body, "text");
  if (!text.trim() || text.length > BOT_API_MAX_TEXT) {
    return json({ error: `Сообщение должно содержать от 1 до ${BOT_API_MAX_TEXT} символов.` }, 400);
  }
  const task = await loadTask(deps.db, id);
  if (!task || task.deletedAt) return json({ error: "Задача не найдена." }, 404);
  const participants = await loadParticipants(deps.db, id);
  if (!botCanAccessTask(task, participants, agent.memberId)) return json({ error: "Нет доступа к этой задаче." }, 403);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const messageId = (deps.uuid ?? (() => crypto.randomUUID()))();
  const clientId = request.headers.get("idempotency-key")?.trim() || messageId;
  const authorUserId = `${BOT_AUTHOR_PREFIX}${agent.memberId}`;
  const inserted = await deps.db.prepare(`INSERT INTO task_messages
    (id,task_id,channel_member_id,author_id,author_user_id,author_name,body,client_id,created_at)
    SELECT ?,id,NULL,?,?,?,?,?,? FROM tasks WHERE id=? AND deleted_at IS NULL
    ON CONFLICT(author_user_id,client_id) DO NOTHING`)
    .bind(messageId, agent.memberId, authorUserId, agent.name, text, clientId, now, id).run();
  const stored = await deps.db.prepare(`SELECT id,body,created_at AS createdAt FROM task_messages WHERE author_user_id=? AND client_id=?`)
    .bind(authorUserId, clientId).first<{ id: string; body: string; createdAt: string }>();
  if (!stored) return json({ error: "Не удалось сохранить сообщение." }, 409);
  if (inserted.meta.changes && deps.onMessage) {
    await deps.onMessage(toSnapshot(task, participants), {
      id: stored.id, authorId: agent.memberId, authorName: agent.name, authorKind: "bot", text, channelMemberId: null,
    });
  }
  return json({ id: stored.id, taskId: id, text: stored.body, createdAt: stored.createdAt, replayed: !inserted.meta.changes }, inserted.meta.changes ? 201 : 200);
}

async function postStatus(deps: BotApiDependencies, agent: BotApiAgent, id: string, body: Record<string, unknown>) {
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
  const denied = allowedBotStatusTransition(task.status, status, Boolean(nextResult.trim()));
  if (denied) return json({ error: denied }, 409);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const token = (deps.uuid ?? (() => crypto.randomUUID()))();
  const updated = await deps.db.prepare(`UPDATE tasks SET status=?,result=?,version=version+1,updated_at=?,last_mutation_id=?
    WHERE id=? AND version=? AND deleted_at IS NULL AND kind='leaf'`).bind(status, nextResult, now, token, id, task.version).run();
  if (!updated.meta.changes) return json({ error: "Задача изменилась. Повторите запрос." }, 409);
  const saved = await loadTask(deps.db, id);
  return json({ id, status: saved?.status, result: saved?.result, version: saved?.version });
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
  const replay = await readIdempotency(deps, agent, request, url);
  if (replay) return replay;

  let response: Response;
  if (!taskId && request.method === "GET") response = await listTasks(deps, agent, url.searchParams.get("status"));
  else if (taskId && !action && request.method === "GET") response = await getTask(deps, agent, taskId, deps.baseUrl);
  else if (taskId && action === "messages" && request.method === "POST") response = await postMessage(deps, agent, taskId, body, request);
  else if (taskId && action === "status" && request.method === "POST") response = await postStatus(deps, agent, taskId, body);
  else response = json({ error: "Маршрут не найден." }, 404);

  if (request.headers.get("idempotency-key") && request.method !== "GET" && response.status < 500) {
    const clone = await response.clone().json().catch(() => ({ error: "Некорректный ответ." }));
    await storeIdempotency(deps, agent, request, url, response.status, clone);
  }
  return response;
}

export function botApiDepsFromEnv(db: D1Database, env: { RULI_BOT_API_TOKEN?: string; RULI_BASE_URL?: string }, extra: Partial<BotApiDependencies> = {}): BotApiDependencies {
  return { db, token: env.RULI_BOT_API_TOKEN, baseUrl: env.RULI_BASE_URL, ...extra };
}
