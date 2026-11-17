import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import * as model from "../lib/ruli/model.ts";
import * as policy from "../lib/ruli/policy.ts";
import * as mutations from "../lib/ruli/mutations.ts";

// Execute the shipped server actions against SQLite, replacing only the hosting
// boundary (identity, redirects, D1 transport and tree reads). SQL is not mocked.
const source = ts.transpileModule(fs.readFileSync(new URL("../app/actions.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const manager = { userId: "manager-user", memberId: "me", role: "manager", displayName: "Руководитель" };

function harness() {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDir = new URL("../drizzle/", import.meta.url);
  for (const name of fs.readdirSync(migrationDir).filter(name => name.endsWith(".sql")).sort()) {
    sqlite.exec(fs.readFileSync(new URL(name, migrationDir), "utf8"));
  }
  sqlite.exec(`INSERT INTO members(id,name,short_name) VALUES ('me','Руководитель','Вы'),('anna','Анна','Анна'),('max','Максим','Максим');
    INSERT INTO tasks(id,parent_id,kind,title,owner_id,status,position,description,result) VALUES
    ('root',NULL,'group','Все задачи','me',NULL,0,'',''),
    ('group','root','group','Проект','me',NULL,0,'',''),
    ('task','group','leaf','Поручение','anna','todo',0,'Исходное описание',''),
    ('neighbor','group','leaf','Сосед','max','doing',1,'','');
    INSERT INTO task_participants(task_id,member_id) VALUES ('task','max');`);
  const h = { sqlite, ctx: manager, beforeBatch: null, failAt: -1, accessCalls: 0 };
  const prepare = sql => {
    const statement = { sql, params: [] };
    return {
      ...statement,
      bind(...params) { return Object.assign(prepare(sql), { params }); },
      async first() { return sqlite.prepare(sql).get(...this.params) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...this.params) }; },
    };
  };
  const db = {
    prepare,
    async batch(statements) {
      if (h.beforeBatch) { const hook = h.beforeBatch; h.beforeBatch = null; hook(); }
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = statements.map((statement, index) => {
          if (index === h.failAt) throw new Error("Injected storage failure");
          const changed = sqlite.prepare(statement.sql).run(...statement.params);
          return { meta: { changes: Number(changed.changes) } };
        });
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  async function loadTree() {
    const rows = sqlite.prepare("SELECT * FROM tasks WHERE deleted_at IS NULL").all();
    const byId = new Map(rows.map(row => [row.id, {
      id: row.id, parentId: row.parent_id, title: row.title, ownerId: row.owner_id,
      kind: row.kind, status: row.status, description: row.description, result: row.result,
      dueDate: row.due_date, dueLabel: row.due_label, size: row.size, theme: row.theme,
      position: row.position, version: row.version, splitSourceId: row.split_source_id,
      children: [], participants: sqlite.prepare("SELECT member_id FROM task_participants WHERE task_id=?").all(row.id).map(x => x.member_id),
    }]));
    for (const node of byId.values()) if (node.parentId && byId.has(node.parentId)) byId.get(node.parentId).children.push(node);
    for (const node of byId.values()) node.children.sort((a,b) => a.position - b.position || a.id.localeCompare(b.id));
    return byId.get("root");
  }
  const modules = {
    "next/navigation": { redirect(url) { throw Object.assign(new Error(url), { digest: "NEXT_REDIRECT", url }); } },
    "../db": { getD1: () => db },
    "../lib/ruli/data": { loadTree, getMembers: async () => sqlite.prepare("SELECT id,name FROM members").all() },
    "../lib/ruli/access": { requireAccess: async () => { h.accessCalls++; if (!h.ctx) throw Object.assign(new Error("sign in"), {digest:"NEXT_REDIRECT"}); return h.ctx; } },
    "../lib/ruli/policy": policy,
    "../lib/ruli/model": model,
    "../lib/ruli/mutations": mutations,
  };
  const exports = {};
  vm.runInNewContext(source, { exports, require(name) { if (!(name in modules)) throw new Error(`Unexpected import ${name}`); return modules[name]; }, FormData, URLSearchParams, crypto, console: { error() {} } });
  h.actions = exports;
  h.row = id => sqlite.prepare("SELECT * FROM tasks WHERE id=?").get(id);
  h.form = (extra = {}) => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ id:"task",version:String(h.row("task").version),title:"Новое название",owner:"anna",size:"small",theme:"teal",due:"",description:"Полное описание",expectedStatus:h.row("task").status,mode:"build",...extra })) {
      if (value !== undefined && value !== null) for (const item of Array.isArray(value) ? value : [value]) form.append(key,String(item));
    }
    return form;
  };
  return h;
}

