import test from "node:test";
import assert from "node:assert/strict";
import {barrier, collaborationHarness, loadModule, makeForm, plain, TestRedirect} from "./collaboration-helper.mjs";
import {lookupIdentityWorkspace, workspaceDatabase, workspaceSchemaStatements} from "../db/workspace-storage.ts";
import {workspaceDirectoryTriggers} from "../lib/ruli/workspace-directory.ts";

function harness(t) {
  const h = collaborationHarness();
  t.after(() => h.close());
  let identity;
  const cache = fn => fn;
  const wiring = loadModule("db/index.ts", {
    cache, lookupIdentityWorkspace, workspaceDatabase, env:{DB:h.db, get RULI_OWNER_EMAIL(){ return h.env.RULI_OWNER_EMAIL; }},
    getChatGPTUser: async () => identity,
  }, ["getSystemD1","getCurrentWorkspaceId","getD1"]);
  const bindings = {
    ...h.common, ...wiring, env:h.env, lookupIdentityWorkspace, workspaceDatabase, cache, initRuli:async () => {},
    requireChatGPTUser: async path => {
      if (!identity) throw new TestRedirect(`/signin-with-chatgpt?return_to=${encodeURIComponent(path)}`);
      return identity;
    },
  };
  const access = loadModule("lib/ruli/access.ts", bindings, ["requireAccess", "requireManager"]);
  const invitations = loadModule("lib/ruli/company-invites.ts", bindings,
    ["createInviteToken", "isInviteToken", "getCompanyInvitation", "getExistingInviteMember"]);
  const actions = loadModule("app/invite-actions.ts", {...bindings, ...access, ...invitations}, ["acceptCompanyInviteState", "rotateCompanyInviteState"]);
  const token = invitations.createInviteToken();
  h.sqlite.prepare("INSERT INTO company_profile (id,name,invite_token) VALUES ('workspace','Компания',?)").run(token);
  function as(key) {
    identity = typeof key === "string" ? h.identities[key] : key;
    h.as(identity);
  }
  as("stranger");
  return {...h, ...invitations, access, token, as,
    accept: (extra = {}) => actions.acceptCompanyInviteState({}, makeForm({token, name:"Новый сотрудник", ...extra})),
    rotate: (expectedToken = token) => actions.rotateCompanyInviteState({}, makeForm({expectedToken})),
  };
}

async function secondWorkspace(h, id = "c".repeat(32), email = "boss@second.test", userId = "second-boss") {
  const db = workspaceDatabase(h.db, id), token = h.createInviteToken();
  await h.db.batch([
    h.db.prepare("INSERT INTO workspaces(id) VALUES (?)").bind(id),
    ...await workspaceSchemaStatements(h.db, id), ...workspaceDirectoryTriggers(h.db, id),
    db.prepare("INSERT INTO company_profile(id,name,invite_token) VALUES ('workspace','Вторая компания',?)").bind(token),
    db.prepare("INSERT INTO members(id,name,short_name) VALUES ('me','Директор второй компании','Директор')"),
    db.prepare("INSERT INTO team_accounts(email,user_id,member_id,role) VALUES (?,?,'me','manager')").bind(email,userId),
  ]);
  return {id,token,db};
}

const joined = err => err instanceof TestRedirect && err.url === "/";
const rotated = err => err instanceof TestRedirect && err.url.includes("result=invite") && err.url.endsWith("#company-invite");

test("a reusable link identifies the right workspace and keeps the invitation through sign-in", async t => {
  const h = harness(t);
  assert.deepEqual(plain(await h.getCompanyInvitation(h.token)), {name:"Компания",workspaceId:"legacy"});
  for (const token of ["", "../team", h.createInviteToken()]) {
    assert.equal(await h.getCompanyInvitation(token), null);
    assert.ok((await h.accept({token})).error);
  }
  for (const name of ["", " ".repeat(4), "я".repeat(121)]) assert.ok((await h.accept({name})).fieldErrors.name);
  h.as(null);
  await assert.rejects(h.accept(), err => err instanceof TestRedirect &&
    new URL(err.url, "https://ruli.test").searchParams.get("return_to") === `/join/${h.token}`);
  assert.equal(h.one("SELECT COUNT(*) n FROM team_accounts").n, 4);
});

