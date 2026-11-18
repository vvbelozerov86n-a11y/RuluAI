import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import React from "react";
import * as ReactDOM from "react-dom";
import {renderToStaticMarkup} from "react-dom/server";
import ts from "typescript";
import {barrier,collaborationHarness,loadModule,makeForm,plain,TestRedirect} from "./collaboration-helper.mjs";

const project=fileURLToPath(new URL("../",import.meta.url));
const require=createRequire(import.meta.url);
function actionHarness(t) {
  const h=collaborationHarness();t.after(()=>h.close());
  const {addTeamMemberState,updatePendingEmailState}=loadModule("app/team-actions.ts",h.common,["addTeamMemberState","updatePendingEmailState"]);
  return {...h,register:values=>addTeamMemberState({},makeForm(values)),correctEmail:values=>updatePendingEmailState({},makeForm(values))};
}
const values={name:"Новый сотрудник",email:" new@example.test ",role:"executor",memberId:""};

test("registration state authenticates manager, rejects forged roles and links, and preserves input on failure",async t=>{
  const h=actionHarness(t),before=h.all("SELECT id FROM members").length;
  h.as("anna");
  await assert.rejects(h.register(values),error=>error instanceof TestRedirect&&error.url==="/access-denied");
  h.as("manager");
  for(const invalid of [{email:"bad"},{name:""},{role:"manager"},{memberId:"writer"},{memberId:"me"},{memberId:"anna"},{email:"manager@example.test"}]) {
    const input={...values,...invalid};const state=await h.register(input);
    assert.ok(state.error,JSON.stringify(invalid));
    assert.deepEqual(plain(state.values),input);
  }
  assert.equal(h.all("SELECT id FROM members").length,before);
  assert.equal(h.one("SELECT COUNT(*) n FROM team_accounts WHERE email='new@example.test'").n,0);
});

test("registration state creates a normalized account and redirects to the visible employee section",async t=>{
  const h=actionHarness(t);
  await assert.rejects(h.register(values),error=>error instanceof TestRedirect&&error.url.startsWith("/team?flash=")&&error.url.endsWith("#register-employee"));
  const account=h.one("SELECT * FROM team_accounts WHERE email='new@example.test'");
  assert.equal(account.role,"executor");assert.equal(account.user_id,null);
  assert.equal(h.one("SELECT name FROM members WHERE id=?",account.member_id).name,values.name);
});

test("two registrations cannot bind different accounts to one existing employee",async t=>{
  const h=actionHarness(t);
  h.sqlite.prepare("INSERT INTO members(id,name,short_name,role,initials,color,type) VALUES('unlinked','Existing','Existing','Designer','EX','rose','human')").run();
  const before=h.all("SELECT id FROM members").length;
  h.hooks.beforeBatch=barrier();
  const attempt=async email=>{try{return await h.register({...values,email,memberId:"unlinked"});}catch(error){if(error instanceof TestRedirect)return {redirect:error.url};throw error;}};
  const results=await Promise.all([attempt("one@example.test"),attempt("two@example.test")]);
  assert.equal(results.filter(result=>result.redirect).length,1);
  assert.equal(results.filter(result=>result.error&&result.values.memberId==="unlinked").length,1);
  assert.equal(h.one("SELECT COUNT(*) n FROM team_accounts WHERE member_id='unlinked'").n,1);
  assert.equal(h.all("SELECT id FROM members").length,before);
  assert.equal(h.one("SELECT name FROM members WHERE id='unlinked'").name,"Existing");
});