async function success(promise) {
  await assert.rejects(promise, error => error.digest === "NEXT_REDIRECT" && !new URL(error.url,"https://local").searchParams.has("error"));
}
async function rejectedAction(promise, pattern) {
  await assert.rejects(promise, error => error.digest === "NEXT_REDIRECT" && pattern.test(new URL(error.url,"https://local").searchParams.get("error") ?? ""));
}

test("creating saves description and deduplicates participants in one batch", async () => {
  const h = harness();
  const form = h.form({parent:"group",parentVersion:1,description:"Точное ТЗ, которое нельзя потерять",participants:["anna","max","max"]});
  await success(h.actions.createTaskState({},form));
  const row = h.sqlite.prepare("SELECT * FROM tasks WHERE id LIKE 'task-%'").get();
  assert.equal(row.description,"Точное ТЗ, которое нельзя потерять");
  assert.deepEqual(h.sqlite.prepare("SELECT member_id FROM task_participants WHERE task_id=?").all(row.id).map(x=>x.member_id),["max"]);
  assert.equal(h.row("group").version,2);
  assert.equal(h.row("root").version,2);
});

test("oversize text and impossible dates return complete form values without a write", async () => {
  for (const fields of [{title:"x".repeat(201)}, {description:"x".repeat(2001)}, {due:"31.02.2026"}, {due:"завтро"}]) {
    const h = harness();
    const form = h.form(fields);
    const state = await h.actions.updateTaskState({},form);
    assert.ok(state.error);
    for (const [key,value] of Object.entries(fields)) assert.equal(state.values[key],value);
    assert.equal(h.row("task").version,1);
    assert.equal(h.row("task").description,"Исходное описание");
  }
});

test("long result is rejected intact, and authorized executor can submit an exact boundary", async () => {
  const h = harness();
  h.ctx = { ...manager, memberId:"anna",role:"executor" };
  const result = "Ж".repeat(5001);
  const state = await h.actions.submitResultState({},h.form({result}));
  assert.equal(state.values.result,result);
  assert.ok(state.fieldErrors.result);
  assert.equal(h.row("task").result,"");
  await success(h.actions.submitResultState({},h.form({result:result.slice(0,5000)})));
  assert.equal(h.row("task").result.length,5000);
  assert.equal(h.row("task").status,"review");
});

test("stale editor cannot overwrite fields or participant links, including a race after read", async () => {
  const h = harness();
  h.beforeBatch = () => h.sqlite.exec("UPDATE tasks SET version=2,title='Чужая правка',last_mutation_id='another-token' WHERE id='task'");
  const state = await h.actions.updateTaskState({},h.form({participants:["me"]}));
  assert.match(state.error,/изменилась/);
  assert.equal(h.row("task").title,"Чужая правка");
  assert.deepEqual(h.sqlite.prepare("SELECT member_id FROM task_participants WHERE task_id='task'").all().map(x=>x.member_id),["max"]);
  assert.equal(h.row("root").version,1);
});

test("a failed dependent statement rolls back fields, versions and participants", async () => {
  const h = harness();
  h.failAt = 2;
  const state = await h.actions.updateTaskState({},h.form({participants:["me"]}));
  assert.match(state.error,/Не удалось сохранить/);
  assert.equal(h.row("task").version,1);
  assert.equal(h.row("task").title,"Поручение");
  assert.deepEqual(h.sqlite.prepare("SELECT member_id FROM task_participants WHERE task_id='task'").all().map(x=>x.member_id),["max"]);
});

