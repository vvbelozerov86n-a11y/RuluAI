// Real TypeScript actions and SQL against an isolated SQLite database. Only
// Workers bindings, React request cache, identity headers and navigation are
// replaced. No browser, production D1 or external service is contacted.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";
import { webcrypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as model from "../lib/ruli/model.ts";
import * as scheduling from "../lib/ruli/scheduling.ts";
import * as policy from "../lib/ruli/policy.ts";
import * as returnPath from "../lib/ruli/return-path.ts";
import * as botCatalog from "../lib/ruli/bot-catalog.ts";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class TestRedirect extends Error {
  constructor(url) { super(`Redirect: ${url}`); this.url = url; }
}

export function loadModule(relative, bindings, exports) {
  const source = stripTypeScriptTypes(fs.readFileSync(path.join(project, relative), "utf8"))
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, "")
    .replace(/^export\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?\s*/gm, "")
    .replace(/^export /gm, "");
  const context = vm.createContext({
    console, FormData, URLSearchParams, URL, Headers, Request, Response, fetch,
    TextEncoder, TextDecoder, AbortController, Blob, setTimeout, clearTimeout,
    crypto: webcrypto, Error, RangeError,
    redirect: (url) => { throw new TestRedirect(url); },
    ...bindings,
  });
  vm.runInContext(`${source}\n;globalThis.moduleExports = {${exports.join(",")}};`, context, { filename: relative });
  return context.moduleExports;
}

export function makeForm(values) {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) form.set(key, String(value));
  }
  return form;
}

export function plain(value) { return JSON.parse(JSON.stringify(value)); }

export function redirectMessage(result, key = "error") {
  return result.redirect ? new URL(result.redirect, "https://ruli.test").searchParams.get(key) : null;
}

export function barrier(count = 2) {
  let waiting = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return async () => { if (++waiting === count) release(); await gate; };
}

