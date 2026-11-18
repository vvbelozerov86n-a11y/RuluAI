import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { lookupIdentityWorkspace, workspaceDatabase, workspaceSchemaStatements } from "../db/workspace-storage.ts";
import { workspaceDirectoryTriggers } from "../lib/ruli/workspace-directory.ts";
import { barrier, collaborationHarness, loadModule, makeForm, plain, TestRedirect } from "./collaboration-helper.mjs";

const data = { companyName: " Кирпич и сталь ", managerName: " Нина Иванова " };
const success = err => err instanceof TestRedirect && err.url === "/team#company-invite";
const denied = err => err instanceof TestRedirect && err.url === "/access-denied";

function harness(t) {
  const h = collaborationHarness();
  t.after(h.close);
  let identity = h.identities.manager;
  const getCurrentWorkspaceId = () => identity ? lookupIdentityWorkspace(h.db, identity, h.env.RULI_OWNER_EMAIL) : null;
  const requireChatGPTUser = async () => {
    if (!identity) throw new TestRedirect("/signin-with-chatgpt?return_to=%2Fregister");
    return identity;
  };
  const deps = { ...h.common, env:h.env, cache:fn=>fn, initRuli:async()=>{}, getCurrentWorkspaceId, requireChatGPTUser,
    getD1:async()=>workspaceDatabase(h.db, await getCurrentWorkspaceId()), getSystemD1:()=>h.db,
    lookupIdentityWorkspace, workspaceDatabase, workspaceSchemaStatements, workspaceDirectoryTriggers, createInviteToken:randomUUID };
  const access = loadModule("lib/ruli/access.ts", deps, ["requireManager","requireAccess"]);
  const profile = loadModule("lib/ruli/company-profile.ts", {...deps,...access}, ["getManagerCompanyProfile", "getCompanyRegistrationAccess", "getCurrentCompanyName"]);
  const { registerCompanyState } = loadModule("app/company-actions.ts", {...deps,...profile}, ["registerCompanyState"]);
  return { ...h, profile: profile.getManagerCompanyProfile, registration:profile.getCompanyRegistrationAccess,
    access, getCurrentWorkspaceId, as: key => {identity = typeof key === "string" ? h.identities[key] : key;},
    register: (values = data) => registerCompanyState({}, makeForm(values)) };
}

test("company registration names the signed-in manager and creates one reusable invitation", async t => {
  const h = harness(t);
  assert.equal(await h.profile(), null);
  await assert.rejects(h.register({ ...data, memberId: "anna" }), success);
  const profile = await h.profile();
  assert.equal(profile.name, "Кирпич и сталь");
  assert.match(profile.inviteToken, /^[0-9a-f-]{36}$/);
  assert.deepEqual(h.one("SELECT name,short_name,initials FROM members WHERE id='me'"), {
    name: "Нина Иванова", short_name: "Нина", initials: "НИ",
  });
  assert.equal(h.one("SELECT name FROM members WHERE id='anna'").name, "Анна Смирнова");
  await assert.rejects(h.register({ companyName: "Другие", managerName: "Кто-то другой" }), success);
  assert.deepEqual(await h.profile(), profile);
  assert.equal(h.one("SELECT name FROM members WHERE id='me'").name, "Нина Иванова");
});

test("an existing employee cannot register another company or read its invitation", async t => {
  const h = harness(t);
  for (const who of ["anna", "viewer"]) {
    h.as(who);
    await assert.rejects(h.register(), denied);
  }
  h.as("manager");
  assert.equal(await h.profile(), null);
  await assert.rejects(h.register(), success);
  for (const who of ["anna", "viewer"]) {
    h.as(who);
    await assert.rejects(h.profile(), denied);
    await assert.rejects(h.register(), denied);
  }
});

test("independent managers create distinct companies with an empty root and a private employee directory", async t => {
  const h = harness(t);
  h.as(null);
  await assert.rejects(h.register(), err => err instanceof TestRedirect && err.url.includes("signin"));
  h.as("stranger");
  assert.equal((await h.registration()).kind, "new");
  await assert.rejects(h.register(), success);
  const first = await h.getCurrentWorkspaceId();
  assert.match(first, /^[a-f0-9]{32}$/);
  const firstProfile = await h.profile();
  assert.equal(firstProfile.name, data.companyName.trim());
  assert.equal((await h.access.requireAccess()).role, "manager");
  const local = workspaceDatabase(h.db, first);
  assert.deepEqual((await local.prepare("SELECT id,owner_id FROM tasks").all()).results,[{id:"root",owner_id:"me"}]);
  assert.deepEqual((await local.prepare("SELECT id,name FROM members").all()).results,[{id:"me",name:"Нина Иванова"}]);
  assert.equal(h.one("SELECT name FROM members WHERE id='me'").name,"Руководитель");
  h.as({userId:"new-owner-two",email:"second@company.test"});
  await assert.rejects(h.register({companyName:"Вторая",managerName:"Ольга"}), success);
  assert.notEqual(await h.getCurrentWorkspaceId(), first);
  assert.notEqual((await h.profile()).inviteToken, firstProfile.inviteToken);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM workspaces").n, 3);
});

