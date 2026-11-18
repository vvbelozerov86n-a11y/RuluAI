import type { ChatAiRun, ChatMessage, MessagePageInfo } from "../../lib/ruli/collaboration";

const TIME_ZONE = "Asia/Barnaul";
export type MessageBlock =
  | { type: "paragraph" | "quote"; text: string }
  | { type: "code"; text: string; language: string }
  | { type: "list"; ordered: boolean; items: string[]; numbers?: number[] };
export type FeedPayload = MessagePageInfo & { messages: ChatMessage[]; aiPending: number; aiRuns: ChatAiRun[]; canWrite:boolean };
export type FeedIssue = { kind: "network" | "auth" | "forbidden" | "missing"; message: string; retryable: boolean };
export type HistoryProgress = { cursors: { value: string; gap: boolean }[] };
type HistoryPage = MessagePageInfo & { messages: ChatMessage[] };

export function createHistoryProgress(page: MessagePageInfo): HistoryProgress {
  return { cursors: page.hasMore && page.beforeCursor ? [{ value: page.beforeCursor, gap: false }] : [] };
}

export function historyPageInfo(progress: HistoryProgress): MessagePageInfo {
  return { hasMore: progress.cursors.length > 0, beforeCursor: progress.cursors[0]?.value ?? null };
}

/** A latest snapshot can skip an entire page while the tab is hidden. Keep
 * that catch-up cursor ahead of the already saved oldest-history cursor. */
export function observeHistoryHead(progress: HistoryProgress, known: ChatMessage[], page: HistoryPage): HistoryProgress {
  if (!known.length || !page.messages.length || !page.hasMore || !page.beforeCursor) return progress;
  const knownIds = new Set(known.map(message => message.id));
  if (page.messages.some(message => knownIds.has(message.id))
    || compareMessages(page.messages.at(-1)!, known.at(-1)!) <= 0
    || progress.cursors.some(cursor => cursor.value === page.beforeCursor)) return progress;
  return { cursors: [{ value: page.beforeCursor, gap: true }, ...progress.cursors] };
}

/** Update the requested cursor, even when a concurrent latest poll has queued
 * a newer gap. Once a catch-up page overlaps known history, resume the old cursor. */
export function advanceHistory(progress: HistoryProgress, requestedCursor: string, known: ChatMessage[], page: HistoryPage): HistoryProgress {
  const index = progress.cursors.findIndex(cursor => cursor.value === requestedCursor);
  if (index < 0) return progress;
  if (!page.hasMore || !page.beforeCursor) return { cursors: progress.cursors.slice(0, index) };
  const knownIds = new Set(known.map(message => message.id));
  const finishedGap = progress.cursors[index].gap && page.messages.some(message => knownIds.has(message.id));
  const duplicate = progress.cursors.some((cursor, position) => position !== index && cursor.value === page.beforeCursor);
  if (finishedGap || duplicate || page.beforeCursor === requestedCursor) {
    return { cursors: progress.cursors.filter((_, position) => position !== index) };
  }
  return { cursors: progress.cursors.map((cursor, position) => position === index ? { ...cursor, value: page.beforeCursor! } : cursor) };
}

export function channelKey(channel?: string | null): string | null {
  return !channel || channel === "general" ? null : channel;
}

export function messageDate(value: string): Date | null {
  const normalized = value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value) ? value : value.replace(" ", "T") + "Z";
  const result = new Date(normalized);
  return Number.isNaN(result.getTime()) ? null : result;
}

function compareMessages(a: ChatMessage, b: ChatMessage) {
  const timeA = messageDate(a.createdAt)?.getTime();
  const timeB = messageDate(b.createdAt)?.getTime();
  if (timeA !== undefined && timeB !== undefined && timeA !== timeB) return timeA - timeB;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[], taskId: string, channel?: string | null): ChatMessage[] {
  const expected = channelKey(channel);
  if ([...current, ...incoming].some(message => message.taskId !== taskId || message.channelMemberId !== expected)) {
    throw new Error("wrong-channel");
  }
  const byId = new Map(current.map(message => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  // Older pages stay available when the newest 100 messages are refreshed.
  return [...byId.values()].sort(compareMessages);
}

export function normalizeMessageSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/gu, " ").trim();
}

