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
function ui({ state = {}, pending = false, imports = {} } = {}) {
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
      if (id === "react") return { ...React, useActionState: () => [state, action, pending] };
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
    vm.runInNewContext(code, { module: compiledModule, exports: compiledModule.exports, require: localRequire, console, URL, URLSearchParams, crypto, Date }, { filename });
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

test("external private chat explains background delivery and pending/sent states never promise a model response", () => {
  for (const options of [{}, { pending: true }, { state: { sentClientId: "message-client-id" } }]) {
    const h = ui(options);
    const { MessageComposer } = h.load("components/ruli/message-composer.tsx");
    const html = h.render(MessageComposer, composerProps({ channelMemberId: agent.memberId, privateBot: agent, bots: [agent] }));
    assert.match(html, /Grok Bot/);
    assert.match(html, /вебхук/);
    assert.doesNotMatch(html, /OpenAI|45 секунд|ждём AI/);
    if (options.pending) assert.match(html, /Сохраняем сообщение для передачи/);
    if (options.state) assert.match(html, /Доставка агенту и его ответ выполняются отдельно/);
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
