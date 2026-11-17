/** Исходящие события для внешних агентов Grok Bot. Без импортов Workers. */
import { taskHasPrivateChannel } from "./agent-channels.ts";

export const WEBHOOK_TIMEOUT_MS = 10_000;
export const AGENT_PROVIDER = "grok-bot";
export type AgentEventType = "task.assigned" | "task.updated" | "message.created" | "bot.mentioned";
export type DeliveryStatus = "pending" | "delivered" | "failed";
export type ParticipantKind = "human" | "bot";

export type WebhookConfig = {
  url?: string;
  key?: string;
  header?: string;
  baseUrl?: string;
};

export type AgentRef = {
  memberId: string;
  name: string;
  shortName: string;
  slug: string;
  enabled: boolean;
};

export type TaskSnapshot = {
  id: string;
  title: string;
  description: string;
  status: string | null;
  priority: string | null;
  due: string | null;
  parentId: string | null;
  ownerId: string;
  participants: string[];
};

export type MessageSnapshot = {
  id: string;
  authorId: string;
  authorName: string;
  authorKind: ParticipantKind;
  text: string;
  channelMemberId: string | null;
};

export type WebhookPayload = {
  event: AgentEventType;
  eventId: string;
  occurredAt: string;
  app: { baseUrl: string };
  task: {
    id: string; title: string; description: string; status: string | null;
    priority: string | null; due: string | null; url: string; parentId: string | null;
  };
  bot: { slug: string; name: string };
  message?: { id: string; author: { name: string; kind: ParticipantKind }; text: string };
  participants: { name: string; kind: ParticipantKind }[];
};