export function searchMessages(messages: ChatMessage[], query: string): ChatMessage[] {
  const terms = normalizeMessageSearch(query).split(" ").filter(Boolean);
  if (!terms.length) return messages;
  return messages.filter(message => {
    const content = normalizeMessageSearch(`${message.authorName}\n${message.body}`);
    return terms.every(term => content.includes(term));
  });
}

export function newIncomingIds(previous: ChatMessage[], next: ChatMessage[], viewerMemberId: string): string[] {
  const known = new Set(previous.map(message => message.id));
  const latest = previous.at(-1);
  return next.filter(message => !known.has(message.id) && message.authorId !== viewerMemberId
    && (!latest || compareMessages(message, latest) > 0)).map(message => message.id);
}

export function safeHttpUrl(value: string): string | null {
  if (!/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f\\\u202a-\u202e\u2066-\u2069]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function linkedTextParts(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  let from = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"`]+/giu)) {
    const start = match.index;
    let candidate = match[0].replace(/[.,!?;:]+$/u, "");
    while (candidate.endsWith(")") && (candidate.match(/\)/g)?.length ?? 0) > (candidate.match(/\(/g)?.length ?? 0)) candidate = candidate.slice(0, -1);
    const href = safeHttpUrl(candidate);
    if (!href) continue;
    if (start > from) parts.push({ text: text.slice(from, start) });
    parts.push({ text: candidate, href });
    from = start + candidate.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from) });
  return parts.length ? parts : [{ text }];
}

export function formatQuote(authorName: string, body: string): string {
  const author = authorName.replace(/[\r\n\t]+/g, " ").replace(/\s+/gu, " ").trim().slice(0, 120) || "Участник";
  const characters = Array.from(body.replace(/\r\n?/g, "\n").trim());
  const excerpt = characters.length > 800 ? characters.slice(0, 799).join("") + "…" : characters.join("");
  return `> ${author}:\n${excerpt.split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
}

const fence = (line: string) => /^\s{0,3}```([^\s`]*)\s*$/.exec(line);
const listItem = (line: string) => /^\s*(?:([-*+])|(\d{1,9})[.)])\s+(.+)$/.exec(line);

export function parseMessageBlocks(body: string): MessageBlock[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MessageBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim()) { index++; continue; }
    const opening = fence(lines[index]);
    if (opening) {
      const content: string[] = [];
      const language = /^[a-zA-Z0-9_+.-]{1,40}$/.test(opening[1]) ? opening[1] : "";
      index++;
      while (index < lines.length && !/^\s{0,3}```\s*$/.test(lines[index])) content.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push({ type: "code", text: content.join("\n"), language });
      continue;
    }
    if (/^\s{0,3}>/.test(lines[index])) {
      const content: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) content.push(lines[index++].replace(/^\s{0,3}> ?/, ""));
      blocks.push({ type: "quote", text: content.join("\n") });
      continue;
    }
    const item = listItem(lines[index]);
    if (item) {
      const ordered = !item[1];
      const items: string[] = [];
      const numbers: number[] = [];
      while (index < lines.length) {
        const next = listItem(lines[index]);
        if (!next || !next[1] !== ordered) break;
        items.push(next[3]);
        if (ordered) numbers.push(Number(next[2]));
        index++;
      }
      blocks.push({ type: "list", ordered, items, ...(ordered ? {numbers} : {}) });
      continue;
    }
    const content = [lines[index++]];
    while (index < lines.length && lines[index].trim() && !fence(lines[index]) && !/^\s{0,3}>/.test(lines[index]) && !listItem(lines[index])) content.push(lines[index++]);
    blocks.push({ type: "paragraph", text: content.join("\n") });
  }
  return blocks;
}

