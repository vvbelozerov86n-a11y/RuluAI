import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceHistory, channelKey, createHistoryProgress, feedIssueForStatus, formatQuote, historyPageInfo, linkedTextParts, mergeChatAiRuns, mergeMessages, messageDayKey,
  messageDayLabel, newIncomingIds, normalizeMessageSearch, parseFeedPayload, parseMessageBlocks,
  observeHistoryHead, safeHttpUrl, searchMessages, shortMessageTime,
} from "../components/ruli/chat-message-utils.ts";

function message(index, extra = {}) {
  return { id: `message-${String(index).padStart(4, "0")}`, taskId: "task", channelMemberId: null,
    authorId: "anna", authorName: "Анна", body: `Сообщение ${index}`,
    createdAt: new Date(Date.UTC(2026, 10, 18, 0, 0, index)).toISOString(), ...extra };
}
const run = extra => ({ id: "run", botMemberId: "analyst", channelMemberId: null, inputMessageId: "message-0001",
  error: "Не удалось получить ответ.", status: "failed", output:null, canRetry: true, createdAt: "2026-11-18T00:00:00Z", finishedAt: "2026-11-18T00:01:00Z", ...extra });
const payload = extra => ({ messages: [message(1)], hasMore: false, beforeCursor: null, aiPending: 0, aiRuns: [], canWrite:true, ...extra });

test("history merges retain every loaded page when latest snapshots overlap or arrive out of order", () => {
  const initial = Array.from({ length: 100 }, (_, i) => message(i + 101));
  const earlier = Array.from({ length: 100 }, (_, i) => message(i + 1));
  const loaded = mergeMessages(initial, [...earlier].reverse(), "task", "general");
  assert.equal(loaded.length, 200);
  assert.equal(initial.length, 100);
  const latest = Array.from({ length: 100 }, (_, i) => message(i + 121));
  const refreshed = mergeMessages(loaded, latest, "task");
  assert.equal(refreshed.length, 220);
  assert.equal(refreshed[0].id, "message-0001");
  assert.equal(refreshed.at(-1).id, "message-0220");
  assert.deepEqual(mergeMessages(refreshed, initial, "task"), refreshed);
});

test("history rejects unrelated tasks and private channels instead of mixing their messages", () => {
  for (const wrong of [message(2, { taskId: "other" }), message(2, { channelMemberId: "private-anna" })]) {
    assert.throws(() => mergeMessages([message(1)], [wrong], "task"), /wrong-channel/);
  }
  assert.equal(channelKey("general"), null);
  assert.equal(channelKey(undefined), null);
  assert.equal(channelKey("anna"), "anna");
  assert.throws(() => mergeMessages([message(1)], [], "task", "anna"), /wrong-channel/);
});

const historyPage = (from, to, beforeCursor) => ({
  messages: Array.from({ length: to - from + 1 }, (_, index) => message(from + index)),
  hasMore: beforeCursor !== null, beforeCursor,
});

test("a 200-message burst keeps missing middle pages reachable when initial history was complete", () => {
  const initial = historyPage(1, 10, null);
  const latest = historyPage(111, 210, "before-111");
  let known = initial.messages;
  let progress = observeHistoryHead(createHistoryProgress(initial), known, latest);
  known = mergeMessages(known, latest.messages, "task");
  assert.deepEqual(historyPageInfo(progress), { hasMore: true, beforeCursor: "before-111" });
  const middle = historyPage(11, 110, "before-11");
  progress = advanceHistory(progress, "before-111", known, middle);
  known = mergeMessages(known, middle.messages, "task");
  assert.equal(historyPageInfo(progress).beforeCursor, "before-11");
  const beginning = historyPage(1, 10, null);
  progress = advanceHistory(progress, "before-11", known, beginning);
  known = mergeMessages(known, beginning.messages, "task");
  assert.deepEqual(historyPageInfo(progress), { hasMore: false, beforeCursor: null });
  assert.deepEqual(known.map(item => item.id), Array.from({ length: 210 }, (_, index) => message(index + 1).id));
});

test("catch-up stops at an overlap, resumes the old history cursor and deduplicates repeated head polls", () => {
  const initial = historyPage(101, 200, "before-101");
  const latest = historyPage(311, 410, "before-311");
  let known = initial.messages;
  let progress = observeHistoryHead(createHistoryProgress(initial), known, latest);
  for (let i = 0; i < 20; i++) progress = observeHistoryHead(progress, known, latest);
  assert.equal(progress.cursors.length, 2);
  known = mergeMessages(known, latest.messages, "task");
  assert.equal(observeHistoryHead(progress, known, latest), progress);
  const middle = historyPage(211, 310, "before-211");
  progress = advanceHistory(progress, "before-311", known, middle);
  known = mergeMessages(known, middle.messages, "task");
  const overlap = historyPage(111, 210, "before-111");
  progress = advanceHistory(progress, "before-211", known, overlap);
  known = mergeMessages(known, overlap.messages, "task");
  assert.equal(historyPageInfo(progress).beforeCursor, "before-101");
  assert.equal(progress.cursors.length, 1);
  const beginning = historyPage(1, 100, null);
  progress = advanceHistory(progress, "before-101", known, beginning);
  known = mergeMessages(known, beginning.messages, "task");
  assert.equal(historyPageInfo(progress).hasMore, false);
  assert.equal(known.length, 410);
});

