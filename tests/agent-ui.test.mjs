import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import React from "react";
import * as ReactDOM from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const action = () => {};
const canManage = viewer => viewer.role === "manager";

// Render the actual TSX. Only framework actions/identity and action lifecycle
// are injected; no database, browser, provider or webhook is contacted.
function ui({ state = {}, pending = false, imports = {}, globals = {}, effects } = {}) {
  const cache = new Map();
  function load(relative) {
    let filename = path.resolve(root, relative);
    if (!path.extname(filename)) filename = [".tsx", ".ts"].map(ext => filename + ext).find(fs.existsSync);
    if (!filename) throw new Error(`Module not found: ${relative}`);
    if (cache.has(filename)) return cache.get(filename).exports;
    const compiledModule = { exports: {} };
    cache.set(filename, compiledModule);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    function localRequire(id) {
      if (Object.hasOwn(imports, id)) return imports[id];
      if (id === "react") return { ...React, useActionState: () => [state, action, pending], ...(effects?{useEffect:effect=>effects.push(effect)}:{}) };
      if (id === "react-dom") return { ...ReactDOM, useFormStatus: () => ({ pending }) };
      if (id === "next/link") return { __esModule: true, default: props => React.createElement("a", props) };
      if (id === "next/navigation") return { notFound: () => { throw new Error("Not found"); } };
      if (id === "@/app/actions") return { retryBotWebhook: action, nestTask: action, unnestTask: action, moveTask: action, setStatus: action };
      if (id === "@/app/ai-actions") return { runTaskAiState: action, retryAiChatState: action };
      if (id === "@/app/collaboration-actions") return { sendMessageState: action };
      if (id === "@/lib/ruli/access") return { canManage };
      if (id === "@/lib/ruli/ai") return { loadTaskAi: async () => ({ bots: [], runs: [], chatRuns: [] }) };
      if (id === "./collaboration") return { TaskCollaboration: () => null };
      if (id.endsWith(".css")) return {};
      if (id.startsWith("@/")) return load(id.slice(2));
      if (id.startsWith(".")) return load(path.resolve(path.dirname(filename), id));
      return require(id);
    }
    vm.runInNewContext(code, { module: compiledModule, exports: compiledModule.exports, require: localRequire, console, URL, URLSearchParams, crypto, Date, ...globals }, { filename });
    return compiledModule.exports;
  }
  return { load, render: (Component, props) => renderToStaticMarkup(React.createElement(Component, props)) };
}

const agent = {
  memberId: "agent-vk", name: "VK Agent", provider: "grok-bot", kind: "agent", model: "-", slug: "vk",
  enabled: true, configured: true, ready: true, disabledReason: null,
};
const delivery = (id, status, extra = {}) => ({
  id, event: "message.created", taskId: "task", botMemberId: "agent-vk", botSlug: "vk", status,
  payload: "PRIVATE_PAYLOAD_SENTINEL", attempts: 1, lastError: status === "failed" ? "Вебхук ответил 503." : null,
  createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:01.000Z", ...extra,
});
const deliveryProps = rows => ({ rows, manager: true, taskId: "task", version: 3, mode: "view" });
const panelProps = bot => ({ taskId: "task", version: 3, manager: true, clientId: "request-client-id", data: { bot, bots: [bot], runs: [], canRun: true, disabledReason: "External webhook agent" } });
const composerProps = extra => ({ taskId: "task", viewerUserId: "manager", clientId: "message-client-id", mode: "view", ...extra });

test("delivery UI keeps each failed event retryable after later successes and shows pending delivery", () => {
  const h = ui();
  const { BotDeliveryStatus } = h.load("components/ruli/bot-delivery.tsx");
  const html = h.render(BotDeliveryStatus, deliveryProps([
    delivery("success-later", "delivered"),
    delivery("failed-one", "failed"),
    delivery("pending-one", "pending", { botSlug: "dzen" }),
    delivery("failed-two", "failed", { botSlug: "telegram" }),
  ]));
  assert.equal((html.match(/name="eventId"/g) || []).length, 2);
  assert.match(html, /name="eventId" value="failed-one"/);
  assert.match(html, /name="eventId" value="failed-two"/);
  assert.doesNotMatch(html, /name="eventId" value="(?:success-later|pending-one)"/);
  assert.match(html, /Передаём боту/);
  assert.match(html, /Обновить статус доставки/);
  assert.match(html, /Вебхук ответил 503/);
  assert.doesNotMatch(html, /PRIVATE_PAYLOAD_SENTINEL/);
});

