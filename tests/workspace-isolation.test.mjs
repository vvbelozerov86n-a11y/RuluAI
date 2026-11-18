import test from "node:test";
import assert from "node:assert/strict";
import { lookupIdentityWorkspace, workspaceDatabase, workspaceSchemaStatements } from "../db/workspace-storage.ts";
import { workspaceDirectoryTriggers } from "../lib/ruli/workspace-directory.ts";
import { runMutation } from "../lib/ruli/mutations.ts";
import { collaborationHarness } from "./collaboration-helper.mjs";

const alpha = "a".repeat(32), beta = "b".repeat(32);

async function fixture(t) {
  const h = collaborationHarness();
  t.after(h.close);
  async function create(id, name) {
    const db = workspaceDatabase(h.db, id);
    await h.db.batch([
      h.db.prepare("INSERT INTO workspaces(id) VALUES (?)").bind(id),
      ...await workspaceSchemaStatements(h.db, id), ...workspaceDirectoryTriggers(h.db, id),
      db.prepare("INSERT INTO members(id,name,short_name) VALUES ('me',?,?)").bind(name, name),
      db.prepare("INSERT INTO team_accounts VALUES (?,?,'me','manager')").bind(`${name}@example.test`, name),
      db.prepare("INSERT INTO tasks(id,title,kind) VALUES ('root',?,'group')").bind(name),
      db.prepare("INSERT INTO tasks(id,title,parent_id) VALUES ('letter',?,'root')").bind(name),
      db.prepare("INSERT INTO task_participants(task_id,member_id) VALUES ('letter','me')"),
      db.prepare(`INSERT INTO task_messages VALUES ('msg','letter',NULL,'me','local-user',?,?,'client-id','2026-11-18')`).bind(name, name),
      db.prepare("INSERT INTO schedule_plans(task_id) VALUES ('letter')"),
      db.prepare(`INSERT INTO schedule_entries(id,plan_task_id,task_id,member_id,title,start_date,end_date,hours)
        VALUES ('entry','letter','letter','me',?,'2026-11-18','2026-11-18',1)`).bind(name),
      db.prepare("INSERT INTO bot_configs(member_id,provider,model,slug,updated_at) VALUES ('bot','openai','fixture','bot',?)").bind(name),
    ]);
    return db;
  }
  return { ...h, a:await create(alpha,"alpha"), b:await create(beta,"beta"), legacy:workspaceDatabase(h.db,"legacy") };
}

test("runtime namespaces quoted and mixed-case SQL identifiers, correlated task queries, and literal text", async t => {
  const h = await fixture(t);
  const select = `SELECT "TASKS".title AS title, [MeMbErS].name AS manager,
    (SELECT COUNT(*) FROM \`Task_Participants\` p WHERE p.task_id="TASKS".id AND p.member_id=[MeMbErS].id) AS count,
    'tasks' AS literal, 'members'' tasks' AS escaped
    FROM "TASKS" JOIN [MeMbErS] ON "TASKS".owner_id=[MeMbErS].id
    WHERE "TASKS".id=? /* workspaces, tasks, sqlite_master */ -- literal comment
  `;
  for (const [name, db] of [["alpha",h.a],["beta",h.b]]) {
    assert.deepEqual(await db.prepare(select).bind("letter").first(), {title:name,manager:name,count:1,literal:"tasks",escaped:"members' tasks"});
  }
  assert.equal((await h.legacy.prepare("SELECT owner_id FROM tasks WHERE id='letter'").first()).owner_id,"anna");
});