test("move swaps both rows atomically and rejects a stale second click", async () => {
  const h = harness();
  const form = h.form({delta:1});
  h.failAt=1;
  await rejectedAction(h.actions.moveTask(form),/Не удалось сохранить/);
  assert.equal(h.row("task").position,0);
  assert.equal(h.row("neighbor").position,1);
  h.failAt=-1;
  await success(h.actions.moveTask(form));
  assert.equal(h.row("task").position,1);
  assert.equal(h.row("neighbor").position,0);
  assert.equal(h.row("neighbor").version,2);
  await rejectedAction(h.actions.moveTask(form),/изменилась/);
});

test("deletion and restoration retain an entire batch and its participants", async () => {
  const h = harness();
  await success(h.actions.deleteTask(h.form({id:"group",version:1})));
  const group = h.row("group");
  assert.ok(group.deleted_at);
  assert.equal(h.row("task").deletion_batch_id,group.deletion_batch_id);
  assert.equal(h.row("neighbor").deletion_batch_id,group.deletion_batch_id);
  const trash = await h.actions.listDeletedTasks();
  assert.equal(trash.length,1);
  assert.equal(trash[0].id,"group");
  await success(h.actions.restoreTask(h.form({id:"group",version:group.version,batchId:group.deletion_batch_id})));
  for (const id of ["group","task","neighbor"]) assert.equal(h.row(id).deleted_at,null);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS count FROM task_participants WHERE task_id='task'").get().count,1);
});

test("restoring child is blocked while parent is deleted; older batches stay separate", async () => {
  const h = harness();
  await success(h.actions.deleteTask(h.form()));
  const task = h.row("task");
  await success(h.actions.deleteTask(h.form({id:"group",version:h.row("group").version})));
  const group = h.row("group");
  assert.notEqual(task.deletion_batch_id,group.deletion_batch_id);
  await rejectedAction(h.actions.restoreTask(h.form({version:task.version,batchId:task.deletion_batch_id})),/родительскую группу/);
  await success(h.actions.restoreTask(h.form({id:"group",version:group.version,batchId:group.deletion_batch_id})));
  assert.ok(h.row("task").deleted_at);
  await success(h.actions.restoreTask(h.form({version:task.version,batchId:task.deletion_batch_id})));
  assert.equal(h.row("task").deleted_at,null);
});

test("restoring a sibling after a new insertion does not duplicate its sort position", async () => {
  const h = harness();
  await success(h.actions.deleteTask(h.form({id:"neighbor",version:1})));
  const removed = h.row("neighbor");
  await success(h.actions.createTaskState({},h.form({parent:"group",parentVersion:h.row("group").version})));
  await success(h.actions.restoreTask(h.form({id:"neighbor",version:removed.version,batchId:removed.deletion_batch_id})));
  const positions = h.sqlite.prepare("SELECT position FROM tasks WHERE parent_id='group' AND deleted_at IS NULL").all().map(row=>row.position);
  assert.equal(new Set(positions).size,positions.length);
});

test("split and undo preserve leaf content and do not expose internal copies in trash", async () => {
  const h = harness();
  h.sqlite.exec("UPDATE tasks SET result='Сохранённый результат',status='doing' WHERE id='task'");
  await success(h.actions.nestTask(h.form()));
  const copy = h.sqlite.prepare("SELECT * FROM tasks WHERE split_source_id='task'").get();
  assert.equal(copy.result,"Сохранённый результат");
  assert.equal(copy.description,"Исходное описание");
  assert.equal(h.row("task").kind,"group");
  await success(h.actions.unnestTask(h.form()));
  assert.equal(h.row("task").kind,"leaf");
  assert.equal(h.row("task").result,"Сохранённый результат");
  assert.ok(h.row(copy.id).deleted_at);
  assert.equal((await h.actions.listDeletedTasks()).length,0);
});