test("employees self-register with the verified identity and cannot set their role or replace someone else", async t => {
  const h = harness(t);
  const first = {userId:"new-person", email:"  Person@Example.Test  "};
  h.as(first);
  await assert.rejects(h.accept({email:"manager@example.test", role:"manager", memberId:"me", name:"  Ирина Соколова  "}), joined);
  const account = h.one("SELECT * FROM team_accounts WHERE user_id='new-person'");
  assert.equal(account.email, "person@example.test");
  assert.equal(account.role, "executor");
  assert.notEqual(account.member_id, "me");
  assert.deepEqual(h.one("SELECT name,initials,short_name,type FROM members WHERE id=?",account.member_id),
    {name:"Ирина Соколова", initials:"ИС", short_name:"Ирина", type:"human"});
  assert.equal((await h.access.requireAccess()).memberId, account.member_id);
  h.as({userId:"other-person", email:"person@example.test"});
  assert.ok((await h.accept()).error);
  h.as({userId:"other-person", email:"other@example.test"});
  await assert.rejects(h.accept(), joined);
  assert.equal(h.one("SELECT COUNT(*) n FROM team_accounts").n, 6);
});

test("replayed and simultaneous submissions create one employee; account and member inserts roll back together", async t => {
  const h = harness(t);
  h.hooks.beforeBatch = barrier();
  await Promise.all([assert.rejects(h.accept(), joined), assert.rejects(h.accept(), joined)]);
  h.hooks.beforeBatch = null;
  await assert.rejects(h.accept({name:"Повторная отправка"}), joined);
  assert.equal(h.one("SELECT COUNT(*) n FROM members WHERE id LIKE 'member-%'").n, 1);
  assert.equal(h.one("SELECT name FROM members WHERE id LIKE 'member-%'").name, "Новый сотрудник");
  h.sqlite.exec("CREATE TRIGGER interrupt_join BEFORE INSERT ON team_accounts BEGIN SELECT RAISE(ABORT,'test'); END");
  h.as({userId:"another", email:"new@example.test"});
  assert.ok((await h.accept()).error);
  assert.equal(h.one("SELECT COUNT(*) n FROM members WHERE id LIKE 'member-%'").n, 1);
});

test("self-registration retains active roles, stable bindings and pending manual registrations", async t => {
  const h = harness(t);
  h.as("manager");
  await assert.rejects(h.accept(), joined);
  h.as({userId:"user-manager", email:"pending@example.test"});
  h.sqlite.prepare("INSERT INTO team_accounts(email,member_id,role) VALUES (?,'maria','viewer')").run("pending@example.test");
  const managerName = h.one("SELECT name FROM members WHERE id='me'").name;
  const pendingName = h.one("SELECT name FROM members WHERE id='maria'").name;
  assert.deepEqual(plain(await h.getExistingInviteMember({userId:"user-manager",email:"pending@example.test"}, "legacy")), {displayName:managerName,bound:true});
  assert.deepEqual(plain(await h.getExistingInviteMember({userId:"new-pending",email:" Pending@Example.Test "}, "legacy")), {displayName:pendingName,bound:false});
  assert.equal(await h.getExistingInviteMember({userId:"other",email:"manager@example.test"}, "legacy"), null);
  await assert.rejects(h.accept(), joined);
  assert.equal(h.one("SELECT user_id FROM team_accounts WHERE member_id='maria'").user_id, null);
  assert.equal(h.one("SELECT role FROM team_accounts WHERE user_id='user-manager'").role, "manager");
  h.as({userId:"new-pending",email:"pending@example.test"});
  await assert.rejects(h.accept(), joined);
  assert.deepEqual(h.one("SELECT member_id,role FROM team_accounts WHERE user_id='new-pending'"),
    {member_id:"maria",role:"viewer"});
  assert.equal(h.one("SELECT COUNT(*) n FROM members WHERE id LIKE 'member-%'").n, 0);
});