test("delivery metadata projection excludes payload and non-managers receive no delivery UI", () => {
  const h = ui();
  const { BotDeliveryStatus, deliverySummaries } = h.load("components/ruli/bot-delivery.tsx");
  const rows = deliverySummaries([delivery("failed-private", "failed")]);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["id", "event", "status", "botSlug", "lastError", "createdAt"].sort());
  assert.equal(h.render(BotDeliveryStatus, { ...deliveryProps(rows), manager: false }), "");
  assert.equal(h.render(BotDeliveryStatus, deliveryProps([])), "");
});

test("external agent task panel identifies Grok Bot without offering a model run or an OpenAI promise", () => {
  const h = ui();
  const { TaskAiPanel } = h.load("components/ruli/ai-task.tsx");
  const html = h.render(TaskAiPanel, panelProps(agent));
  assert.match(html, /Внешний агент/);
  assert.match(html, /Grok Bot/);
  assert.match(html, /вебхук/);
  assert.doesNotMatch(html, /OpenAI|45 секунд|<form|Выполнить с AI/);
  const disabled = h.render(TaskAiPanel, panelProps({ ...agent, ready: false, enabled: false, disabledReason: "Бот выключен." }));
  assert.match(disabled, /Бот выключен/);
  assert.match(disabled, /Настроить бота/);
});

test("model task panels retain their own provider and execution button", () => {
  const h = ui();
  const { TaskAiPanel } = h.load("components/ruli/ai-task.tsx");
  for (const [provider, label] of [["xai", "xAI · Grok"], ["openai", "OpenAI"]]) {
    const html = h.render(TaskAiPanel, panelProps({ ...agent, provider, kind: "llm", model: "test-model", slug: null }));
    assert.ok(html.includes(label));
    assert.match(html, /Выполнить с AI/);
    assert.match(html, /<form/);
    assert.doesNotMatch(html, /Внешний агент/);
  }
});

test("external private composer leaves AI disclosure in the header and never promises a model response", () => {
  for (const options of [{}, { pending: true }, { state: { sentClientId: "message-client-id" } }]) {
    const h = ui(options);
    const { MessageComposer } = h.load("components/ruli/message-composer.tsx");
    const html = h.render(MessageComposer, composerProps({ channelMemberId: agent.memberId, privateBot: agent, bots: [agent] }));
    assert.match(html, /Внешний агент/);
    assert.doesNotMatch(html, /Как работает AI/);
    assert.doesNotMatch(html, /OpenAI|45 секунд|ждём AI/);
    if (options.pending) assert.match(html, /Отправляем сообщение/);
    if (options.state) assert.match(html, /Ответ агента появится после обработки/);
  }
});

test("general chat describes agent fan-out and offers only model bots in the response selector", () => {
  const h = ui();
  const { MessageComposer } = h.load("components/ruli/message-composer.tsx");
  const html = h.render(MessageComposer, composerProps({ bots: [agent, { ...agent, memberId: "llm", name: "Model Bot", kind: "llm", provider: "xai", model: "test-model" }] }));
  assert.match(html, /Сообщение команде/);
  assert.match(html, /автоматически передаются/);
  assert.match(html, /не ограничивает этих получателей/);
  assert.match(html, /личный чат/);
  assert.match(html, /<option value="llm"/);
  assert.doesNotMatch(html, /<option value="agent-vk"|Без AI|OpenAI/);
  const externalOnly = h.render(MessageComposer, composerProps({ bots: [agent] }));
  assert.doesNotMatch(externalOnly, /<select|Выбор AI-бота выше/);
  assert.match(externalOnly, /личный чат/);
});

test("private agent chat identifies a missing webhook and prevents sending", () => {
  const h = ui();
  const { MessageComposer } = h.load("components/ruli/message-composer.tsx");
  const bot = { ...agent, ready: false, configured: false, disabledReason: "Вебхук не настроен." };
  const html = h.render(MessageComposer, composerProps({ channelMemberId: bot.memberId, privateBot: bot, bots: [bot] }));
  assert.match(html, /Вебхук не настроен/);
  assert.match(html, /<button[^>]*disabled=""/);
  assert.doesNotMatch(html, /нужен ключ|OpenAI|45 секунд/);
});

test("composer allows typing the next draft during an AI request without allowing duplicate submission", () => {
  const snapshot={draft:{body:"Следующий вопрос",clientId:"new-draft-revision"},persistent:true};
  const store={subscribe:()=>()=>{},getSnapshot:()=>snapshot,getServerSnapshot:()=>snapshot};
  const h=ui({pending:true,imports:{"./chat-draft-store":{getDraftStore:()=>store}}});
  const {MessageComposer}=h.load("components/ruli/message-composer.tsx");
  const html=h.render(MessageComposer,composerProps({privateBot:{...agent,kind:"llm",provider:"openai",model:"test-model"}}));
  assert.match(html,/Следующий вопрос/);
  assert.doesNotMatch(html,/<textarea[^>]*disabled/);
  assert.match(html,/<button[^>]*class="composer-send"[^>]*disabled=""/);
  assert.match(html,/Можно набирать следующий черновик/);
});