test("undo split refuses to hide new messages", async () => {
  const h = harness();
  await success(h.actions.nestTask(h.form()));
  const copy = h.sqlite.prepare("SELECT * FROM tasks WHERE split_source_id='task'").get();
  h.sqlite.prepare("INSERT INTO task_messages(id,task_id,author_id,author_user_id,author_name,body,client_id,created_at) VALUES ('m',?,'anna','u','Анна','Новая работа','c','2026-11-17')").run(copy.id);
  await rejectedAction(h.actions.unnestTask(h.form()),/переписка или график/);
  assert.equal(h.row("task").kind,"group");
  assert.equal(h.row(copy.id).deleted_at,null);
});

test("undo split does not discard independent group edits or additional children", async () => {
  const h = harness();
  await success(h.actions.nestTask(h.form()));
  h.sqlite.exec("UPDATE tasks SET title='Новое имя группы' WHERE id='task'");
  await rejectedAction(h.actions.unnestTask(h.form()),/изменены по-разному/);
  assert.equal(h.row("task").title,"Новое имя группы");
  h.sqlite.exec("INSERT INTO tasks(id,parent_id,kind,title,owner_id,status) VALUES ('another','task','leaf','Новая работа','anna','todo')");
  await rejectedAction(h.actions.unnestTask(h.form()),/одну исходную копию/);
  assert.equal(h.row("another").deleted_at,null);
});

test("split and undo transfer existing schedule entries while retaining their original plan", async () => {
  const h = harness();
  h.sqlite.exec(`INSERT INTO schedule_plans(task_id) VALUES ('task');
    INSERT INTO schedule_entries(id,plan_task_id,task_id,member_id,title,start_date,end_date,hours)
    VALUES ('entry','task','task','anna','Поручение','2026-11-18','2026-11-18',4);`);
  await success(h.actions.nestTask(h.form()));
  const copy = h.sqlite.prepare("SELECT id FROM tasks WHERE split_source_id='task'").get();
  let entry = h.sqlite.prepare("SELECT * FROM schedule_entries WHERE id='entry'").get();
  assert.equal(entry.task_id,copy.id);
  assert.equal(entry.plan_task_id,"task");
  assert.equal(entry.version,2);
  await success(h.actions.unnestTask(h.form()));
  entry = h.sqlite.prepare("SELECT * FROM schedule_entries WHERE id='entry'").get();
  assert.equal(entry.task_id,"task");
  assert.equal(entry.plan_task_id,"task");
  assert.equal(entry.version,3);
  assert.equal(entry.hours,4);
});

test("undo split refuses a separately created child plan", async () => {
  const h = harness();
  await success(h.actions.nestTask(h.form()));
  const copy = h.sqlite.prepare("SELECT id FROM tasks WHERE split_source_id='task'").get();
  h.sqlite.prepare("INSERT INTO schedule_plans(task_id) VALUES (?)").run(copy.id);
  await rejectedAction(h.actions.unnestTask(h.form()),/график, созданный отдельно/);
  assert.equal(h.row("task").kind,"group");
  assert.equal(h.row(copy.id).deleted_at,null);
});

test("permissions and expected status prevent unauthorized or stale acceptance", async () => {
  const h = harness();
  h.ctx = {...manager,memberId:"anna",role:"executor"};
  const blocked = await h.actions.updateTaskState({},h.form());
  assert.match(blocked.error,/руководителю/);
  await success(h.actions.submitResultState({},h.form({result:"Готово"})));
  await rejectedAction(h.actions.setStatus(h.form({status:"done"})),/руководителю/);
  h.ctx = manager;
  await rejectedAction(h.actions.setStatus(h.form({status:"done",expectedStatus:"todo"})),/изменилась/);
  const accept = h.form({status:"done"});
  await success(h.actions.setStatus(accept));
  assert.equal(h.row("task").status,"done");
  await rejectedAction(h.actions.setStatus(accept),/изменилась/);
  h.ctx={...manager,memberId:"me",role:"viewer"};
  assert.equal((await h.actions.listDeletedTasks()).length,0);
  const denied = await h.actions.submitResultState({},h.form({result:"Не разрешено"}));
  assert.match(denied.error,/участник этой задачи/);
  assert.ok(h.accessCalls>=7);
});