test("an older in-flight response cannot overwrite a newer queued gap cursor", () => {
  const initial = historyPage(101, 200, "before-101");
  const latest = historyPage(311, 410, "before-311");
  let progress = observeHistoryHead(createHistoryProgress(initial), initial.messages, latest);
  let known = mergeMessages(initial.messages, latest.messages, "task");
  const originalRequest = historyPage(1, 100, null);
  progress = advanceHistory(progress, "before-101", known, originalRequest);
  known = mergeMessages(known, originalRequest.messages, "task");
  assert.equal(historyPageInfo(progress).beforeCursor, "before-311");
  const newest = historyPage(511, 610, "before-511");
  progress = observeHistoryHead(progress, known, newest);
  known = mergeMessages(known, newest.messages, "task");
  progress = advanceHistory(progress, "before-311", known, historyPage(211, 310, "before-211"));
  assert.deepEqual(progress.cursors.map(cursor => cursor.value), ["before-511", "before-211"]);
});

test("message ordering uses time and a deterministic id tie break", () => {
  const older = message(2, { createdAt: "2026-11-18 00:00:01" });
  const newer = message(1, { createdAt: "2026-11-18T00:00:02Z" });
  assert.deepEqual(mergeMessages([], [newer, older], "task").map(item => item.id), [older.id, newer.id]);
  assert.deepEqual(mergeMessages([], [message(2, { createdAt: newer.createdAt }), newer], "task").map(item => item.id), [newer.id, "message-0002"]);
});

test("Unicode search handles Russian case, ё, composed accents, full width text and author names", () => {
  const messages = [message(1, { authorName: "Пётр", body: "Отчёт\nза неделю: Café ＡＩ" }), message(2, { body: "Другой разговор" })];
  assert.equal(searchMessages(messages, " ПЕТР   отчет ").length, 1);
  assert.equal(searchMessages(messages, "cafe\u0301 ai").length, 1);
  assert.equal(searchMessages(messages, "несуществующий").length, 0);
  assert.equal(searchMessages(messages, "\n  "), messages);
  assert.equal(normalizeMessageSearch(" ЁЖ\n  ＡＩ "), "еж ai");
});

test("new-message counters ignore loaded history, repeats and the viewer's own messages", () => {
  const previous = [message(5), message(6)];
  const next = mergeMessages(previous, [message(1), message(7), message(8, { authorId: "me" })], "task");
  assert.deepEqual(newIncomingIds(previous, next, "me"), [message(7).id]);
  assert.deepEqual(newIncomingIds(next, next, "me"), []);
});

test("safe URLs allow explicit http/https and reject executable, ambiguous and credential URLs", () => {
  for (const value of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "file:///tmp/a", "//example.com", "/relative", "https%3A//example.com",
    " https://example.com", "https://user:pass@example.com", "https://example.com\\evil", "https://example.com/\nfoo", "https://exa\u202emple.com", "https://example.com/\u2066x"]) {
    assert.equal(safeHttpUrl(value), null, value);
  }
  assert.equal(safeHttpUrl("https://example.com/path?q=1#section"), "https://example.com/path?q=1#section");
  assert.equal(safeHttpUrl("http://example.com"), "http://example.com/");
  assert.ok(safeHttpUrl("https://пример.рф/путь")?.startsWith("https://xn--"));
});

test("link detection preserves punctuation and all original text without linking code-like unsafe schemes", () => {
  const original = "Смотри (https://example.com/wiki/Test_(term)). Потом http://example.org/a, javascript:alert(1).";
  const parts = linkedTextParts(original);
  assert.equal(parts.map(part => part.text).join(""), original);
  assert.deepEqual(parts.filter(part => part.href).map(part => part.text), ["https://example.com/wiki/Test_(term)", "http://example.org/a"]);
  assert.equal(linkedTextParts("javascript:alert(1) data:text/html,<h1>x</h1>").some(part => part.href), false);
});

test("quote formatting prevents author line injection and quotes every body line", () => {
  assert.equal(formatQuote("Анна\r\nНовая строка", "Первый\r\nВторой"), "> Анна Новая строка:\n> Первый\n> Второй\n\n");
  assert.equal(formatQuote(" \n ", " "), "> Участник:\n> \n\n");
  const quoted = formatQuote("Бот", "😀".repeat(900));
  const excerpt = quoted.split("\n")[1].slice(2);
  assert.equal(Array.from(excerpt).length, 800);
  assert.ok(excerpt.endsWith("…"));
  assert.ok(!excerpt.includes("\ufffd"));
});

