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

const savedCompany={name:"Компания Тест",inviteToken:"test-invite-token",workspaceId:"legacy"};
const signedIn={email:"reader@example.test",fullName:"Анна Тест"};

function pageHarness(role="manager",company=savedCompany,user=signedIn,actionState={},existingMember=null) {
  const members=[{id:"me",name:"Owner",type:"human"},{id:"manager2",name:"Second manager",type:"human"},{id:"linked",name:"Linked",type:"human"},{id:"unlinked",name:"Unlinked",type:"human"},{id:"bot",name:"Bot",type:"bot"}];
  const provider={id:"xai",label:"xAI · Grok",defaultModel:"fixture-model",kind:"llm",keyName:"XAI_API_KEY",configured:false,suggestedModels:[]};
  const imports={
    "@/lib/ruli/data":{getMembers:async()=>members},
    "@/lib/ruli/access":{requireAccess:async()=>({role,memberId:"me"}),requireManager:async()=>{assert.equal(role,"manager");return {displayName:"Руководитель"};},canManage:viewer=>viewer.role==="manager",listAccessAccounts:async()=>[{memberId:"me",email:"owner@example.test",role:"manager",userId:"owner",name:"Owner"},{memberId:"manager2",email:"manager2@example.test",role:"manager",userId:"second",name:"Second manager"},{memberId:"linked",email:"linked@example.test",role:"executor",userId:null,name:"Linked"}]},
    "@/app/chatgpt-auth":{chatGPTSignInPath:path=>"/signin-with-chatgpt?return_to="+encodeURIComponent(path),chatGPTSignOutPath:path=>"/signout-with-chatgpt?return_to="+encodeURIComponent(path),getChatGPTUser:async()=>user},
    "@/lib/ruli/company-profile":{
      getCompanyRegistrationAccess:async()=>{assert.ok(user);return role==="new"?{kind:"new"}:role==="manager"?{kind:"manager",displayName:"Руководитель",registered:Boolean(company)}:{kind:"member"};},
      getCurrentCompanyName:async()=>company?.name??null,
      getManagerCompanyProfile:async()=>{assert.equal(role,"manager");return company;},
    },
    "@/lib/ruli/company-invites":{getCompanyInvitation:async token=>token===company?.inviteToken?{name:company.name,workspaceId:company.workspaceId}:null,getExistingInviteMember:async(_user,workspaceId)=>{assert.equal(workspaceId,company.workspaceId);return existingMember;}},
    "@/app/company-actions":{registerCompanyState:()=>{}},
    "@/app/invite-actions":{acceptCompanyInviteState:()=>{},rotateCompanyInviteState:()=>{}},
    "@/lib/ruli/ai":{loadBotSettings:async()=>({providers:[provider],bots:[]})},
    "@/app/team-actions":{addTeamMemberState:()=>{},updatePendingEmailState:()=>{},removeTeamMemberState:()=>{}},
    "@/app/ai-actions":{saveBotState:()=>{},testAiConnectionState:()=>{}},
    "@/components/ruli/ui":{Avatar:()=>null},
    "@/components/ruli/views":{Toasts:()=>null},
    "next/link":{__esModule:true,default:props=>React.createElement("a",props)},
    "next/navigation":{redirect:url=>{throw new TestRedirect(url);}},
  };
  const cache=new Map();
  function load(relative) {
    let filename=path.resolve(project,relative);
    if(!path.extname(filename))filename=[".tsx",".ts"].map(ext=>filename+ext).find(fs.existsSync);
    if(cache.has(filename))return cache.get(filename).exports;
    const compiled={exports:{}};cache.set(filename,compiled);
    const source=ts.transpileModule(fs.readFileSync(filename,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
    const localRequire=id=>Object.hasOwn(imports,id)?imports[id]:id==="react"?{...React,useActionState:()=>[actionState,()=>{},false]}:id==="react-dom"?{...ReactDOM,useFormStatus:()=>({pending:false})}:id.endsWith(".css")?{}:id.startsWith("@/")?load(id.slice(2)):id.startsWith(".")?load(path.resolve(path.dirname(filename),id)):require(id);
    vm.runInNewContext(source,{module:compiled,exports:compiled.exports,require:localRequire,console,crypto,URL},{filename});
    return compiled.exports;
  }
  const renderPage=async(file="app/team/page.tsx",pageParams={})=>renderToStaticMarkup(await load(file).default({searchParams:Promise.resolve({}),params:Promise.resolve(pageParams)}));
  renderPage.metadata=file=>load(file).metadata;
  return renderPage;
}

test("invite page keeps referrers on site and permits native same-origin registration before hydration",()=>{
  assert.equal(pageHarness().metadata("app/join/[token]/page.tsx").referrer,"same-origin");
});

test("team page presents the company invite before manual registration and AI, and preserves existing access controls",async()=>{
  const html=await pageHarness()();
  assert.ok(html.indexOf('id="register-employee"')<html.indexOf('id="ai-settings-title"'));
  assert.match(html,/href="#company-invite"/);assert.match(html,/href="#create-bot"/);
  assert.ok(html.indexOf('id="company-invite"')<html.indexOf('id="register-employee"'));
  assert.match(html,/Компания Тест/);assert.match(html,/value="\/join\/test-invite-token"/);
  assert.match(html,/Скопировать ссылку</);assert.match(html,/Заменить ссылку/);
  assert.match(html,/<option value="unlinked">Unlinked — уже в команде<\/option>/);
  assert.doesNotMatch(html,/<option value="(?:me|linked|bot)">/);
  assert.match(html,/Зарегистрировать сотрудника/);assert.match(html,/Добавить сотрудника по почте/);
  assert.match(html,/доступ в настройках Sites/);
  assert.match(html,/ссылку для регистрации в вашей компании/);
  assert.equal((html.match(/Исправить почту/g)??[]).length,1);
  assert.match(html,/name="expectedEmail" value="linked@example.test"/);
  assert.doesNotMatch(html,/name="expectedEmail" value="owner@example.test"/);
  assert.doesNotMatch(html,/Скопировать ссылку для входа/);
  assert.ok(html.indexOf('id="create-bot"')<html.indexOf("Подключите AI за 3 шага"));
});

test("non-managers see the team without registration controls or account email disclosure",async()=>{
  for(const role of ["executor","viewer"]) {
    const html=await pageHarness(role)();
    assert.match(html,/Люди в команде/);assert.match(html,/AI-боты/);
    assert.match(html,/Команда «Компания Тест»/);
    assert.doesNotMatch(html,/id="company-invite"|test-invite-token|id="register-employee"|Зарегистрировать сотрудника|owner@example.test|linked@example.test|id="create-bot"|aria-label="Удалить сотрудника/);
  }
});

test("a manager follows registration from the team, and can then find their invitation again",async()=>{
  const team=await pageHarness("manager",null)();
  assert.match(team,/href="\/register"/);assert.match(team,/Зарегистрировать компанию/);assert.doesNotMatch(team,/test-invite-token/);
  assert.match(team,/Скопировать ссылку для входа/);
  const register="app/register/page.tsx";
  const anonymous=await pageHarness("manager",null,null)(register);
  assert.match(anonymous,/return_to=%2Fregister/);assert.doesNotMatch(anonymous,/name="companyName"/);
  const form=await pageHarness("manager",null)(register);
  assert.match(form,/name="companyName"/);assert.match(form,/name="managerName"/);assert.match(form,/Анна Тест/);
  const separate=await pageHarness("new")(register);
  assert.match(separate,/name="companyName"/);assert.doesNotMatch(separate,/Компания Тест|test-invite-token/);
  const member=await pageHarness("viewer")(register);
  assert.match(member,/Открыть свою команду/);assert.doesNotMatch(member,/name="companyName"|test-invite-token/);
  await assert.rejects(pageHarness()(register),error=>error instanceof TestRedirect&&error.url==="/team#company-invite");
});

test("invitation preserves the sign-in return path, offers verified users the join form and hides invalid invitations",async()=>{
  const page="app/join/[token]/page.tsx", params={token:savedCompany.inviteToken};
  const landing=await pageHarness("executor",savedCompany,null)(page,params);
  assert.match(landing,/Компания Тест/);assert.match(landing,/return_to=%2Fjoin%2Ftest-invite-token/);assert.doesNotMatch(landing,/name="name"/);
  const form=await pageHarness("executor")(page,params);
  assert.match(form,/reader@example.test/);assert.match(form,/name="token" value="test-invite-token"/);
  assert.match(form,/name="name"/);assert.match(form,/Присоединиться к команде/);assert.doesNotMatch(form,/name="role"/);
  const invalid=await pageHarness("executor")(page,{token:"expired"});
  assert.match(invalid,/Приглашение недействительно/);assert.doesNotMatch(invalid,/Компания Тест|test-invite-token|reader@example.test|name="name"/);
});

test("registration errors identify the failing field and preserve other entered names",async()=>{
  const companyState={error:"Проверьте данные.",fieldErrors:{companyName:"Укажите название компании."},values:{companyName:"   ",managerName:"Введённое имя"}};
  const company=await pageHarness("manager",null,signedIn,companyState)("app/register/page.tsx");
  const companyInput=company.match(/<input\b[^>]*\bname="companyName"[^>]*>/)?.[0]??"";
  assert.match(companyInput,/aria-invalid="true"/);
  const descriptionId=companyInput.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(descriptionId);assert.ok(company.includes(`id="${descriptionId}">Укажите название компании.</p>`));
  assert.match(company,/value="Введённое имя"/);

  const error="Укажите имя.",joinState={error,fieldErrors:{name:error},values:{name:""}};
  const join=await pageHarness("executor",savedCompany,signedIn,joinState)("app/join/[token]/page.tsx",{token:savedCompany.inviteToken});
  const nameInput=join.match(/<input\b[^>]*\bname="name"[^>]*>/)?.[0]??"";
  assert.match(nameInput,/aria-invalid="true"/);assert.match(nameInput,/aria-describedby=/);
  assert.equal(join.split(error).length-1,1);
});

test("employees whose membership was already registered skip the new employee name field",async()=>{
  const page="app/join/[token]/page.tsx", params={token:savedCompany.inviteToken};
  const bound=await pageHarness("executor",savedCompany,signedIn,{}, {displayName:"Имя в команде",bound:true})(page,params);
  assert.match(bound,/Открыть команду/);
  assert.doesNotMatch(bound,/<input(?![^>]*type="hidden")[^>]*\bname="name"/);
  const pending=await pageHarness("viewer",savedCompany,signedIn,{}, {displayName:"Имя в команде",bound:false})(page,params);
  assert.match(pending,/Войти в команду/);assert.match(pending,/Имя в команде/);
  assert.match(pending,/<input type="hidden" name="name" value="Имя в команде"/);
  assert.doesNotMatch(pending,/<input(?![^>]*type="hidden")[^>]*\bname="name"/);
  const foreign=await pageHarness("executor",savedCompany,signedIn,{}, {foreign:true})(page,params);
  assert.match(foreign,/Аккаунт уже связан с другой компанией/);
  assert.match(foreign,/signout-with-chatgpt\?return_to=%2Fjoin%2Ftest-invite-token/);
  assert.doesNotMatch(foreign,/name="name"|Присоединиться к команде|Имя в команде/);
});

test("manager can start removal for registered and unregistered employees only",async()=>{
  const html=await pageHarness()();
  assert.match(html,/href="#team-people"/);
  assert.deepEqual([...html.matchAll(/aria-label="Удалить сотрудника ([^"]+)"/g)].map(match=>match[1]),["Linked","Unlinked"]);
  assert.doesNotMatch(html,/name="confirmed"/);
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