function pageHarness(role="manager") {
  const members=[{id:"me",name:"Owner",type:"human"},{id:"linked",name:"Linked",type:"human"},{id:"unlinked",name:"Unlinked",type:"human"},{id:"bot",name:"Bot",type:"bot"}];
  const provider={id:"xai",label:"xAI · Grok",defaultModel:"fixture-model",kind:"llm",keyName:"XAI_API_KEY",configured:false,suggestedModels:[]};
  const imports={
    "@/lib/ruli/data":{getMembers:async()=>members},
    "@/lib/ruli/access":{requireAccess:async()=>({role}),canManage:viewer=>viewer.role==="manager",listAccessAccounts:async()=>[{memberId:"me",email:"owner@example.test",role:"manager",userId:"owner",name:"Owner"},{memberId:"linked",email:"linked@example.test",role:"executor",userId:null,name:"Linked"}]},
    "@/app/chatgpt-auth":{chatGPTSignInPath:()=>"/signin-with-chatgpt?return_to=%2F"},
    "@/lib/ruli/ai":{loadBotSettings:async()=>({providers:[provider],bots:[]})},
    "@/app/team-actions":{addTeamMemberState:()=>{},updatePendingEmailState:()=>{}},
    "@/app/ai-actions":{saveBotState:()=>{},testAiConnectionState:()=>{}},
    "@/components/ruli/ui":{Avatar:()=>null},
    "@/components/ruli/views":{Toasts:()=>null},
    "next/link":{__esModule:true,default:props=>React.createElement("a",props)},
  };
  const cache=new Map();
  function load(relative) {
    let filename=path.resolve(project,relative);
    if(!path.extname(filename))filename=[".tsx",".ts"].map(ext=>filename+ext).find(fs.existsSync);
    if(cache.has(filename))return cache.get(filename).exports;
    const compiled={exports:{}};cache.set(filename,compiled);
    const source=ts.transpileModule(fs.readFileSync(filename,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
    const localRequire=id=>Object.hasOwn(imports,id)?imports[id]:id==="react"?{...React,useActionState:()=>[{},()=>{},false]}:id==="react-dom"?{...ReactDOM,useFormStatus:()=>({pending:false})}:id.endsWith(".css")?{}:id.startsWith("@/")?load(id.slice(2)):id.startsWith(".")?load(path.resolve(path.dirname(filename),id)):require(id);
    vm.runInNewContext(source,{module:compiled,exports:compiled.exports,require:localRequire,console,crypto,URL},{filename});
    return compiled.exports;
  }
  return async()=>renderToStaticMarkup(await load("app/team/page.tsx").default({searchParams:Promise.resolve({})}));
}

test("team page exposes registration before AI, offers only unlinked humans and explains separate site access",async()=>{
  const html=await pageHarness()();
  assert.ok(html.indexOf('id="register-employee"')<html.indexOf('id="ai-settings-title"'));
  assert.match(html,/href="#register-employee"/);assert.match(html,/href="#create-bot"/);
  assert.match(html,/<option value="unlinked">Unlinked — уже в команде<\/option>/);
  assert.doesNotMatch(html,/<option value="(?:me|linked|bot)">/);
  assert.match(html,/Зарегистрировать сотрудника/);assert.match(html,/Письмо-приглашение не отправляется/);
  assert.match(html,/Владелец сайта отдельно разрешает сотруднику доступ/);
  assert.match(html,/Скопировать ссылку для входа/);
  assert.equal((html.match(/Исправить почту/g)??[]).length,1);
  assert.match(html,/name="expectedEmail" value="linked@example.test"/);
  assert.doesNotMatch(html,/name="expectedEmail" value="owner@example.test"/);
  assert.match(html,/href="\/signin-with-chatgpt\?return_to=%2F"/);
  assert.ok(html.indexOf('id="create-bot"')<html.indexOf("Подключите AI за 3 шага"));
});

test("non-managers see the team without registration controls or account email disclosure",async()=>{
  for(const role of ["executor","viewer"]) {
    const html=await pageHarness(role)();
    assert.match(html,/Люди в команде/);assert.match(html,/AI-боты/);
    assert.doesNotMatch(html,/id="register-employee"|Зарегистрировать сотрудника|owner@example.test|linked@example.test|id="create-bot"/);
  }
});

test("owner keeps the stable account when verified email and owner configuration change",async t=>{
  const h=actionHarness(t);
  h.env.RULI_OWNER_EMAIL="manager@example.test";
  const original=await h.access.requireAccess();
  const count=h.one("SELECT COUNT(*) n FROM team_accounts").n;
  h.env.RULI_OWNER_EMAIL=" OWNER.NEW@example.test ";
  h.as({userId:"user-manager",email:"Owner.New@Example.Test"});
  const changed=await h.access.requireAccess();
  assert.equal(changed.userId,original.userId);assert.equal(changed.memberId,"me");assert.equal(changed.role,"manager");
  assert.equal(h.one("SELECT email FROM team_accounts WHERE member_id='me'").email,"owner.new@example.test");
  assert.equal(h.one("SELECT COUNT(*) n FROM team_accounts").n,count);
  assert.equal((await h.access.requireAccess()).memberId,"me");
});

test("owner email conflicts preserve both accounts and a new configured identity cannot replace the established owner",async t=>{
  const h=actionHarness(t);
  h.sqlite.prepare("INSERT INTO team_accounts(email,member_id,role) VALUES('reserved@example.test','maria','viewer')").run();
  h.env.RULI_OWNER_EMAIL="reserved@example.test";
  h.as({userId:"user-manager",email:"reserved@example.test"});
  assert.equal((await h.access.requireAccess()).memberId,"me");
  assert.deepEqual(h.one("SELECT member_id,user_id,role FROM team_accounts WHERE email='reserved@example.test'"),{member_id:"maria",user_id:null,role:"viewer"});
  assert.equal(h.one("SELECT email FROM team_accounts WHERE member_id='me'").email,"manager@example.test");
  h.env.RULI_OWNER_EMAIL="other-owner@example.test";
  h.as({userId:"different-owner-identity",email:"other-owner@example.test"});
  await assert.rejects(h.access.requireAccess(),error=>error instanceof TestRedirect&&error.url==="/access-denied");
  assert.equal(h.one("SELECT user_id FROM team_accounts WHERE member_id='me'").user_id,"user-manager");
  h.env.RULI_OWNER_EMAIL="anna@example.test";h.as("anna");
  assert.equal((await h.access.requireAccess()).role,"executor");
});

async function pendingRegistration(h,email="typo@example.test") {
  await assert.rejects(h.register({...values,email}),error=>error instanceof TestRedirect&&error.url.startsWith("/team?flash="));
  return h.one("SELECT member_id FROM team_accounts WHERE email=?",email).member_id;
}

test("correcting a pending email preserves employee data and binds the corrected address on first sign-in",async t=>{
  const h=actionHarness(t),memberId=await pendingRegistration(h);
  h.seedTask("pending-employee-task",{ownerId:memberId});
  const before=h.one("SELECT * FROM members WHERE id=?",memberId);
  await assert.rejects(h.correctEmail({memberId,expectedEmail:"typo@example.test",email:" Corrected@Example.Test "}),error=>error instanceof TestRedirect&&error.url.includes("flash="));
  assert.deepEqual(h.one("SELECT * FROM members WHERE id=?",memberId),before);
  assert.equal(h.one("SELECT owner_id FROM tasks WHERE id='pending-employee-task'").owner_id,memberId);
  assert.deepEqual(h.one("SELECT email,role,user_id FROM team_accounts WHERE member_id=?",memberId),{email:"corrected@example.test",role:"executor",user_id:null});
  h.as({userId:"new-corrected-login",email:"corrected@example.test"});
  assert.equal((await h.access.requireAccess()).memberId,memberId);
});

test("pending email correction is manager-only and never edits signed-in accounts, owner, occupied emails or stale forms",async t=>{
  const h=actionHarness(t),memberId=await pendingRegistration(h);
  const input={memberId,expectedEmail:"typo@example.test",email:"corrected@example.test"};
  h.as("anna");await assert.rejects(h.correctEmail(input),error=>error instanceof TestRedirect&&error.url==="/access-denied");
  h.as("manager");
  for(const invalid of [{email:"bad"},{email:"anna@example.test"},{expectedEmail:"outdated@example.test"},{memberId:"me",expectedEmail:"manager@example.test"},{memberId:"anna",expectedEmail:"anna@example.test"}]) {
    const submitted={...input,...invalid},state=await h.correctEmail(submitted);
    assert.ok(state.error);assert.deepEqual(plain(state.values),submitted);
  }
  assert.equal(h.one("SELECT email FROM team_accounts WHERE member_id=?",memberId).email,"typo@example.test");
  h.sqlite.prepare("UPDATE team_accounts SET user_id='already-signed-in' WHERE member_id=?").run(memberId);
  assert.ok((await h.correctEmail(input)).error);
  assert.equal(h.one("SELECT email FROM team_accounts WHERE member_id=?",memberId).email,"typo@example.test");
});

test("a first sign-in that wins the race prevents a pending email correction",async t=>{
  const h=actionHarness(t),memberId=await pendingRegistration(h);
  h.hooks.beforeRun=async sql=>{
    if(!sql.startsWith("UPDATE OR IGNORE team_accounts SET email="))return;
    h.hooks.beforeRun=null;
    h.as({userId:"sign-in-won",email:"typo@example.test"});
    assert.equal((await h.access.requireAccess()).memberId,memberId);
  };
  const state=await h.correctEmail({memberId,expectedEmail:"typo@example.test",email:"corrected@example.test"});
  assert.ok(state.error);
  assert.deepEqual(h.one("SELECT email,user_id FROM team_accounts WHERE member_id=?",memberId),{email:"typo@example.test",user_id:"sign-in-won"});
});

test("competing pending email corrections update the original registration only once",async t=>{
  const h=actionHarness(t),memberId=await pendingRegistration(h);
  h.hooks.beforeRun=barrier();
  const attempt=async email=>{try{return await h.correctEmail({memberId,expectedEmail:"typo@example.test",email});}catch(error){if(error instanceof TestRedirect)return {redirect:error.url};throw error;}};
  const outcomes=await Promise.all([attempt("one@example.test"),attempt("two@example.test")]);
  assert.equal(outcomes.filter(outcome=>outcome.redirect).length,1);
  assert.equal(outcomes.filter(outcome=>outcome.error).length,1);
  assert.ok(["one@example.test","two@example.test"].includes(h.one("SELECT email FROM team_accounts WHERE member_id=?",memberId).email));
});
