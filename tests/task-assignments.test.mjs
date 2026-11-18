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

const project = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const noop = () => {};
const members = [
  { id: "anna", name: "Анна", shortName: "Анна", role: "Маркетинг", initials: "АС", color: "rose", type: "human" },
  { id: "max", name: "Максим", shortName: "Макс", role: "Дизайн", initials: "МП", color: "blue", type: "human" },
  { id: "analyst", name: "Аналитик", shortName: "AI", role: "Аналитика", initials: "AI", color: "bot", type: "bot" },
];
const task = {
  id: "task", parentId: "root", kind: "leaf", title: 'План "Запуск" & проверка', description: 'Первая строка\nВторая: <сроки> & "условия"',
  ownerId: "anna", participants: ["analyst"], status: "todo", version: 17, children: [], size: "wide", theme: "cream",
  dueDate: "2026-12-15", dueLabel: "15 декабря", priority: "high", result: null,
};
const root = { ...task, id: "root", parentId: null, kind: "group", children: [task], status: null };

// Real assignments, view role gates, Avatar and SubmitButton are rendered.
// Inject action lifecycle only; no write, external API or real session is used.
function harness({ state = {}, pending = false } = {}) {
  const imports = {
    react: { ...React, useActionState: () => [state, noop, pending] },
    "react-dom": { ...ReactDOM, useFormStatus: () => ({ pending }) },
    "next/link": { __esModule: true, default: props => React.createElement("a", props) },
    "@/app/actions": { updateTaskState: noop, nestTask: noop, unnestTask: noop, moveTask: noop, setStatus: noop, retryBotWebhook: noop },
    "@/lib/ruli/access": { canManage: viewer => viewer.role === "manager" },
    "@/lib/ruli/ai": { loadTaskAi: async () => ({ bots: [], runs: [], chatRuns: [] }) },
    "./collaboration": { TaskCollaboration: () => React.createElement("section", { id: "discussion" }) },
    "./ai-task": { TaskAiPanel: () => null },
    "./result-form": { ResultForm: () => null },
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
  const { TaskAssignments } = load("components/ruli/task-assignments.tsx");
  return { load, render: (node = task, mode = "view") => renderToStaticMarkup(React.createElement(TaskAssignments, { node, mode, members })) };
}
const decode = value => value.replace(/&(amp|quot|lt|gt|#x27|#39);/g, (_, code) => ({ amp: "&", quot: '"', lt: "<", gt: ">", "#x27": "'", "#39": "'" })[code]);
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name, decode(value)]));
const inputs = html => [...html.matchAll(/<input\b[^>]*>/g)].map(([tag]) => attributes(tag));

test("assignment management is visible in normal task and group views only to managers, never on the home page", async () => {
  for (const role of ["manager", "executor", "viewer"]) {
    for (const kind of ["leaf", "group", "root"]) {
      const h = harness();
      const { GroupView, DetailView } = h.load("components/ruli/views.tsx");
      const node = kind === "root" ? root : { ...task, kind };
      const props = { node, path: kind === "root" ? [root] : [root, node], members, mode: "view", today: "2026-11-18", viewer: { role, memberId: "anna", userId: "user-anna" } };
      const element = kind === "leaf" ? await DetailView(props) : React.createElement(GroupView, props);
      const html = renderToStaticMarkup(element);
      if (role === "manager" && kind !== "root") {
        assert.match(html, /id="task-team"/);
        assert.match(html, /Добавить сотрудников и ботов/);
        assert.match(html, /href="#task-team"/);
      } else assert.doesNotMatch(html, /id="task-team"|href="#task-team"|Добавить сотрудников и ботов|Сохранить участников/);
    }
  }
});

test("the assignments form preserves the version and all unrelated editable task metadata", () => {
  const h = harness();
  for (const node of [task, { ...task, kind: "group", dueDate: null, priority: null }]) {
    const hidden = Object.fromEntries(inputs(h.render(node, "build")).filter(input => input.type === "hidden").map(input => [input.name, input.value]));
    assert.deepEqual(hidden, {
      id: node.id, version: "17", mode: "build", title: node.title, description: node.description,
      due: node.dueDate ?? "", priority: node.priority ?? "", size: "wide", theme: "cream",
    });
    assert.ok(!Object.hasOwn(hidden, "status"));
  }
});

test("human and bot choices are separated and the current owner is checked and cannot be deselected", () => {
  const h = harness();
  for (const node of [task, { ...task, ownerId: "analyst", participants: ["max"] }]) {
    const html = h.render(node);
    const fields = [...html.matchAll(/<fieldset>([\s\S]*?)<\/fieldset>/g)].map(([, body]) => body);
    assert.equal(fields.length, 2);
    assert.match(fields[0], /<legend>Сотрудники<\/legend>/);
    assert.match(fields[1], /<legend>AI-боты<\/legend>/);
    assert.deepEqual(inputs(fields[0]).map(input => input.value), ["anna", "max"]);
    assert.deepEqual(inputs(fields[1]).map(input => input.value), ["analyst"]);
    const choices = inputs(html).filter(input => input.name === "participants");
    for (const choice of choices) {
      assert.equal(Object.hasOwn(choice, "checked"), choice.value === node.ownerId || node.participants.includes(choice.value));
      assert.equal(Object.hasOwn(choice, "disabled"), choice.value === node.ownerId);
    }
    const selected = [...html.matchAll(/<option\b([^>]*)>/g)].map(([, attrs]) => attributes(attrs)).filter(option => Object.hasOwn(option, "selected"));
    assert.deepEqual(selected.map(option => option.value), [node.ownerId]);
  }
});

test("assignment controls link to employee registration, bot creation and this task's discussion", () => {
  const html = harness().render();
  assert.match(html, /href="\/team#register-employee"[^>]*>Зарегистрировать сотрудника/);
  assert.match(html, /href="\/team#create-bot"[^>]*>Создать бота/);
  assert.match(html, /href="#discussion"[^>]*>Открыть чаты/);
});

test("pending assignments cannot be submitted twice and conflicts offer a task-local refresh link", () => {
  const pending = harness({ pending: true }).render();
  const submit = pending.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0];
  assert.ok(submit);
  assert.match(submit, /disabled=""/);
  const conflicted = harness({ state: { error: "Задача изменилась в другой вкладке." } }).render(task, "build");
  assert.match(conflicted, /role="alert"/);
  assert.match(conflicted, /Задача изменилась в другой вкладке/);
  assert.match(conflicted, /href="\/t\/task\?mode=build#task-team"/);
  assert.equal(inputs(conflicted).find(input => input.name === "version").value, "17");
});