export type OutboxRow = {
  id: string;
  event: AgentEventType;
  taskId: string;
  botMemberId: string;
  botSlug: string;
  payload: string;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentWebhookDependencies = {
  db: D1Database;
  config: WebhookConfig;
  fetch?: typeof fetch;
  now?: () => Date;
  uuid?: () => string;
  schedule?: (work: Promise<unknown>) => void;
  loadAgents?: () => Promise<AgentRef[]>;
  loadMembers?: () => Promise<{ id: string; name: string; type: string }[]>;
};

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function webhookConfigured(config: WebhookConfig): boolean {
  return Boolean(config.url?.trim());
}

/** Authorization: Bearer <key> по умолчанию; иной заголовок получает ключ как есть. */
export function webhookAuthHeader(config: WebhookConfig): [string, string] | null {
  const key = config.key?.trim();
  if (!key) return null;
  const header = config.header?.trim();
  if (!header || header.toLowerCase() === "authorization") return ["Authorization", `Bearer ${key}`];
  return [header, key];
}

export function taskUrl(baseUrl: string, taskId: string): string {
  const root = (baseUrl || "").replace(/\/+$/, "");
  if (!root) return taskId === "root" ? "/" : `/t/${encodeURIComponent(taskId)}`;
  return taskId === "root" ? `${root}/` : `${root}/t/${encodeURIComponent(taskId)}`;
}

export function involvedIds(task: Pick<TaskSnapshot, "ownerId" | "participants">): string[] {
  return [...new Set([task.ownerId, ...task.participants].filter(Boolean))];
}

export function escapeMention(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @Имя, @короткое имя или @slug; более длинные имена проверяются первыми. */
export function isAgentMention(text: string, label: string): boolean {
  if (!text || !label) return false;
  const needle = `@${label.toLowerCase()}`;
  const source = text.toLowerCase();
  let from = 0;
  while (from < source.length) {
    const index = source.indexOf(needle, from);
    if (index < 0) return false;
    const before = index === 0 ? " " : source[index - 1];
    const after = source[index + needle.length] ?? "";
    if ((index === 0 || /\s/.test(before)) && (!after || /[\s.,;:!?)]/.test(after))) return true;
    from = index + 1;
  }
  return false;
}

export function mentionedAgents(text: string, agents: AgentRef[]): AgentRef[] {
  if (!text) return [];
  const hits: AgentRef[] = [];
  for (const agent of agents) {
    const labels = [...new Set([agent.name, agent.shortName, agent.slug].filter(Boolean))]
      .sort((a, b) => b.length - a.length);
    if (labels.some(label => isAgentMention(text, label))) hits.push(agent);
  }
  return hits;
}

function assignedAgents(task: TaskSnapshot, agents: AgentRef[]): AgentRef[] {
  const ids = new Set(involvedIds(task));
  return agents.filter(agent => agent.enabled && SLUG.test(agent.slug) && ids.has(agent.memberId));
}

function newAssignees(previous: TaskSnapshot | null, next: TaskSnapshot, agents: AgentRef[]): AgentRef[] {
  const before = new Set(previous ? involvedIds(previous) : []);
  return assignedAgents(next, agents).filter(agent => !before.has(agent.memberId));
}

function contentChanged(previous: TaskSnapshot, next: TaskSnapshot): boolean {
  return previous.description !== next.description
    || previous.due !== next.due
    || (previous.priority || null) !== (next.priority || null);
}

export function planTaskEvents(previous: TaskSnapshot | null, next: TaskSnapshot, agents: AgentRef[]): { agent: AgentRef; event: AgentEventType }[] {
  const assigned = newAssignees(previous, next, agents).map(agent => ({ agent, event: "task.assigned" as const }));
  const assignedIds = new Set(assigned.map(item => item.agent.memberId));
  const updated = previous && contentChanged(previous, next)
    ? assignedAgents(next, agents)
        .filter(agent => !assignedIds.has(agent.memberId))
        .map(agent => ({ agent, event: "task.updated" as const }))
    : [];
  return [...assigned, ...updated];
}

export function planMessageEvents(
  task: TaskSnapshot,
  message: MessageSnapshot,
  agents: AgentRef[],
  privateChannelVerified = false,
): { agent: AgentRef; event: AgentEventType }[] {
  // A mention never changes the audience of a private conversation. The
  // verified group channel may belong to a participant of an active child.
  const eligible = message.channelMemberId && privateChannelVerified
    ? agents.filter(agent => agent.enabled && SLUG.test(agent.slug))
    : assignedAgents(task, agents);
  const assigned = eligible.filter(agent => agent.memberId !== message.authorId
    && (!message.channelMemberId || agent.memberId === message.channelMemberId));
  const mentioned = mentionedAgents(message.text, assigned);
  const mentionedIds = new Set(mentioned.map(agent => agent.memberId));
  const events: { agent: AgentRef; event: AgentEventType }[] = mentioned.map(agent => ({ agent, event: "bot.mentioned" }));
  for (const agent of assigned) {
    if (mentionedIds.has(agent.memberId)) continue;
    events.push({ agent, event: "message.created" });
  }
  return events;
}

export function buildPayload(
  event: AgentEventType,
  eventId: string,
  occurredAt: string,
  task: TaskSnapshot,
  agent: AgentRef,
  members: { id: string; name: string; type: string }[],
  config: WebhookConfig,
  message?: MessageSnapshot,
): WebhookPayload {
  const ids = involvedIds(task);
  const participants = ids.map(id => {
    const member = members.find(item => item.id === id);
    return { name: member?.name || id, kind: (member?.type === "bot" ? "bot" : "human") as ParticipantKind };
  });
  const payload: WebhookPayload = {
    event,
    eventId,
    occurredAt,
    app: { baseUrl: (config.baseUrl || "").replace(/\/+$/, "") },
    task: {
      id: task.id, title: task.title, description: task.description, status: task.status,
      priority: task.priority, due: task.due, url: taskUrl(config.baseUrl || "", task.id),
      parentId: task.parentId,
    },
    bot: { slug: agent.slug, name: agent.name },
    participants,
  };
  if (message) {
    payload.message = { id: message.id, author: { name: message.authorName, kind: message.authorKind }, text: message.text };
  }
  return payload;
}

async function defaultLoadAgents(db: D1Database): Promise<AgentRef[]> {
  const result = await db.prepare(`SELECT m.id AS memberId,m.name,m.short_name AS shortName,c.slug,c.enabled
    FROM bot_configs c JOIN members m ON m.id=c.member_id
    WHERE c.provider=? AND c.slug IS NOT NULL AND c.slug<>''`).bind(AGENT_PROVIDER).all<AgentRef & { enabled: number | boolean }>();
  return result.results.map(row => ({
    memberId: row.memberId, name: row.name, shortName: row.shortName, slug: row.slug,
    enabled: Boolean(row.enabled),
  }));
}

async function defaultLoadMembers(db: D1Database) {
  const result = await db.prepare("SELECT id,name,type FROM members").all<{ id: string; name: string; type: string }>();
  return result.results;
}

export async function loadTaskOutbox(db: D1Database, taskId: string): Promise<OutboxRow[]> {
  const result = await db.prepare(`SELECT id,event,task_id AS taskId,bot_member_id AS botMemberId,bot_slug AS botSlug,
    payload,status,attempts,last_error AS lastError,created_at AS createdAt,updated_at AS updatedAt
    FROM bot_webhook_outbox WHERE task_id=? AND (status IN ('pending','failed') OR id IN (
      SELECT id FROM bot_webhook_outbox WHERE task_id=? AND status='delivered'
      ORDER BY created_at DESC,id DESC LIMIT 20
    )) ORDER BY created_at DESC,id DESC`).bind(taskId, taskId).all<OutboxRow>();
  return result.results;
}

export async function deliverOutboxRow(
  db: D1Database,
  row: OutboxRow,
  config: WebhookConfig,
  fetcher: typeof fetch = fetch,
  now = () => new Date(),
): Promise<OutboxRow> {
  const updatedAt = now().toISOString();
  if (!webhookConfigured(config)) {
    const error = "Вебхук не настроен.";
    await db.prepare(`UPDATE bot_webhook_outbox SET status='failed',attempts=attempts+1,last_error=?,updated_at=? WHERE id=?`)
      .bind(error, updatedAt, row.id).run();
    return { ...row, status: "failed", attempts: row.attempts + 1, lastError: error, updatedAt };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  let status: DeliveryStatus = "delivered";
  let error: string | null = null;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const auth = webhookAuthHeader(config);
    if (auth) headers[auth[0]] = auth[1];
    const response = await fetcher(config.url!.trim(), {
      method: "POST", headers, body: row.payload, signal: controller.signal, redirect: "error",
    });
    if (!response.ok) {
      status = "failed";
      error = `Вебхук ответил ${response.status}.`;
      void response.body?.cancel().catch(() => {});
    } else {
      void response.body?.cancel().catch(() => {});
    }
  } catch (cause) {
    status = "failed";
    error = cause instanceof Error && cause.name === "AbortError"
      ? "Вебхук не ответил за 10 секунд."
      : "Не удалось доставить событие боту.";
  } finally {
    clearTimeout(timer);
  }
  await db.prepare(`UPDATE bot_webhook_outbox SET status=?,attempts=attempts+1,last_error=?,updated_at=? WHERE id=?`)
    .bind(status, error, updatedAt, row.id).run();
  return { ...row, status, attempts: row.attempts + 1, lastError: error, updatedAt };
}

async function insertAndSchedule(
  deps: AgentWebhookDependencies,
  items: { event: AgentEventType; agent: AgentRef; task: TaskSnapshot; message?: MessageSnapshot }[],
): Promise<OutboxRow[]> {
  if (!webhookConfigured(deps.config) || !items.length) return [];
  const db = deps.db;
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const members = await (deps.loadMembers ?? (() => defaultLoadMembers(db)))();
  const rows: OutboxRow[] = items.map(item => {
    const id = uuid();
    const payload = JSON.stringify(buildPayload(item.event, id, now, item.task, item.agent, members, deps.config, item.message));
    return {
      id, event: item.event, taskId: item.task.id, botMemberId: item.agent.memberId, botSlug: item.agent.slug,
      payload, status: "pending", attempts: 0, lastError: null, createdAt: now, updatedAt: now,
    };
  });
  await db.batch(rows.map(row => db.prepare(`INSERT INTO bot_webhook_outbox
    (id,event,task_id,bot_member_id,bot_slug,payload,status,attempts,last_error,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
    row.id, row.event, row.taskId, row.botMemberId, row.botSlug, row.payload, row.status, 0, null, row.createdAt, row.updatedAt,
  )));
  const work = Promise.all(rows.map(row => deliverOutboxRow(db, row, deps.config, deps.fetch ?? fetch, deps.now ?? (() => new Date()))))
    .then(() => undefined, () => undefined);
  if (deps.schedule) deps.schedule(work);
  else await work;
  return rows;
}

export async function notifyGrokBotTaskChange(
  deps: AgentWebhookDependencies,
  previous: TaskSnapshot | null,
  next: TaskSnapshot,
): Promise<OutboxRow[]> {
  if (!webhookConfigured(deps.config)) return [];
  const agents = await (deps.loadAgents ?? (() => defaultLoadAgents(deps.db)))();
  const planned = planTaskEvents(previous, next, agents);
  return insertAndSchedule(deps, planned.map(item => ({ ...item, task: next })));
}

export async function notifyGrokBotMessage(
  deps: AgentWebhookDependencies,
  task: TaskSnapshot,
  message: MessageSnapshot,
): Promise<OutboxRow[]> {
  if (!webhookConfigured(deps.config)) return [];
  const agents = await (deps.loadAgents ?? (() => defaultLoadAgents(deps.db)))();
  const privateChannelVerified = Boolean(message.channelMemberId
    && await taskHasPrivateChannel(deps.db, task.id, message.channelMemberId));
  if (message.channelMemberId && !privateChannelVerified) return [];
  const planned = planMessageEvents(task, message, agents, privateChannelVerified);
  return insertAndSchedule(deps, planned.map(item => ({ ...item, task, message })));
}

async function retryRecipientAvailable(deps: AgentWebhookDependencies, row: OutboxRow): Promise<boolean> {
  const agents = await (deps.loadAgents ?? (() => defaultLoadAgents(deps.db)))();
  if (!agents.some(agent => agent.enabled && agent.memberId === row.botMemberId && agent.slug === row.botSlug)) return false;
  if (!await taskHasPrivateChannel(deps.db, row.taskId, row.botMemberId)) return false;
  const task = await deps.db.prepare("SELECT owner_id AS ownerId FROM tasks WHERE id=? AND deleted_at IS NULL")
    .bind(row.taskId).first<{ ownerId: string }>();
  if (!task) return false;
  const direct = task.ownerId === row.botMemberId || Boolean(await deps.db.prepare(
    "SELECT 1 AS assigned FROM task_participants WHERE task_id=? AND member_id=?",
  ).bind(row.taskId, row.botMemberId).first());
  if (row.event === "task.assigned" || row.event === "task.updated") return direct;
  // Resolve the original channel from the durable message, not from a caller
  // or an old payload. Reassignment must not resend a historical private text.
  let messageId: unknown;
  try { messageId = (JSON.parse(row.payload) as WebhookPayload).message?.id; }
  catch { return false; }
  if (typeof messageId !== "string") return false;
  const message = await deps.db.prepare("SELECT channel_member_id AS channelMemberId FROM task_messages WHERE id=? AND task_id=?")
    .bind(messageId, row.taskId).first<{ channelMemberId: string | null }>();
  return Boolean(message && (message.channelMemberId === null ? direct : message.channelMemberId === row.botMemberId));
}

export async function retryOutboxEvent(deps: AgentWebhookDependencies, eventId: string, expectedTaskId?: string): Promise<OutboxRow | null> {
  const row = await deps.db.prepare(`SELECT id,event,task_id AS taskId,bot_member_id AS botMemberId,bot_slug AS botSlug,
    payload,status,attempts,last_error AS lastError,created_at AS createdAt,updated_at AS updatedAt
    FROM bot_webhook_outbox WHERE id=?`).bind(eventId).first<OutboxRow>();
  if (!row) return null;
  if (expectedTaskId && row.taskId !== expectedTaskId) return null;
  if (!await retryRecipientAvailable(deps, row)) {
    const lastError = "Событие больше недоступно: задача или личный канал удалены, агент выключен либо его назначение изменилось.";
    const updatedAt = (deps.now ?? (() => new Date()))().toISOString();
    await deps.db.prepare("UPDATE bot_webhook_outbox SET status='failed',last_error=?,updated_at=? WHERE id=?")
      .bind(lastError, updatedAt, row.id).run();
    return { ...row, status: "failed", lastError, updatedAt };
  }
  return deliverOutboxRow(deps.db, row, deps.config, deps.fetch ?? fetch, deps.now ?? (() => new Date()));
}