export function messageDayKey(value: string): string {
  const date = messageDate(value);
  if (!date) return "unknown";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function messageDayLabel(value: string, now = new Date()): string {
  const date = messageDate(value);
  if (!date) return "Дата не указана";
  const key = messageDayKey(value);
  if (key === messageDayKey(now.toISOString())) return "Сегодня";
  if (key === messageDayKey(new Date(now.getTime() - 86_400_000).toISOString())) return "Вчера";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: TIME_ZONE, day: "numeric", month: "long", year: "numeric" }).format(date);
}

export function shortMessageTime(value: string): string {
  const date = messageDate(value);
  return date ? new Intl.DateTimeFormat("ru-RU", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" }).format(date) : "";
}

export function feedIssueForStatus(status: number): FeedIssue {
  if (status === 401) return { kind: "auth", message: "Чтобы продолжить переписку, войдите в аккаунт снова.", retryable: false };
  if (status === 403) return { kind: "forbidden", message: "Доступ к этому диалогу изменился. Отправка сообщений недоступна.", retryable: false };
  if (status === 404) return { kind: "missing", message: "Задача или диалог больше недоступны.", retryable: false };
  return { kind: "network", message: "Не удалось обновить сообщения. Сохранённая переписка остаётся на экране.", retryable: true };
}

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return ["id", "taskId", "authorId", "authorName", "body", "createdAt"].every(key => typeof item[key] === "string")
    && (item.channelMemberId === null || typeof item.channelMemberId === "string");
}

function isAiRun(value: unknown): value is ChatAiRun {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return ["id", "botMemberId", "createdAt"].every(key => typeof item[key] === "string")
    && ["channelMemberId", "inputMessageId", "error", "finishedAt", "output"].every(key => item[key] === null || typeof item[key] === "string")
    && ["pending", "succeeded", "failed", "stale"].includes(String(item.status)) && typeof item.canRetry === "boolean";
}

/** Replace only the current page's AI snapshot; older loaded pages stay visible. */
export function mergeChatAiRuns(current:ChatAiRun[], incoming:ChatAiRun[], messageIds:string[], channel?:string|null):ChatAiRun[] {
  const ids=new Set(messageIds),expected=channelKey(channel);
  if([...current,...incoming].some(run=>run.channelMemberId!==expected)
    ||incoming.some(run=>!run.inputMessageId||!ids.has(run.inputMessageId)))throw new Error("wrong-ai-scope");
  const byId=new Map(current.filter(run=>!run.inputMessageId||!ids.has(run.inputMessageId)).map(run=>[run.id,run]));
  for(const run of incoming)byId.set(run.id,run);
  return [...byId.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
}

export function parseFeedPayload(value: unknown, taskId: string, channel?: string | null): FeedPayload {
  if (!value || typeof value !== "object") throw new Error("invalid-messages");
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.messages) || !data.messages.every(isMessage) || typeof data.hasMore !== "boolean"
    || !(data.beforeCursor === null || typeof data.beforeCursor === "string")
    || (data.hasMore && !data.beforeCursor)
    || !Array.isArray(data.aiRuns) || !data.aiRuns.every(isAiRun) || typeof data.canWrite !== "boolean") throw new Error("invalid-messages");
  const messages = mergeMessages([], data.messages, taskId, channel);
  if (data.aiRuns.some(run => run.channelMemberId !== channelKey(channel))) throw new Error("wrong-channel");
  const aiRuns=mergeChatAiRuns([],data.aiRuns,messages.map(message=>message.id),channel);
  const aiPending = typeof data.aiPending === "number" && Number.isSafeInteger(data.aiPending) && data.aiPending > 0 ? data.aiPending : 0;
  return { messages, hasMore: data.hasMore, beforeCursor: data.beforeCursor, aiPending, aiRuns, canWrite:data.canWrite };
}
