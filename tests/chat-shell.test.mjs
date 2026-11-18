import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as model from "../lib/ruli/model.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const human = { id: "anna", name: "Анна", shortName: "Анна", role: "Маркетинг", initials: "АС", color: "rose", type: "human" };
const bot = { id: "analyst", name: "Исследователь", shortName: "AI", role: "Аналитика", initials: "AI", color: "bot", type: "bot" };
const node = { id: "task", title: "Рабочая задача", kind: "leaf", children: [], participants: [], ownerId: "anna", version: 1 };

function harness({ channels = [human, bot], viewerRole = "manager", bots = [], runs = [] } = {}) {
  const captured = { feed: [], composer: [], channels: [] };
  const imports = {
    "next/link": { __esModule: true, default: props => React.createElement("a", props) },
    "@/lib/ruli/collaboration": { loadTaskCollaboration: async (_node, _viewer, selected) => {
      captured.channels.push(selected);
      return { channels, messages: [], messagePage: { hasMore: false, beforeCursor: null }, entries: [], scheduleVersion: 0 };
    } },
    "@/lib/ruli/access": { canManage: viewer => viewer.role === "manager" },
    "@/lib/ruli/model": model,
    "@/lib/ruli/ai": { loadTaskAi: async () => ({ bots, chatRuns: runs }) },
    "./submit-button": { SubmitButton: ({ children }) => React.createElement("button", null, children) },
    "./message-feed": { MessageFeed: props => { captured.feed.push(props); return React.createElement("div", { className: "message-feed" }); } },
    "./message-composer": { MessageComposer: props => { captured.composer.push(props); return React.createElement("div", { className: "message-form" }); } },
    "./chat.css": {},
  };
  const cache = new Map();
  function load(relative) {
    const filename = path.resolve(root, relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const compiled = { exports: {} };
    cache.set(filename, compiled);
    const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const localRequire = id => Object.hasOwn(imports, id) ? imports[id]
      : id === "./chat-channels" ? load("components/ruli/chat-channels.tsx") : require(id);
    vm.runInNewContext(source, { module: compiled, exports: compiled.exports, require: localRequire, crypto, console }, { filename });
    return compiled.exports;
  }
  return { captured, async render(channel) {
    const { TaskCollaboration } = load("components/ruli/collaboration.tsx");
    return renderToStaticMarkup(await TaskCollaboration({
      node, members: [human, bot], channel,
      viewer: { userId: "viewer-user", memberId: viewerRole === "executor" ? "anna" : "me", role: viewerRole, displayName: "Viewer" },
    }));
  } };
}

test("chat shell projects AI run metadata without exposing stored output or requester identity", async () => {
  const run = { id: "run", botMemberId: "analyst", channelMemberId: "analyst", inputMessageId: "message", error: null,
    status: "failed", canRetry: true, createdAt: "2026-11-18T01:00:00Z", finishedAt: "2026-11-18T01:01:00Z",
    output: "PRIVATE_STORED_OUTPUT", requesterUserId: "PRIVATE_REQUESTER_ID", kind: "chat", taskId: "task" };
  const h = harness({ runs: [run] });
  await h.render("analyst");
  const passed = h.captured.feed[0].initialAiRuns;
  assert.deepEqual(Object.keys(passed[0]).sort(), ["id", "botMemberId", "channelMemberId", "inputMessageId", "error", "status", "canRetry", "createdAt", "finishedAt"].sort());
  assert.doesNotMatch(JSON.stringify(h.captured.feed), /PRIVATE_STORED_OUTPUT|PRIVATE_REQUESTER_ID/);
});

test("executor sees the manager conversation and inaccessible channels fall back before rendering", async () => {
  const h = harness({ channels: [human], viewerRole: "executor" });
  const html = await h.render("anna");
  assert.doesNotMatch(html, /id="schedule"|href="#schedule"|График|график/);
  assert.match(html, /С руководителем/);
  assert.match(html, /Ваш личный диалог с руководителем/);
  assert.doesNotMatch(html, /личный · Анна/);
  assert.equal(h.captured.feed[0].channelMemberId, "anna");
  assert.equal(h.captured.composer[0].channelMemberId, "anna");
  const denied = harness({ channels: [human], viewerRole: "executor" });
  const fallback = await denied.render("other-private-channel");
  assert.match(fallback, /Этот личный диалог недоступен/);
  assert.deepEqual(denied.captured.channels, ["other-private-channel", undefined]);
  assert.equal(denied.captured.feed[0].channelMemberId, undefined);
  assert.equal(denied.captured.composer[0].channelMemberId, undefined);
});

test("read-only chat has no composer and agent badges describe configuration rather than presence", async () => {
  const viewer = harness({ channels: [], viewerRole: "viewer" });
  const html = await viewer.render();
  assert.equal(viewer.captured.composer.length, 0);
  assert.equal(viewer.captured.feed[0].canWrite, false);
  assert.match(html, /доступ для просмотра/);
  assert.doesNotMatch(html, /id="schedule"|href="#schedule"|График|график/);
  assert.match(html, /aria-label="Обсуждение задачи"/);
  assert.match(html, /href="#task-title"/);
  for (const [extra, label] of [
    [{ enabled: true, configured: true, ready: true }, "Настроен"],
    [{ enabled: false, configured: true, ready: false }, "Выключен"],
    [{ enabled: true, configured: false, ready: false }, "Нет подключения"],
  ]) {
    const h = harness({ bots: [{ memberId: "analyst", name: "Исследователь", kind: "agent", provider: "grok-bot", slug: "research", model: "-", disabledReason: null, ...extra }] });
    const rendered = await h.render("analyst");
    assert.match(rendered, new RegExp(label));
    assert.match(rendered, /Grok Bot/);
    assert.doesNotMatch(rendered, /id="schedule"|href="#schedule"|График|график/);
    assert.doesNotMatch(rendered, /В сети|Онлайн|online|прочитано|прикрепить файл/i);
  }
});