test("composer disables whitespace-only drafts and keeps a nonempty draft sendable", () => {
  for(const [body,disabled] of [["   \n  ",true],["Готово к отправке",false]]) {
    const snapshot={draft:{body,clientId:"draft-revision"},persistent:true};
    const store={subscribe:()=>()=>{},getSnapshot:()=>snapshot,getServerSnapshot:()=>snapshot};
    const h=ui({imports:{"./chat-draft-store":{getDraftStore:()=>store}}});
    const {MessageComposer}=h.load("components/ruli/message-composer.tsx");
    const html=h.render(MessageComposer,composerProps({}));
    const button=html.match(/<button[^>]*class="composer-send"[^>]*>/)?.[0]??"";
    assert.ok(button);
    assert.equal(button.includes('disabled=""'),disabled);
  }
});

function browserDrafts() {
  const saved=new Map();
  const window={sessionStorage:{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)}};
  const fresh=()=>ui({globals:{window}}).load("components/ruli/chat-draft-store.ts");
  return {saved,window,fresh};
}

test("failed submitted text and the newer draft persist together across reload and another send", () => {
  const browser=browserDrafts();
  const key="draft:account:task:channel";
  const store=browser.fresh().getDraftStore(key,"initial-draft-id");
  store.edit("Неотправленное сообщение A");
  const submitted={...store.getSnapshot().draft};
  store.edit("Новый черновик B");
  const newer={...store.getSnapshot().draft};
  store.preserveUnsent(submitted);
  store.preserveUnsent(submitted);
  assert.equal(store.getSnapshot().unsent.length,1);
  const reloaded=browser.fresh().getDraftStore(key,"reload-fallback-id");
  assert.equal(reloaded.getSnapshot().draft.body,newer.body);
  assert.equal(reloaded.getSnapshot().draft.clientId,newer.clientId);
  assert.equal(reloaded.getSnapshot().unsent[0].body,submitted.body);
  reloaded.acknowledge(newer.clientId);
  const afterSend=browser.fresh().getDraftStore(key,"another-fallback-id");
  assert.equal(afterSend.getSnapshot().draft.body,"");
  assert.equal(afterSend.getSnapshot().unsent[0].body,submitted.body);
  assert.equal(afterSend.restoreUnsent(submitted.clientId),"restored");
  assert.equal(afterSend.getSnapshot().draft.body,submitted.body);
  assert.equal(afterSend.getSnapshot().draft.clientId,submitted.clientId);
  assert.equal(afterSend.getSnapshot().unsent.length,0);
  assert.equal(browser.fresh().getDraftStore("another-account:task:channel","other-fallback-id").getSnapshot().unsent.length,0);
});

test("restoring a failed message appends safely or retains both texts when the limit is exceeded", () => {
  const browser=browserDrafts();
  const store=browser.fresh().getDraftStore("draft-limit-key","initial-draft-id");
  store.edit("Новый черновик B");
  store.preserveUnsent({body:"Сообщение A",clientId:"failed-message-a"});
  assert.equal(store.restoreUnsent("failed-message-a"),"restored");
  assert.equal(store.getSnapshot().draft.body,"Новый черновик B\n\nСообщение A");
  store.edit("B".repeat(4500));
  store.preserveUnsent({body:"A".repeat(1000),clientId:"failed-message-long"});
  assert.equal(store.restoreUnsent("failed-message-long"),"too-long");
  const reloaded=browser.fresh().getDraftStore("draft-limit-key","reloaded-draft-id");
  assert.equal(reloaded.getSnapshot().draft.body,"B".repeat(4500));
  assert.equal(reloaded.getSnapshot().unsent[0].body,"A".repeat(1000));
  reloaded.discardUnsent("failed-message-long");
  assert.equal(reloaded.getSnapshot().draft.body,"B".repeat(4500));
  assert.equal(reloaded.getSnapshot().unsent.length,0);
});

test("a delayed acknowledgment removes only the matching recovery text and preserves the current draft", () => {
  const browser=browserDrafts();
  const store=browser.fresh().getDraftStore("late-ack-key","initial-draft-id");
  store.edit("Новый черновик B");
  store.preserveUnsent({body:"Сообщение A",clientId:"failed-message-a"});
  store.preserveUnsent({body:"Сообщение C",clientId:"failed-message-c"});
  store.acknowledge("failed-message-a");
  assert.equal(store.getSnapshot().draft.body,"Новый черновик B");
  assert.equal(store.getSnapshot().unsent.length,1);
  assert.equal(store.getSnapshot().unsent[0].body,"Сообщение C");
});