export function collaborationHarness() {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of fs.readdirSync(path.join(project, "drizzle")).filter((file) => file.endsWith(".sql")).sort()) {
    sqlite.exec(fs.readFileSync(path.join(project, "drizzle", name), "utf8"));
  }
  const hooks = { beforeBatch: null, beforeRun: null };
  const queried = [];
  function prepared(sql, values = []) {
    return {
      sql, values,
      bind(...bound) { return prepared(sql, bound); },
      execute() {
        queried.push({ sql, values: [...values] });
        const result = sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      async run() { await hooks.beforeRun?.(sql, values); return this.execute(); },
      async first(column) {
        queried.push({ sql, values: [...values] });
        const row = sqlite.prepare(sql).get(...values);
        return row ? column ? row[column] : { ...row } : null;
      },
      async all() {
        queried.push({ sql, values: [...values] });
        return { success: true, results: sqlite.prepare(sql).all(...values).map((row) => ({ ...row })) };
      },
    };
  }
  const db = {
    prepare: prepared,
    async batch(statements) {
      await hooks.beforeBatch?.(statements);
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  const identities = {
    manager: { userId: "user-manager", email: "manager@example.test" },
    anna: { userId: "user-anna", email: "anna@example.test" },
    max: { userId: "user-max", email: "max@example.test" },
    viewer: { userId: "user-viewer", email: "viewer@example.test" },
    stranger: { userId: "user-stranger", email: "stranger@example.test" },
  };
  let identity = identities.manager;
  const env = {};
  for (const member of [...model.DEMO_MEMBERS, { id: "observer", name: "Наблюдатель", shortName: "Наблюдатель", role: "", initials: "Н", color: "", type: "human" }]) {
    sqlite.prepare("INSERT INTO members (id,name,short_name,role,initials,color,type) VALUES (?,?,?,?,?,?,?)")
      .run(member.id, member.name, member.shortName, member.role, member.initials, member.color, member.type);
  }
  for (const [key, memberId, role] of [["manager", "me", "manager"], ["anna", "anna", "executor"], ["max", "max", "executor"], ["viewer", "observer", "viewer"]]) {
    sqlite.prepare("INSERT INTO team_accounts (email,user_id,member_id,role) VALUES (?,?,?,?)")
      .run(identities[key].email, identities[key].userId, memberId, role);
  }
  function seedTask(id, { parentId = "root", kind = "leaf", ownerId = "anna", status = "todo", title = id, dueDate = null, deletedAt = null, version = 1 } = {}) {
    sqlite.prepare("INSERT INTO tasks (id,parent_id,kind,title,owner_id,status,due_date,deleted_at,version) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, parentId, kind, title, ownerId, kind === "group" ? null : status, dueDate, deletedAt, version);
  }
  seedTask("root", { parentId: null, kind: "group", ownerId: "me" });
  seedTask("launch", { kind: "group", ownerId: "anna" });
  seedTask("letter", { parentId: "launch" });
  seedTask("visuals", { parentId: "launch", ownerId: "max" });
  seedTask("service", { kind: "group", ownerId: "anna" });
  seedTask("help", { parentId: "service" });

  const access = loadModule("lib/ruli/access.ts", {
    ...policy, env, cache: (fn) => fn, getD1: () => db, initRuli: async () => {},
    requireChatGPTUser: async () => {
      if (!identity) throw new TestRedirect("/signin-with-chatgpt");
      return { ...identity, displayName: identity.email, fullName: null };
    },
  }, ["requireAccess", "requireManager", "listAccessAccounts"]);

  async function getMembers() {
    return sqlite.prepare("SELECT id,name,short_name AS shortName,role,initials,color,type FROM members").all().map((row) => ({ ...row }));
  }
  async function loadTree() {
    const rows = sqlite.prepare("SELECT * FROM tasks WHERE deleted_at IS NULL").all();
    const nodes = new Map(rows.map((row) => [row.id, {
      id: row.id, parentId: row.parent_id, kind: row.kind, title: row.title, ownerId: row.owner_id,
      status: row.status, priority: row.priority ?? null, dueDate: row.due_date, dueLabel: row.due_label, description: row.description,
      result: row.result, size: row.size, theme: row.theme, position: row.position, version: row.version,
      deletedAt: row.deleted_at, splitSourceId: row.split_source_id, children: [], participants: [],
    }]));
    for (const row of sqlite.prepare("SELECT * FROM task_participants").all()) nodes.get(row.task_id)?.participants.push(row.member_id);
    for (const node of nodes.values()) if (node.parentId) nodes.get(node.parentId)?.children.push(node);
    return nodes.get("root");
  }
  const common = { ...model, ...policy, ...access, ...returnPath, ...botCatalog, getD1: () => db, getMembers, loadTree, notifyMessageForAgents: async () => {}, notifyTaskChangeForAgents: async () => {}, retryAgentDelivery: async () => null };
  const collaboration = loadModule("lib/ruli/collaboration.ts", common, ["taskChannelMembers", "scheduleSelect", "workloadSelect", "loadTaskCollaboration"]);
  const actions = loadModule("app/collaboration-actions.ts", { ...common, ...collaboration, ...scheduling }, ["sendMessageState", "sendMessage", "generateTaskSchedule", "updateScheduleEntry", "clearTaskSchedule"]);
  const teamActions = loadModule("app/team-actions.ts", common, ["addTeamMember"]);
  async function invoke(name, values, state = false) {
    const action = actions[name] ?? teamActions[name];
    try { return { state: await (state ? action({}, makeForm(values)) : action(makeForm(values))) }; }
    catch (error) { if (error instanceof TestRedirect) return { redirect: error.url }; throw error; }
  }
  return {
    sqlite, db, queried, hooks, env, identities, access, collaboration, actions, invoke, getMembers, loadTree, seedTask, common,
    as(key) { identity = typeof key === "string" ? identities[key] : key; },
    all(sql, ...values) { return sqlite.prepare(sql).all(...values).map((row) => ({ ...row })); },
    one(sql, ...values) { const row = sqlite.prepare(sql).get(...values); return row ? { ...row } : null; },
    close() { sqlite.close(); },
  };
}
