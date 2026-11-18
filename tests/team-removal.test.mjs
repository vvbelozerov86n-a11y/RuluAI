import test from "node:test";
import assert from "node:assert/strict";
import {runMutation} from "../lib/ruli/mutations.ts";
import {collaborationHarness, loadModule, makeForm, TestRedirect} from "./collaboration-helper.mjs";

function harness(t) {
  const h = collaborationHarness();
  t.after(() => h.close());
  const actions = loadModule("app/team-actions.ts", {...h.common, runMutation},
    ["removeTeamMemberState", "addTeamMemberState"]);
  const remove = (memberId, confirmed = "yes") => actions.removeTeamMemberState({}, makeForm({memberId, confirmed}));
  const register = values => actions.addTeamMemberState({}, makeForm(values));
  return {...h, remove, register};
}

const removed = err => err instanceof TestRedirect &&
  new URL(err.url, "https://ruli.test").searchParams.get("result") === "removed" && err.url.endsWith("#team-people");
const denied = err => err instanceof TestRedirect && err.url === "/access-denied";

test("removing an employee revokes their current login and transfers active and trashed assignments atomically", async t => {
  const h = harness(t);
  h.seedTask("trashed", {parentId:"launch", deletedAt:"2026-11-18", status:"done"});
  h.seedTask("other", {ownerId:"max"});
  h.sqlite.exec(`UPDATE tasks SET result='Принято',deletion_batch_id='delete-test' WHERE id='trashed';
    INSERT INTO task_participants VALUES ('letter','me'), ('letter','max'), ('visuals','anna'), ('other','me');
    INSERT INTO schedule_plans (task_id,version) VALUES ('launch',3);
    INSERT INTO schedule_entries (id,plan_task_id,task_id,member_id,title,start_date,end_date,hours) VALUES
      ('plan-1','launch','letter','anna','Письмо','2026-11-18','2026-11-19',5);
    INSERT INTO task_messages VALUES ('msg','letter','anna','anna','user-anna','Анна','Текст','client-001','2026-11-18')`);
  h.as("anna");
  assert.equal((await h.access.requireAccess()).memberId, "anna");
  h.as("manager");
  await assert.rejects(h.remove("anna"), removed);
  assert.equal(h.one("SELECT email FROM team_accounts WHERE member_id='anna'"), null);
  assert.deepEqual(h.one("SELECT email,user_id FROM removed_team_accounts WHERE member_id='anna'"),
    {email:"anna@example.test",user_id:"user-anna"});
  assert.ok(h.one("SELECT removed_at FROM members WHERE id='anna'").removed_at);
  assert.equal(h.one("SELECT COUNT(*) n FROM tasks WHERE owner_id='anna'").n, 0);
  assert.deepEqual(h.one("SELECT owner_id,status,result,deleted_at,version FROM tasks WHERE id='trashed'"),
    {owner_id:"me", status:"done", result:"Принято", deleted_at:"2026-11-18", version:2});
  assert.deepEqual(h.all("SELECT task_id,member_id FROM task_participants ORDER BY task_id"),
    [{task_id:"letter",member_id:"max"}, {task_id:"other",member_id:"me"}]);
  assert.deepEqual(h.one("SELECT member_id,version FROM schedule_entries WHERE id='plan-1'"), {member_id:"me",version:2});
  assert.equal(h.one("SELECT version FROM schedule_plans WHERE task_id='launch'").version, 4);
  for (const taskId of ["root","launch","letter","visuals"])
    assert.equal(h.one("SELECT version FROM tasks WHERE id=?",taskId).version, 2);
  assert.equal(h.one("SELECT version FROM tasks WHERE id='other'").version, 1);
  assert.deepEqual(h.one("SELECT channel_member_id,author_name,body FROM task_messages WHERE id='msg'"),
    {channel_member_id:"anna",author_name:"Анна",body:"Текст"});
  h.as("anna");
  await assert.rejects(h.access.requireAccess("/team"), denied);
  h.as("manager");
  assert.ok((await h.remove("anna")).error);
  assert.equal(h.one("SELECT version FROM tasks WHERE id='root'").version, 2);
});

test("only a manager may confirm employee removal, and manager accounts and bots stay protected", async t => {
  const h = harness(t);
  for (const role of ["viewer","anna"]) {
    h.as(role);
    await assert.rejects(h.remove("max"), denied);
  }
  h.as("manager");
  h.sqlite.exec("UPDATE team_accounts SET role='manager' WHERE member_id='max'");
  assert.ok((await h.remove("anna","")).error);
  for (const id of ["me","max","writer","missing"]) assert.ok((await h.remove(id)).error, id);
  assert.equal(h.one("SELECT COUNT(*) n FROM members WHERE removed_at IS NOT NULL").n, 0);
});

test("unlinked people and pending registrations can be removed, and email reuse gets a fresh member identity", async t => {
  const h = harness(t);
  await assert.rejects(h.remove("maria"), removed);
  const details = {name:"Сотрудник", email:"pending@example.test", role:"viewer"};
  await assert.rejects(h.register(details), err => err instanceof TestRedirect);
  const original = h.one("SELECT member_id FROM team_accounts WHERE email=?",details.email).member_id;
  await assert.rejects(h.remove(original), removed);
  assert.deepEqual(h.one("SELECT email,user_id FROM removed_team_accounts WHERE member_id=?", original),
    {email:details.email,user_id:null});
  h.as({userId:"new-login",email:details.email});
  await assert.rejects(h.access.requireAccess(), denied);
  h.as("manager");
  assert.ok((await h.register({...details,memberId:original})).error);
  await assert.rejects(h.register(details), err => err instanceof TestRedirect);
  h.as({userId:"new-login",email:details.email});
  assert.notEqual((await h.access.requireAccess()).memberId, original);
});

test("registration cannot readmit an existing employee removed just before its write", async t => {
  const h = harness(t);
  h.hooks.beforeBatch = async () => {
    h.hooks.beforeBatch = null;
    await assert.rejects(h.remove("maria"), removed);
  };
  const state = await h.register({memberId:"maria",name:"Мария",email:"maria@example.test",role:"executor"});
  assert.ok(state.error);
  assert.equal(h.one("SELECT member_id FROM team_accounts WHERE member_id='maria'"), null);
});

test("a partial failure rolls back access revocation, task transfers and versions", async t => {
  const h = harness(t);
  h.sqlite.exec(`CREATE TRIGGER fail_archive BEFORE UPDATE OF removed_at ON members
    WHEN NEW.id='anna' BEGIN SELECT RAISE(ABORT,'test interruption'); END`);
  assert.ok((await h.remove("anna")).error);
  assert.equal(h.one("SELECT removed_at FROM members WHERE id='anna'").removed_at, null);
  assert.equal(h.one("SELECT member_id FROM removed_team_accounts WHERE member_id='anna'"), null);
  assert.deepEqual(h.one("SELECT owner_id,version FROM tasks WHERE id='letter'"), {owner_id:"anna", version:1});
  assert.equal(h.one("SELECT version FROM tasks WHERE id='root'").version,1);
  h.as("anna");
  assert.equal((await h.access.requireAccess()).memberId, "anna");
});
