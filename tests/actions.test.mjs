import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import * as model from "../lib/ruli/model.ts";
import * as policy from "../lib/ruli/policy.ts";
import * as mutations from "../lib/ruli/mutations.ts";
import * as taskSchedule from "../lib/ruli/task-schedule.ts";
import { collaborationHarness, makeForm, TestRedirect, redirectMessage } from "./collaboration-helper.mjs";

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
      kind: row.kind, status: row.status, priority: row.priority ?? null, description: row.description, result: row.result,
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
    "../lib/ruli/task-schedule": taskSchedule,
    "../lib/ruli/agent-runtime": { notifyTaskChangeForAgents: async () => {}, retryAgentDelivery: async () => null, listTaskDeliveries: async () => [], agentWebhookConfigured: () => false },
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
  let destination;
  await assert.rejects(promise, error => {
    if (error.digest !== "NEXT_REDIRECT") return false;
    destination = new URL(error.url,"https://local");
    return !destination.searchParams.has("error");
  });
  return destination;
}
async function rejectedAction(promise, pattern) {
  await assert.rejects(promise, error => error.digest === "NEXT_REDIRECT" && pattern.test(new URL(error.url,"https://local").searchParams.get("error") ?? ""));
}

test("creating opens the new task and saves description, deadline and participants in one batch", async () => {
  const h = harness();
  const form = h.form({parent:"group",parentVersion:1,due:"2026-12-01",description:"Точное ТЗ, которое нельзя потерять",participants:["anna","max","max"]});
  const destination = await success(h.actions.createTaskState({},form));
  const row = h.sqlite.prepare("SELECT * FROM tasks WHERE id LIKE 'task-%'").get();
  assert.equal(destination.pathname,`/t/${row.id}`);
  assert.equal(destination.searchParams.get("mode"),"build");
  assert.equal(destination.searchParams.get("flash"),"Задача создана.");
  assert.equal(row.parent_id,"group");
  assert.equal(row.kind,"leaf");
  assert.equal(row.due_date,"2026-12-01");
  assert.equal(row.description,"Точное ТЗ, которое нельзя потерять");
  assert.deepEqual(h.sqlite.prepare("SELECT member_id FROM task_participants WHERE task_id=?").all(row.id).map(x=>x.member_id),["max"]);
  assert.equal(h.row("group").version,2);
  assert.equal(h.row("root").version,2);
});