test("racing new manager submissions cannot orphan physical tables or a directory row", async t => {
  const h = harness(t);
  h.as("stranger");
  h.hooks.beforeBatch = barrier();
  const submit = async () => { try {return await h.register();} catch (err) {if (success(err)) return {won:true}; throw err;} };
  const results = await Promise.all([submit(), submit()]);
  assert.equal(results.filter(row=>row.won).length,1);
  assert.equal(results.filter(row=>row.error).length,1);
  assert.equal(h.one("SELECT COUNT(*) AS n FROM workspaces").n,2);
  const id = await h.getCurrentWorkspaceId();
  assert.ok(h.all("SELECT name FROM sqlite_master WHERE name GLOB 'w_*'").every(row=>row.name.startsWith(`w_${id}_`)));
  assert.equal(h.one("SELECT COUNT(*) AS n FROM workspace_accounts WHERE email=?",h.identities.stranger.email).n,1);
});

test("global account uniqueness survives OR IGNORE and existing companies keep separate tokens through rotation", async t => {
  const h = harness(t);
  h.as("stranger");
  await assert.rejects(h.register(),success);
  const id=await h.getCurrentWorkspaceId(), local=workspaceDatabase(h.db,id);
  const token=(await h.profile()).inviteToken;
  await assert.rejects(local.prepare("UPDATE OR IGNORE team_accounts SET email='anna@example.test' WHERE member_id='me'").run());
  assert.equal((await local.prepare("SELECT email FROM team_accounts WHERE member_id='me'").first()).email,h.identities.stranger.email);
  h.as("manager");
  await assert.rejects(h.register(),success);
  await assert.rejects(local.prepare("UPDATE OR IGNORE company_profile SET invite_token=?").bind((await h.profile()).inviteToken).run());
  assert.equal(h.one("SELECT invite_token FROM workspaces WHERE id=?",id).invite_token, token);
  const nextToken=randomUUID();
  await local.prepare("UPDATE company_profile SET invite_token=?").bind(nextToken).run();
  assert.equal(h.one("SELECT invite_token FROM workspaces WHERE id=?",id).invite_token, nextToken);
});

test("the configured unbound legacy owner claims the existing workspace and preserves its tree", async t => {
  const h = harness(t);
  h.sqlite.exec("DELETE FROM team_accounts WHERE member_id='me'");
  h.env.RULI_OWNER_EMAIL = h.identities.stranger.email;
  h.as("stranger");
  assert.equal((await h.registration()).kind, "manager");
  await assert.rejects(h.register(),success);
  assert.equal(await h.getCurrentWorkspaceId(),"legacy");
  assert.equal(h.one("SELECT COUNT(*) AS n FROM workspaces").n,1);
  assert.ok(h.one("SELECT id FROM tasks WHERE id='letter'"));
});

test("pending invitations in independent companies cannot reserve an email across the site", async t => {
  const h=harness(t);
  const workspaces=[];
  for(const key of ["a","b"]) {
    h.as({userId:`manager-${key}`, email:`${key}@example.test`});
    await assert.rejects(h.register(),success);
    const local=workspaceDatabase(h.db,await h.getCurrentWorkspaceId());
    await local.prepare("INSERT INTO team_accounts(email,member_id,role) VALUES ('person@example.test','invited','viewer')").run();
    workspaces.push(local);
  }
  h.as({userId:"person",email:"person@example.test"});
  assert.equal(await h.getCurrentWorkspaceId(),null);
  assert.equal((await h.registration()).kind,"new");
  const [first,second]=workspaces;
  await second.prepare("UPDATE team_accounts SET user_id='person' WHERE member_id='invited'").run();
  assert.ok(await h.getCurrentWorkspaceId());
  await assert.rejects(first.prepare("UPDATE OR IGNORE team_accounts SET user_id='person' WHERE member_id='invited'").run());
  assert.equal((await first.prepare("SELECT user_id FROM team_accounts WHERE member_id='invited'").first()).user_id,null);
  await first.prepare("DELETE FROM team_accounts WHERE member_id='invited'").run();
  assert.ok(await h.getCurrentWorkspaceId());
});

test("company registration validates both fields on the server and preserves entered values", async t => {
  const h = harness(t);
  for (const key of ["companyName", "managerName"]) {
    for (const invalid of ["  ", "я".repeat(121)]) {
      const values = { ...data, [key]: invalid };
      const state = await h.register(values);
      assert.ok(state.fieldErrors[key]);
      assert.deepEqual(plain(state.values), values);
    }
  }
  assert.equal(await h.profile(), null);
});

test("racing registration forms never combine different company and manager names", async t => {
  const h = harness(t);
  h.hooks.beforeBatch = barrier();
  await Promise.all(["Первая", "Вторая"].map(name => assert.rejects(h.register({ companyName: name, managerName: name }), success)));
  const profile = await h.profile();
  assert.equal(h.one("SELECT name FROM members WHERE id='me'").name, profile.name);
  assert.equal(h.one("SELECT count(*) AS n FROM company_profile").n, 1);
});

test("a manager whose role changed before the write cannot initialize an existing workspace", async t => {
  const h = harness(t);
  h.hooks.beforeBatch = () => h.sqlite.exec("UPDATE team_accounts SET role='executor' WHERE member_id='me'");
  assert.ok((await h.register()).error);
  assert.equal(h.one("SELECT id FROM company_profile"), null);
  assert.equal(h.one("SELECT name FROM members WHERE id='me'").name, "Руководитель");
});

test("a failed manager update rolls back the company and its invitation", async t => {
  const h = harness(t);
  h.sqlite.exec(`CREATE TRIGGER fail_update BEFORE UPDATE OF name ON members
    WHEN NEW.id='me' BEGIN SELECT RAISE(ABORT,'test interruption'); END`);
  assert.ok((await h.register()).error);
  assert.equal(await h.profile(), null);
});
