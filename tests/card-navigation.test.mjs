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

const project = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const noop = () => {};
const human = { id: "anna", name: "Анна", shortName: "Анна", role: "Маркетинг", initials: "АС", color: "rose", type: "human" };
const bot = { id: "analyst", name: "Аналитик", shortName: "AI", role: "Аналитика", initials: "AI", color: "bot", type: "bot" };
const makeNode = (id, extra = {}) => ({
  id, parentId: "root", kind: "leaf", title: `Задача ${id}`, ownerId: "anna", participants: ["analyst"],
  status: "todo", version: 1, children: [], size: "wide", theme: "teal", dueDate: null, dueLabel: "Без срока",
  description: "Описание задачи", result: null, ...extra,
});
const leaf = makeNode("leaf");
const group = makeNode("group", { kind: "group", title: "Рабочая группа", status: null, children: [makeNode("child", { parentId: "group" })] });
const root = makeNode("root", { parentId: null, kind: "group", title: "Задачи команды", status: null, children: [group, leaf] });
const viewer = { userId: "manager-user", memberId: "me", role: "manager" };
const viewProps = node => ({ node, path: node.id === "root" ? [root] : [root, node], mode: "view", members: [human, bot], today: "2026-11-18", viewer });

// Render the actual cards/views and participant controls. Only server boundaries
// and unrelated forms are replaced; native link and nested-control markup is real.
function harness() {
  const chatCalls = [];
  const imports = {
    "next/link": { __esModule: true, default: props => React.createElement("a", props) },
    "@/app/actions": { nestTask: noop, unnestTask: noop, moveTask: noop, setStatus: noop, retryBotWebhook: noop },
    "@/lib/ruli/access": { canManage: access => access.role === "manager" },
    "@/lib/ruli/ai": { loadTaskAi: async () => ({ bots: [], runs: [], chatRuns: [] }) },
    "./collaboration": { TaskCollaboration: props => { chatCalls.push(props); return React.createElement("section", { id: "discussion", "data-task-chat": props.node.id }); } },
    "./ai-task": { TaskAiPanel: () => null },
    "./result-form": { ResultForm: () => React.createElement("div", { "data-result-form": true }) },
    "./task-assignments": { TaskAssignments: () => React.createElement("div", { "data-task-assignments": true }) },
    "./submit-button": { SubmitButton: ({ children, ...props }) => { delete props.pendingLabel; return React.createElement("button", props, children); } },
  };
  const cache = new Map();
  function load(relative) {
    let filename = path.resolve(project, relative);
    if (!path.extname(filename)) filename = [".tsx", ".ts"].map(ext => filename + ext).find(fs.existsSync);
    if (!filename) throw new Error(`Module not found: ${relative}`);
    if (cache.has(filename)) return cache.get(filename).exports;
    const compiledModule = { exports: {} };
    cache.set(filename, compiledModule);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const localRequire = id => Object.hasOwn(imports, id) ? imports[id]
      : id.endsWith(".css") ? {} : id.startsWith("@/") ? load(id.slice(2))
      : id.startsWith(".") ? load(path.resolve(path.dirname(filename), id)) : require(id);
    vm.runInNewContext(code, { module: compiledModule, exports: compiledModule.exports, require: localRequire, crypto, console }, { filename });
    return compiledModule.exports;
  }
  return { chatCalls, ...load("components/ruli/views.tsx") };
}
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test("the home overview contains navigable task blocks without root chat, schedule, section tabs or delivery controls", () => {
  for (const mode of ["view", "build"]) {
    const h = harness();
    const html = render(h.GroupView, { ...viewProps(root), mode, deliveries: [{ id: "root-failure", event: "message.created", status: "failed", botSlug: "bot", lastError: "Delivery failed", createdAt: "2026-11-18T00:00:00Z" }] });
    assert.equal(h.chatCalls.length, 0);
    assert.match(html, /class="[^"]*bento-grid/);
    for (const node of [group, leaf]) assert.ok(html.includes(`href="/t/${node.id}?mode=${mode}"`));
    assert.doesNotMatch(html, /data-task-chat|class="task-contents"|href="#(?:discussion|schedule)"|id="(?:collaboration|discussion|schedule)"|class="bot-delivery"|root-failure|class="attention-summary"/);
  }
});

test("opening a nested group or a leaf keeps its own discussion and selected channel", async () => {
  for (const role of ["manager", "executor", "viewer"]) {
    for (const node of [group, leaf]) {
      const h = harness();
      const props = { ...viewProps(node), viewer: { ...viewer, role }, channel: "anna" };
      const html = node.kind === "group" ? render(h.GroupView, props) : renderToStaticMarkup(await h.DetailView(props));
      assert.equal(h.chatCalls.length, 1, `${role}/${node.kind}`);
      assert.equal(h.chatCalls[0].node.id, node.id);
      assert.equal(h.chatCalls[0].channel, "anna");
      assert.match(html, /id="discussion"/);
      assert.doesNotMatch(html, /href="#schedule"|id="schedule"|График выполнения/);
    }
  }
});

test("task and group cards expose a native named link in viewing and structure modes", () => {
  const h = harness();
  for (const node of [group, leaf]) {
    for (const mode of ["view", "build"]) {
      const html = render(h.TaskCard, { ...viewProps(node), mode, index: 1, siblingCount: 3 });
      const links = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
      const open = links.filter(([, attributes]) => /class="[^"]*\bblock-open\b/.test(attributes));
      assert.equal(open.length, 1, `${node.kind}/${mode}`);
      assert.ok(open[0][1].includes(`href="/t/${node.id}?mode=${mode}"`));
      assert.ok(open[0][1].includes(node.title));
      assert.match(open[0][1], /aria-label="Открыть /);
      assert.doesNotMatch(open[0][1], /role="button"|tabindex="-1"/i);
    }
  }
});

test("card participant popovers and structure actions remain independent native targets outside its open link", () => {
  const h = harness();
  for (const node of [group, leaf]) {
    const html = render(h.TaskCard, { ...viewProps(node), mode: "build", index: 1, siblingCount: 3 });
    assert.equal([...html.matchAll(/<summary\b/g)].length, 2);
    assert.match(html, /aria-label="Люди: 1\./);
    assert.match(html, /aria-label="Боты: 1\./);
    assert.match(html, /href="\/t\/(?:group|leaf)\/edit\?mode=build"/);
    assert.match(html, /<button[^>]*aria-label="Переместить раньше:/);
    assert.match(html, /<button[^>]*aria-label="Переместить позже:/);
    for (const [, , content] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
      assert.doesNotMatch(content, /<(?:a|button|summary|details|form|input|select|textarea)\b/i);
    }
  }
});