test("rich text parser preserves code literally and groups lists, quotes and ordinary paragraphs", () => {
  const blocks = parseMessageBlocks("Заголовок\nвторая строка\n\n- один\n- два\n\n1. первый\n2. второй\n\n> Анна:\n> цитата\n\n```js\n<script>unsafe()</script>\n  https://example.com\n```\nКонец");
  assert.deepEqual(blocks.map(block => block.type), ["paragraph", "list", "list", "quote", "code", "paragraph"]);
  assert.equal(blocks[1].ordered, false);
  assert.equal(blocks[2].ordered, true);
  assert.equal(blocks[3].text, "Анна:\nцитата");
  assert.equal(blocks[4].text, "<script>unsafe()</script>\n  https://example.com");
  assert.equal(blocks[4].language, "js");
  assert.equal(parseMessageBlocks("```\nunfinished\n  code")[0].text, "unfinished\n  code");
});

test("date separators and short time use the app timezone including day boundaries", () => {
  const boundary = "2026-11-17T18:00:00Z";
  assert.equal(messageDayKey(boundary), "2026-11-18");
  assert.equal(shortMessageTime(boundary), "01:00");
  assert.equal(messageDayLabel(boundary, new Date("2026-11-18T03:00:00Z")), "Сегодня");
  assert.equal(messageDayLabel(boundary, new Date("2026-11-19T03:00:00Z")), "Вчера");
  assert.equal(messageDayKey("invalid"), "unknown");
  assert.equal(shortMessageTime("invalid"), "");
});

test("authentication, permission and deleted-resource failures stop automatic retry; network failures remain retryable", () => {
  assert.deepEqual([401, 403, 404].map(status => feedIssueForStatus(status).kind), ["auth", "forbidden", "missing"]);
  for (const status of [401, 403, 404]) assert.equal(feedIssueForStatus(status).retryable, false);
  for (const status of [0, 429, 500, 503]) assert.equal(feedIssueForStatus(status).retryable, true);
});

test("feed payload validates history metadata and AI channel scope before rendering", () => {
  const valid = parseFeedPayload(payload({ hasMore: true, beforeCursor: "opaque-cursor", aiRuns: [run({})], aiPending: 2 }), "task");
  assert.equal(valid.beforeCursor, "opaque-cursor");
  assert.equal(valid.aiRuns[0].canRetry, true);
  assert.equal(valid.aiPending, 2);
  assert.throws(() => parseFeedPayload(payload({ hasMore: true }), "task"), /invalid-messages/);
  assert.throws(() => parseFeedPayload(payload({ messages: [{ ...message(1), body: 7 }] }), "task"), /invalid-messages/);
  assert.throws(() => parseFeedPayload(payload({ messages: [message(1, { taskId: "other" })] }), "task"), /wrong-channel/);
  assert.throws(() => parseFeedPayload(payload({ aiRuns: [run({ channelMemberId: "private" })] }), "task"), /wrong-channel/);
  assert.equal(parseFeedPayload(payload({ aiPending: -10 }), "task").aiPending, 0);
});

test("feed payload carries live write denial without treating readable history as a terminal failure",()=>{
  const result=parseFeedPayload(payload({canWrite:false}),"task");
  assert.equal(result.canWrite,false);assert.equal(result.messages.length,1);
  for(const value of [undefined,"true",1])assert.throws(()=>parseFeedPayload(payload({canWrite:value}),"task"),/invalid-messages/);
});

test("older-page stale AI output survives latest polling while refreshed page metadata replaces only its own runs",()=>{
  const old=run({id:"old",inputMessageId:"old-question",status:"stale",output:"Saved older answer"});
  const latest=run({id:"latest",inputMessageId:"new-question",status:"pending",error:null});
  let loaded=mergeChatAiRuns([], [latest], ["new-question"]);
  loaded=mergeChatAiRuns(loaded,[old],["old-question"]);
  loaded=mergeChatAiRuns(loaded,[{...latest,status:"succeeded",canRetry:false}],["new-question"]);
  assert.equal(loaded.find(item=>item.id==="old").output,"Saved older answer");
  assert.equal(loaded.find(item=>item.id==="latest").status,"succeeded");
  loaded=mergeChatAiRuns(loaded,[],["new-question"]);
  assert.deepEqual(loaded,[old]);
  assert.throws(()=>mergeChatAiRuns(loaded,[latest],["other-question"]),/wrong-ai-scope/);
  assert.throws(()=>mergeChatAiRuns(loaded,[{...old,channelMemberId:"private"}],["old-question"]),/wrong-ai-scope/);
  assert.throws(()=>parseFeedPayload(payload({aiRuns:[old]}),"task"),/wrong-ai-scope/);
});