test("removed accounts cannot self-enroll again by changing their address or using another identity at that address", async t => {
  const h = harness(t);
  h.sqlite.prepare("INSERT INTO removed_team_accounts(member_id,email,user_id) VALUES ('former',?,?)")
    .run("former@example.test", "retired-login");
  for (const user of [{userId:"retired-login",email:"new@example.test"}, {userId:"replacement",email:"former@example.test"}]) {
    h.as(user);
    assert.ok((await h.accept()).error);
  }
  assert.equal(h.one("SELECT COUNT(*) n FROM members WHERE id LIKE 'member-%'").n, 0);
  const second = await secondWorkspace(h);
  h.as({userId:"retired-login",email:"former@example.test"});
  await assert.rejects(h.accept({token:second.token}), joined);
  assert.equal(await second.db.prepare("SELECT role FROM team_accounts WHERE user_id='retired-login'").first("role"), "executor");
  h.as("stranger");
  await assert.rejects(h.accept(), joined);
});

test("only a manager can rotate; stale rotation and an acceptance racing a rotation cannot reuse the old link", async t => {
  const h = harness(t);
  for (const key of ["anna", "viewer"]) {
    h.as(key);
    await assert.rejects(h.rotate(), err => err instanceof TestRedirect && err.url === "/access-denied");
  }
  h.as("stranger");
  h.hooks.beforeBatch = async () => {
    h.hooks.beforeBatch = null;
    h.as("manager");
    await assert.rejects(h.rotate(), rotated);
    h.as("stranger");
  };
  assert.match((await h.accept()).error, /недействительна/);
  assert.equal(h.one("SELECT email FROM team_accounts WHERE user_id='user-stranger'"), null);
  const changed = h.one("SELECT invite_token FROM company_profile").invite_token;
  assert.notEqual(changed, h.token);
  assert.equal(await h.getCompanyInvitation(h.token), null);
  h.as("manager");
  assert.ok((await h.rotate(h.token)).error);
  assert.equal(h.one("SELECT invite_token FROM company_profile").invite_token, changed);
  h.as("stranger");
  await assert.rejects(h.accept({token:changed}), joined);
});

test("a workspace is chosen only by the server-side invite and the signed-in identity opens that workspace", async t => {
  const h = harness(t), second = await secondWorkspace(h);
  assert.equal((await h.getCompanyInvitation(second.token)).workspaceId, second.id);
  await assert.rejects(h.accept({token:second.token, workspaceId:"legacy", memberId:"me", role:"manager"}), joined);
  const member = await second.db.prepare("SELECT member_id,role FROM team_accounts WHERE user_id='user-stranger'").first();
  assert.equal(member.role, "executor");
  assert.equal((await h.access.requireAccess()).memberId, member.member_id);
  assert.equal(h.one("SELECT email FROM team_accounts WHERE user_id='user-stranger'"), null);
  const foreign = await h.getExistingInviteMember(h.identities.stranger, "legacy");
  assert.deepEqual(plain(foreign), {foreign:true});
  assert.match((await h.accept({token:h.token})).error, /другой компанией/);
  assert.equal(h.one("SELECT COUNT(*) n FROM members WHERE id LIKE 'member-%'").n, 0);

  h.as({userId:"second-boss",email:"boss@second.test"});
  assert.ok((await h.rotate(h.token)).error);
  await assert.rejects(h.rotate(second.token), rotated);
  assert.equal(await h.getCompanyInvitation(second.token), null);
  assert.equal((await h.getCompanyInvitation(h.token)).workspaceId, "legacy");
});

test("legacy pending emails, stable IDs, and the reserved legacy owner retain their existing workspace", async t => {
  const h = harness(t), second = await secondWorkspace(h);
  h.sqlite.prepare("INSERT INTO team_accounts(email,member_id,role) VALUES ('pending@legacy.test','maria','viewer')").run();
  h.env.RULI_OWNER_EMAIL = "reserved@legacy.test";
  for (const identity of [
    {userId:"someone",email:"pending@legacy.test"},
    {userId:"user-anna",email:"changed@new.test"},
    {userId:"other",email:"manager@example.test"},
    {userId:"new-owner",email:"reserved@legacy.test"},
  ]) {
    h.as(identity);
    assert.deepEqual(plain(await h.getExistingInviteMember(identity, second.id)), {foreign:true});
    assert.match((await h.accept({token:second.token})).error, /другой компанией/);
  }
  assert.equal(await second.db.prepare("SELECT COUNT(*) n FROM members").first("n"), 1);
  assert.equal(h.one("SELECT COUNT(*) n FROM workspace_accounts WHERE workspace_id=?",second.id).n, 1);
});