test("storage failure retains recovery and the new draft in memory and reports nonpersistent state", () => {
  const window={sessionStorage:{getItem:()=>null,setItem:()=>{throw new Error("storage blocked");},removeItem:()=>{throw new Error("storage blocked");}}};
  const store=ui({globals:{window}}).load("components/ruli/chat-draft-store.ts").getDraftStore("blocked-storage-key","initial-draft-id");
  store.edit("Новый черновик B");
  store.preserveUnsent({body:"Сообщение A",clientId:"failed-message-a"});
  assert.equal(store.getSnapshot().persistent,false);
  assert.equal(store.getSnapshot().draft.body,"Новый черновик B");
  assert.equal(store.getSnapshot().unsent[0].body,"Сообщение A");
});

test("composer captures the rejected submitted revision separately and renders recovery without overwriting the new draft", () => {
  const effects=[];
  const preserved=[];
  const snapshot={draft:{body:"Новый черновик B",clientId:"new-draft-revision"},unsent:[{body:"Сообщение A",clientId:"failed-message-a"}],persistent:true};
  const store={subscribe:()=>()=>{},getSnapshot:()=>snapshot,getServerSnapshot:()=>snapshot,preserveUnsent:draft=>preserved.push(draft)};
  const h=ui({state:{error:"Отправка отклонена.",values:{body:"Сообщение A",clientId:"failed-message-a"}},effects,imports:{"./chat-draft-store":{getDraftStore:()=>store}}});
  const {MessageComposer}=h.load("components/ruli/message-composer.tsx");
  const html=h.render(MessageComposer,composerProps({}));
  effects[1]();
  assert.equal(preserved[0].body,"Сообщение A");
  assert.equal(preserved[0].clientId,"failed-message-a");
  assert.match(html,/name="body"[^>]*>Новый черновик B<\/textarea>/);
  assert.match(html,/readonly=""[^>]*>Сообщение A<\/textarea>/i);
  assert.match(html,/Добавить к черновику/);
  assert.match(html,/Копировать/);
  assert.match(html,/Удалить сохранённый текст/);
  assert.doesNotMatch(html,/Сообщение остаётся в форме/);
});

test("root, group and task pages fetch delivery metadata only for a manager and strip private payloads", async () => {
  for (const role of ["manager", "executor", "viewer"]) {
    for (const kind of ["root", "group", "leaf"]) {
      const node = { id: kind === "root" ? "root" : "task", kind: kind === "root" ? "group" : kind };
      const calls = [];
      const h = ui({ imports: {
        "@/components/ruli/views": { GroupView: "group-view", DetailView: "detail-view" },
        "@/lib/ruli/data": { getMembers: async () => [], loadTree: async () => node },
        "@/lib/ruli/access": { canManage, requireAccess: async () => ({ role }) },
        "@/lib/ruli/model": { taskHref: id => `/t/${id}`, todayISO: () => "2026-11-18", findPath: () => [node] },
        "@/lib/ruli/agent-runtime": { listTaskDeliveries: async (_db, id) => { calls.push(id); return [delivery("failed-private", "failed")]; } },
        "@/db": { getD1: () => ({}) },
      } });
      const { default: Page } = h.load(kind === "root" ? "app/page.tsx" : "app/t/[id]/page.tsx");
      const element = await Page({ params: Promise.resolve({ id: node.id }), searchParams: Promise.resolve({}) });
      assert.equal(calls.length, role === "manager" ? 1 : 0, `${role}/${kind}`);
      assert.equal(element.props.deliveries.length, role === "manager" ? 1 : 0);
      assert.ok(!JSON.stringify(element.props.deliveries).includes("PRIVATE_PAYLOAD_SENTINEL"));
    }
  }
});

test("group and root views render delivery failures and retry controls", () => {
  const h = ui();
  const { GroupView } = h.load("components/ruli/views.tsx");
  for (const id of ["root", "group"]) {
    const node = { id, kind: "group", title: "Группа", ownerId: "me", participants: [], children: [], version: 1, dueDate: null, dueLabel: "Без срока" };
    const html = h.render(GroupView, {
      node, path: [node], members: [], today: "2026-11-18", viewer: { role: "manager", memberId: "me" }, mode: "view",
      deliveries: [delivery("group-failure", "failed")],
    });
    assert.match(html, /Не доставлено боту/);
    assert.match(html, /name="eventId" value="group-failure"/);
  }
});