test("creating a group opens that group and preserves its deadline and participants",async()=>{
  const h=harness();
  const destination=await success(h.actions.createTaskState({},h.form({
    parent:"root",parentVersion:1,nested:"on",mode:"view",title:"Новая группа задач",
    due:"2026-12-10",description:"Общая цель команды",participants:["me","max"],
  })));
  const row=h.sqlite.prepare("SELECT * FROM tasks WHERE id LIKE 'task-%'").get();
  assert.equal(destination.pathname,`/t/${row.id}`);
  assert.equal(destination.searchParams.get("mode"),"view");
  assert.equal(destination.searchParams.get("flash"),"Группа задач создана — добавьте подзадачи.");
  assert.equal(row.parent_id,"root");
  assert.equal(row.kind,"group");
  assert.equal(row.status,null);
  assert.equal(row.due_date,"2026-12-10");
  assert.equal(row.description,"Общая цель команды");
  assert.deepEqual(h.sqlite.prepare("SELECT member_id FROM task_participants WHERE task_id=? ORDER BY member_id").all(row.id).map(item=>item.member_id),["max","me"]);
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

// Task and schedule actions share one real SQLite database, exposing bugs at
// their boundary that separate action unit tests cannot reproduce.
function integratedHarness(t) {
  const h = collaborationHarness();
  t.after(() => h.close());
  const modules = {
    "next/navigation": { redirect(url) { throw Object.assign(new TestRedirect(url), {digest:"NEXT_REDIRECT"}); } },
    "../db": {getD1:() => h.db},
    "../lib/ruli/data": {loadTree:h.loadTree,getMembers:h.getMembers},
    "../lib/ruli/access": h.access,
    "../lib/ruli/policy": policy,
    "../lib/ruli/model": model,
    "../lib/ruli/mutations": mutations,
    "../lib/ruli/task-schedule": taskSchedule,
    "../lib/ruli/agent-runtime": { notifyTaskChangeForAgents: async () => {}, retryAgentDelivery: async () => null, listTaskDeliveries: async () => [], agentWebhookConfigured: () => false },
  };
  const exports = {};
  vm.runInNewContext(source,{exports,require:name=>modules[name],FormData,URLSearchParams,crypto,console});
  h.taskAction = async (name,values,state=false) => {
    try { return {state:await (state ? exports[name]({},makeForm(values)) : exports[name](makeForm(values)))}; }
    catch(error) { if(error instanceof TestRedirect) return {redirect:error.url}; throw error; }
  };
  h.task = id => h.one("SELECT * FROM tasks WHERE id=?",id);
  return h;
}

const scheduleForm = (taskId,hours=6,limit=8) => ({taskId,version:0,startDate:"2026-11-17",hoursPerDay:limit,estimatedHoursPerTask:hours,weekdaysOnly:"on"});
function succeeded(result) {
  assert.equal(redirectMessage(result),null,result.redirect ?? JSON.stringify(result));
  assert.ok(redirectMessage(result,"flash"),"Expected a successful redirect");
}
function reassignForm(h,id,owner) {
  const task=h.task(id);
  return {id,version:task.version,title:task.title,owner,size:task.size,theme:task.theme,due:"",description:task.description};
}

test("reassign transfers schedule executor and advances entry/plan versions atomically",async t=>{
  const h=integratedHarness(t);
  succeeded(await h.invoke("generateTaskSchedule",scheduleForm("letter")));
  const rootVersion=h.task("root").version;
  succeeded(await h.taskAction("updateTask",reassignForm(h,"letter","max")));
  assert.equal(h.task("letter").owner_id,"max");
  assert.deepEqual(h.one("SELECT member_id,version,hours FROM schedule_entries WHERE task_id='letter'"),{member_id:"max",version:2,hours:6});
  assert.equal(h.one("SELECT version FROM schedule_plans WHERE task_id='letter'").version,2);
  assert.equal(h.task("root").version,rootVersion+1);
  // Assigning the group changes neither the leaf owner nor its inherited plan.
  succeeded(await h.taskAction("updateTask",reassignForm(h,"launch","me")));
  assert.equal(h.task("letter").owner_id,"max");
  assert.equal(h.one("SELECT member_id FROM schedule_entries WHERE task_id='letter'").member_id,"max");
});

test("reassign respects the lower existing plan limit and preserves the submitted form on conflict",async t=>{
  const h=integratedHarness(t);
  succeeded(await h.invoke("generateTaskSchedule",scheduleForm("letter",2,8)));
  succeeded(await h.invoke("generateTaskSchedule",scheduleForm("visuals",4,4)));
  const before=h.task("letter");
  const result=await h.taskAction("updateTaskState",{...reassignForm(h,"letter","max"),description:"Keep this text"},true);
  assert.match(result.state.error,/Нельзя сменить ответственного.*6 ч.*4 ч/);
  assert.equal(result.state.values.description,"Keep this text");
  assert.equal(result.state.values.owner,"max");
  assert.deepEqual(h.task("letter"),before);
  assert.equal(h.one("SELECT member_id,version FROM schedule_entries WHERE task_id='letter'").member_id,"anna");
  assert.equal(h.one("SELECT version FROM schedule_plans WHERE task_id='letter'").version,1);
});

test("reassign rejects a concurrent plan reservation through the root version guard",async t=>{
  const h=integratedHarness(t);
  succeeded(await h.invoke("generateTaskSchedule",scheduleForm("letter")));
  h.hooks.beforeBatch=async()=>{
    h.hooks.beforeBatch=null;
    succeeded(await h.invoke("generateTaskSchedule",scheduleForm("visuals",8)));
  };
  const result=await h.taskAction("updateTaskState",reassignForm(h,"letter","max"),true);
  assert.match(result.state.error,/изменилась/);
  assert.equal(h.task("letter").owner_id,"anna");
  assert.equal(h.one("SELECT member_id,version FROM schedule_entries WHERE task_id='letter'").version,1);
  assert.equal(h.one("SELECT version FROM schedule_plans WHERE task_id='letter'").version,1);
});

test("failure after schedule transfer rolls back task, participant, schedule and plan changes",async()=>{
  const h=harness();
  h.sqlite.exec(`INSERT INTO schedule_plans(task_id,version) VALUES ('task',1);
    INSERT INTO schedule_entries(id,plan_task_id,task_id,member_id,title,start_date,end_date,hours)
    VALUES ('entry','task','task','anna','Поручение','2026-11-17','2026-11-17',6);`);
  // Root update comes after the row, participant, entry and plan writes.
  h.failAt=5;
  const result=await h.actions.updateTaskState({},h.form({owner:"max",participants:["me"]}));
  assert.match(result.error,/Не удалось сохранить/);
  assert.equal(h.row("task").owner_id,"anna");
  assert.equal(h.row("task").version,1);
  assert.equal(h.row("root").version,1);
  assert.deepEqual(h.sqlite.prepare("SELECT member_id FROM task_participants WHERE task_id='task'").all().map(row=>row.member_id),["max"]);
  assert.equal(h.sqlite.prepare("SELECT member_id,version FROM schedule_entries").get().member_id,"anna");
  assert.equal(h.sqlite.prepare("SELECT version FROM schedule_entries").get().version,1);
  assert.equal(h.sqlite.prepare("SELECT version FROM schedule_plans").get().version,1);
});

test("restore refuses 14h on an 8h day and restores after conflicting reservations are cleared",async t=>{
  const h=integratedHarness(t);
  succeeded(await h.invoke("generateTaskSchedule",scheduleForm("letter",6)));
  succeeded(await h.taskAction("deleteTask",{id:"letter",version:h.task("letter").version}));
  succeeded(await h.invoke("generateTaskSchedule",scheduleForm("help",8)));
  const deleted=h.task("letter");
  const form={id:"letter",version:deleted.version,batchId:deleted.deletion_batch_id};
  const blocked=await h.taskAction("restoreTask",form);
  assert.match(redirectMessage(blocked),/Нельзя восстановить задачу.*14 ч.*8 ч/);
  assert.deepEqual(h.task("letter"),deleted);
  succeeded(await h.invoke("clearTaskSchedule",{taskId:"help",version:1,confirmClear:"yes"}));
  succeeded(await h.taskAction("restoreTask",form));
  assert.equal(h.task("letter").deleted_at,null);
  assert.equal(h.all(h.collaboration.workloadSelect).reduce((sum,row)=>sum+row.hours,0),6);
});

test("restoring a whole batch checks plans that were hidden with the parent",async t=>{
  const h=integratedHarness(t);
  succeeded(await h.invoke("generateTaskSchedule",scheduleForm("launch",6)));
  succeeded(await h.taskAction("deleteTask",{id:"launch",version:h.task("launch").version}));
  succeeded(await h.invoke("generateTaskSchedule",scheduleForm("help",8)));
  const deleted=h.task("launch");
  const blocked=await h.taskAction("restoreTask",{id:"launch",version:deleted.version,batchId:deleted.deletion_batch_id});
  assert.match(redirectMessage(blocked),/Нельзя восстановить задачу/);
  for(const id of ["launch","letter","visuals"]) assert.ok(h.task(id).deleted_at);
});

test("restore cannot race a successful plan generation into overbooking",async t=>{
  const h=integratedHarness(t);
  succeeded(await h.invoke("generateTaskSchedule",scheduleForm("letter")));
  succeeded(await h.taskAction("deleteTask",{id:"letter",version:h.task("letter").version}));
  const deleted=h.task("letter");
  h.hooks.beforeBatch=async()=>{
    h.hooks.beforeBatch=null;
    succeeded(await h.invoke("generateTaskSchedule",scheduleForm("help",8)));
  };
  const blocked=await h.taskAction("restoreTask",{id:"letter",version:deleted.version,batchId:deleted.deletion_batch_id});
  assert.match(redirectMessage(blocked),/данные изменились/);
  assert.deepEqual(h.task("letter"),deleted);
});

test("reopening completed work validates released capacity and succeeds after that time is free",async t=>{
  const h=integratedHarness(t);
  succeeded(await h.invoke("generateTaskSchedule",scheduleForm("letter")));
  succeeded(await h.taskAction("submitResult",{id:"letter",version:h.task("letter").version,expectedStatus:"todo",result:"Ready"}));
  succeeded(await h.taskAction("setStatus",{id:"letter",version:h.task("letter").version,expectedStatus:"review",status:"done"}));
  assert.equal(h.all(h.collaboration.workloadSelect).length,0);
  succeeded(await h.invoke("generateTaskSchedule",scheduleForm("help",8)));
  const form={id:"letter",version:h.task("letter").version,expectedStatus:"done",status:"doing"};
  const blocked=await h.taskAction("setStatus",form);
  assert.match(redirectMessage(blocked),/Нельзя вернуть задачу в работу.*14 ч.*8 ч/);
  assert.equal(h.task("letter").status,"done");
  assert.equal(h.task("letter").version,form.version);
  succeeded(await h.invoke("clearTaskSchedule",{taskId:"help",version:1,confirmClear:"yes"}));
  succeeded(await h.taskAction("setStatus",form));
  assert.equal(h.task("letter").status,"doing");
});

test("reopen checks the root version after its capacity read",async t=>{
  const h=integratedHarness(t);
  succeeded(await h.invoke("generateTaskSchedule",scheduleForm("letter")));
  h.sqlite.exec("UPDATE tasks SET status='done' WHERE id='letter'");
  h.hooks.beforeBatch=async()=>{
    h.hooks.beforeBatch=null;
    succeeded(await h.invoke("generateTaskSchedule",scheduleForm("help",8)));
  };
  const blocked=await h.taskAction("setStatus",{id:"letter",version:h.task("letter").version,expectedStatus:"done",status:"doing"});
  assert.match(redirectMessage(blocked),/изменилась/);
  assert.equal(h.task("letter").status,"done");
});

test("capacity guards distribute multi-day hours and ignore unrelated existing overload",async()=>{
  const h=harness();
  h.sqlite.exec(`INSERT INTO schedule_plans(task_id,version,hours_per_day) VALUES ('task',1,8),('neighbor',1,4);
    INSERT INTO schedule_entries(id,plan_task_id,task_id,member_id,title,start_date,end_date,hours) VALUES
    ('incoming','task','task','anna','P','2026-11-17','2026-11-18',12),
    ('other','neighbor','neighbor','max','Q','2026-11-18','2026-11-18',4);`);
  const blocked=await h.actions.updateTaskState({},h.form({owner:"max"}));
  assert.match(blocked.error,/2026-11-18.*10 ч.*4 ч/);
  h.sqlite.exec("UPDATE schedule_entries SET start_date='2026-12-01',end_date='2026-12-01' WHERE id='other'");
  await success(h.actions.updateTaskState({},h.form({owner:"max"})));
  assert.equal(h.row("task").owner_id,"max");
});