test("unverified reservations stay local until the employee accepts one company's invitation", async t => {
  const h = harness(t);
  const companyA = await secondWorkspace(h, "a".repeat(32), "boss@a.test", "boss-a");
  const companyB = await secondWorkspace(h);
  for (const [company, name] of [[companyA, "Имя первой компании"], [companyB, "Имя второй компании"]]) {
    await company.db.batch([
      company.db.prepare("INSERT INTO members(id,name,short_name) VALUES ('pending',?,?)").bind(name,name),
      company.db.prepare("INSERT INTO team_accounts(email,member_id,role) VALUES ('employee@example.test','pending','viewer')"),
    ]);
  }
  assert.equal(h.one("SELECT * FROM workspace_accounts WHERE email='employee@example.test'"), null);
  const user = {userId:"pending-identity", email:"employee@example.test"};
  h.as(user);
  assert.deepEqual(plain(await h.getExistingInviteMember(user, companyA.id)), {displayName:"Имя первой компании",bound:false});
  assert.deepEqual(plain(await h.getExistingInviteMember(user, companyB.id)), {displayName:"Имя второй компании",bound:false});
  await assert.rejects(h.accept({token:companyB.token, name:"Другое имя", role:"manager"}), joined);
  assert.deepEqual(h.one("SELECT workspace_id,user_id FROM workspace_accounts WHERE email=?",user.email),
    {workspace_id:companyB.id,user_id:user.userId});
  assert.equal(await companyB.db.prepare("SELECT name FROM members WHERE id='pending'").first("name"), "Имя второй компании");
  assert.equal(await companyB.db.prepare("SELECT role FROM team_accounts WHERE member_id='pending'").first("role"), "viewer");
  assert.equal(await companyA.db.prepare("SELECT user_id FROM team_accounts WHERE member_id='pending'").first("user_id"), null);
  assert.match((await h.accept({token:companyA.token})).error, /другой компанией/);
  assert.deepEqual(plain(await h.getExistingInviteMember(user, companyA.id)), {foreign:true});

  const another = {userId:"another-pending",email:"only-in-a@example.test"};
  await companyA.db.batch([
    companyA.db.prepare("INSERT INTO members(id,name,short_name) VALUES ('local','Другое имя','Другое')"),
    companyA.db.prepare("INSERT INTO team_accounts(email,member_id,role) VALUES (?,'local','viewer')").bind(another.email),
  ]);
  h.as(another);
  assert.equal(await h.getExistingInviteMember(another, companyB.id), null);
  await assert.rejects(h.accept({token:companyB.token}), joined);
  assert.equal(await companyB.db.prepare("SELECT role FROM team_accounts WHERE user_id=?").bind(another.userId).first("role"), "executor");
});

test("concurrent invitations from two companies create membership in exactly one company", async t => {
  const h = harness(t), second = await secondWorkspace(h);
  h.hooks.beforeBatch = barrier();
  async function attempt(token) {
    try { return await h.accept({token}); }
    catch (error) { if (joined(error)) return {joined:true}; throw error; }
  }
  const outcomes = await Promise.all([attempt(h.token), attempt(second.token)]);
  assert.equal(outcomes.filter(result => result.joined).length, 1);
  assert.equal(outcomes.filter(result => result.error).length, 1);
  assert.equal(h.one("SELECT COUNT(*) n FROM workspace_accounts WHERE user_id='user-stranger'").n, 1);
  const total = h.one("SELECT COUNT(*) n FROM members WHERE id LIKE 'member-%'").n +
    await second.db.prepare("SELECT COUNT(*) n FROM members WHERE id LIKE 'member-%'").first("n");
  assert.equal(total, 1);
});
