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
import { collaborationHarness, TestRedirect } from "./collaboration-helper.mjs";
import * as mutations from "../lib/ruli/mutations.ts";

const project = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const noop = () => {};
const members = [{ id: "anna", name: "Анна", shortName: "Анна", role: "Маркетинг", initials: "АС", color: "rose", type: "human" }];
const node = { id: "task", parentId: "group", kind: "leaf", title: "Рабочая задача", ownerId: "anna", participants: ["max"],
  status: "todo", version: 7, children: [], size: "wide", theme: "teal", dueDate: null, dueLabel: "Без срока", description: "Работа", result: "" };
const parent = { ...node, id: "group", parentId: "root", kind: "group", children: [node] };

function harness({ pending = false, state = {} } = {}) {
  const imports = {
    react: { ...React, useActionState: () => [state, noop, pending] },
    "next/link": { __esModule: true, default: props => React.createElement("a", props) },
    "@/app/actions": { resizeTaskState: noop, setStatus: noop, nestTask: noop, unnestTask: noop, moveTask: noop, retryBotWebhook: noop },
    "@/lib/ruli/access": { canManage: access => access.role === "manager" },
    "@/lib/ruli/ai": { loadTaskAi: async () => ({ bots: [], runs: [], chatRuns: [] }) },
    "./collaboration": { TaskCollaboration: () => null },
    "./task-assignments": { TaskAssignments: () => null },
    "./ai-task": { TaskAiPanel: () => null },
    "./result-form": { ResultForm: () => null },
    "./submit-button": { SubmitButton: ({ children }) => React.createElement("button", { type: "submit" }, children) },
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
  return { ...load("components/ruli/views.tsx"), ...load("components/ruli/card-size-control.tsx") };
}
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const sizeProps = { taskId: node.id, parentId: node.parentId, version: node.version, size: node.size, mode: "build" };
const viewProps = (role = "manager", memberId = "me") => ({ node, path: [parent, node], members, today: "2026-11-18", mode: "view", viewer: { role, memberId, userId: "viewer-user" } });
const forms = html => [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map(([, content]) => content);
function postedForm(content) {
  const form = new FormData();
  // No submitter is supplied: this matches the hosting layer's action transport.
  for (const [tag] of content.matchAll(/<input\b[^>]*>/g)) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
    if (attrs.type === "hidden" && attrs.name) form.append(attrs.name, attrs.value ?? "");
  }
  return form;
}

test("only a manager in structure mode gets direct card size choices", () => {
  const h = harness();
  for (const role of ["manager", "executor", "viewer"]) {
    for (const mode of ["view", "build"]) {
      const html = render(h.TaskCard, { ...viewProps(role), mode, index: 0, siblingCount: 1 });
      assert.match(html, /id="task-card-task"/);
      if (role === "manager" && mode === "build") assert.match(html, /class="card-size-control"/);
      else assert.doesNotMatch(html, /class="card-size-control"/);
      assert.match(html, /class="block-open" href="\/t\/task\?mode=(?:view|build)"/);
    }
  }
});

test("size selection submits only size, id, version and mode and exposes all four named shapes", () => {
  const { CardSizeControl } = harness();
  const html = render(CardSizeControl, sizeProps);
  assert.match(html, /aria-label="Размер карточки: Широкий"/);
  for (const [name, value] of [["id", "task"], ["version", "7"], ["mode", "build"]]) assert.ok(html.includes(`name="${name}" value="${value}"`));
  const choices = forms(html);
  assert.equal(choices.length, 4);
  assert.deepEqual(choices.map(choice => postedForm(choice).get("size")), ["small", "wide", "tall", "large"]);
  for (const choice of choices) {
    assert.doesNotMatch(choice, /<form\b/);
    const posted = Object.fromEntries(postedForm(choice));
    assert.deepEqual(posted, { id: "task", version: "7", mode: "build", size: posted.size });
    const button = choice.match(/<button\b[^>]*>/)?.[0] ?? "";
    assert.match(button, /aria-label="(?:Квадрат|Широкий|Высокий|Крупный), [12] × [12]/);
    assert.doesNotMatch(button, /\bname=/);
    assert.equal(button.includes('disabled=""'), posted.size === "wide");
  }
  assert.doesNotMatch(html, /name="(?:title|description|owner|participants|result|status|priority|theme)"/);
  assert.match(html, /На телефоне карточки идут в одну колонку/);
});

test("pending size selection blocks duplicate changes and conflicts link back to the same parent card", () => {
  const pending = harness({ pending: true });
  const html = render(pending.CardSizeControl, sizeProps);
  const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map(([tag]) => tag);
  assert.equal(buttons.length, 4);
  for (const button of buttons) assert.match(button, /disabled=""/);
  assert.match(html, /role="status"/);
  const failed = harness({ state: { error: "Задача изменилась. Обновите карточку." } });
  const errorHtml = render(failed.CardSizeControl, sizeProps);
  assert.match(errorHtml, /role="alert"/);
  assert.match(errorHtml, /href="\/t\/group\?mode=build#task-card-task"/);
});

test("each rendered size form reaches the real action without a submitter and returns to the parent card", async () => {
  const h = collaborationHarness();
  try {
    h.seedTask("size-test");
    const exports = {};
    const code = ts.transpileModule(fs.readFileSync(path.join(project,"app/actions.ts"),"utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(code, { exports, crypto, FormData, URLSearchParams, console, require: id => {
      if (id === "next/navigation") return { redirect: url => { throw new TestRedirect(url); } };
      if (id === "../lib/ruli/mutations") return mutations;
      if (["../db","../lib/ruli/data","../lib/ruli/access","../lib/ruli/policy","../lib/ruli/model","../lib/ruli/agent-runtime"].includes(id)) return h.common;
      throw new Error(`Unexpected action import ${id}`);
    } });
    const { CardSizeControl } = harness();
    for (const size of ["wide","tall","large","small"]) {
      const before = h.one("SELECT size,version FROM tasks WHERE id='size-test'");
      const html = render(CardSizeControl,{taskId:"size-test",parentId:"root",version:before.version,size:before.size,mode:"build"});
      const form = forms(html).map(postedForm).find(form => form.get("size") === size);
      assert.ok(form);
      await assert.rejects(exports.resizeTaskState({},form), error => {
        if (!(error instanceof TestRedirect)) return false;
        const destination = new URL(error.url,"https://local.test");
        return destination.pathname === "/" && destination.searchParams.get("mode") === "build"
          && !destination.searchParams.has("error") && destination.hash === "#task-card-size-test";
      });
      assert.equal(h.one("SELECT size FROM tasks WHERE id='size-test'").size,size);
    }
  } finally { h.close(); }
});

test("a saved card version remounts its size menu closed", () => {
  const h = harness();
  function findMenu(element) {
    if (!element || typeof element !== "object") return null;
    if (Array.isArray(element)) return element.map(findMenu).find(Boolean) ?? null;
    if (element.type === h.CardSizeControl) return element;
    return findMenu(element.props?.children);
  }
  const before = findMenu(h.TaskCard({...viewProps(),mode:"build",index:0,siblingCount:1}));
  const after = findMenu(h.TaskCard({...viewProps(),node:{...node,size:"large",version:8},mode:"build",index:0,siblingCount:1}));
  assert.ok(before && after);
  assert.notEqual(before.key,after.key);
  const html = render(after.type,after.props);
  const details = html.match(/<details\b[^>]*class="card-size-control"[^>]*>/)?.[0];
  assert.ok(details);
  assert.doesNotMatch(details,/\bopen(?:=|\s|>)/);
});

test("start-work control appears only for queued tasks and directly authorized people", async () => {
  const h = harness();
  for (const [role, memberId, allowed] of [["manager", "me", true], ["executor", "anna", true], ["executor", "max", true], ["executor", "me", false], ["viewer", "anna", false]]) {
    for (const status of ["todo", "doing", "review", "done"]) {
      const html = renderToStaticMarkup(await h.DetailView({ ...viewProps(role, memberId), node: { ...node, status } }));
      assert.equal(html.includes("Взять в работу"), allowed && status === "todo", `${role}/${memberId}/${status}`);
      if (allowed && status === "todo") {
        assert.match(html, /name="version" value="7"/);
        assert.match(html, /name="expectedStatus" value="todo"/);
        assert.match(html, /name="status" value="doing"/);
      }
    }
  }
});