test("versioned task, chat, and schedule writes affect only the manager's workspace", async t => {
  const h = await fixture(t);
  const changed = await runMutation(h.a,{id:"letter",version:1,set:{sql:"title=?",params:["Изменено"]},
    statements:gate=>[
      {sql:`UPDATE schedule_entries SET hours=3 WHERE task_id='letter' AND ${gate.sql}`,params:gate.params},
      {sql:`UPDATE task_messages SET body='Готово' WHERE id='msg' AND ${gate.sql}`,params:gate.params},
      {sql:`DELETE FROM task_participants WHERE task_id='letter' AND ${gate.sql}`,params:gate.params},
    ],
  });
  assert.equal(changed,true);
  assert.equal(await runMutation(h.a,{id:"letter",version:1}),false);
  for (const [db,title,version,body,hours,participants] of [[h.a,"Изменено",2,"Готово",3,0],[h.b,"beta",1,"beta",1,1]]) {
    assert.deepEqual(await db.prepare("SELECT title,version FROM tasks WHERE id='letter'").first(),{title,version});
    assert.equal((await db.prepare("SELECT version FROM tasks WHERE id='root'").first()).version,version);
    assert.equal((await db.prepare("SELECT body FROM task_messages WHERE id='msg'").first()).body,body);
    assert.equal((await db.prepare("SELECT hours FROM schedule_entries WHERE id='entry'").first()).hours,hours);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM task_participants").first()).n,participants);
  }
  assert.deepEqual(await h.legacy.prepare("SELECT title,version FROM tasks WHERE id='letter'").first(),{title:"letter",version:1});
  assert.equal(await h.legacy.prepare("SELECT id FROM schedule_entries WHERE id='entry'").first(),null);
  assert.equal(await h.legacy.prepare("SELECT id FROM task_messages WHERE id='msg'").first(),null);
});

test("new company schema contains the business tables and their indexes, enforcing uniqueness per company", async t => {
  const h = await fixture(t);
  const tableObjects = h.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'w_*' AND name NOT IN ('workspaces','workspace_accounts') ORDER BY name");
  for (const {name} of tableObjects) {
    const physical = `w_${alpha}_${name}`;
    assert.ok(h.one("SELECT name FROM sqlite_master WHERE type='table' AND name=?",physical),name);
    // PRAGMA index_list also includes SQLite's implicit PK indexes.
    const indexes = table => h.all("SELECT origin, [unique] AS u, partial FROM pragma_index_list(?) ORDER BY origin, u, partial",table);
    assert.deepEqual(indexes(physical),indexes(name),name);
  }
  for (const db of [h.a,h.b]) {
    await assert.rejects(db.prepare("INSERT INTO bot_configs(member_id,provider,model,slug,updated_at) VALUES ('another','openai','fixture','bot','today')").run(), /unique/i);
    await assert.rejects(db.prepare(`INSERT INTO task_messages VALUES ('other','letter',NULL,'me','local-user','me','two','client-id','today')`).run(), /unique/i);
  }
});

test("a workspace data handle rejects direct system, other tenant, and untrusted workspace identifiers", async t => {
  const h = await fixture(t);
  for (const db of [h.legacy,h.a]) {
    for (const name of ['"workspace_accounts"',"[WORKSPACES]","`sqlite_master`","'workspace_accounts'",`w_${beta}_tasks`]) {
      assert.throws(()=>db.prepare(`SELECT COUNT(*) FROM ${name}`));
    }
    await assert.rejects(db.dump());
  }
  for (const bad of ["", "another", "A".repeat(32), "a".repeat(33)]) assert.throws(()=>workspaceDatabase(h.db,bad));
});

test("stable identity wins over email changes; reserved legacy owner, pending legacy email, and new users route independently", async t => {
  const h = await fixture(t);
  const lookup = (userId,email,ownerEmail) => lookupIdentityWorkspace(h.db,{userId,email},ownerEmail);
  await h.legacy.prepare("INSERT INTO team_accounts(email,member_id,role) VALUES ('pending@example.test','maria','viewer')").run();
  assert.equal(await lookup("alpha"," BETA@EXAMPLE.TEST "),alpha);
  assert.equal(await lookup("beta","owner@example.test","owner@example.test"),beta);
  assert.equal(await lookup("new-id"," PENDING@EXAMPLE.TEST "),"legacy");
  assert.equal(await lookup("new-id","alpha@example.test"),null);
  assert.equal(await lookup("new-id","new@example.test"),null);
  assert.equal(await lookup("new-id"," OWNER@EXAMPLE.TEST ","owner@example.test"),"legacy");
});
