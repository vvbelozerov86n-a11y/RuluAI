import test from "node:test";
import assert from "node:assert/strict";
import * as policy from "../lib/ruli/policy.ts";
import { notifyGrokBotMessage } from "../lib/ruli/agent-webhook.ts";
import { projectChatAiRuns } from "../lib/ruli/chat-ai.ts";
import { barrier, collaborationHarness, loadModule, makeForm, plain, redirectMessage, TestRedirect } from "./collaboration-helper.mjs";

function fixture(t) { const h = collaborationHarness(); t.after(() => h.close()); return h; }
const message = (overrides = {}) => ({ taskId: "launch", channelMemberId: "", body: "Готовим письмо", clientId: "message-id-0001", ...overrides });
const plan = (overrides = {}) => ({ taskId: "launch", version: 0, startDate: "2026-11-17", hoursPerDay: 8, estimatedHoursPerTask: 4, weekdaysOnly: "on", ...overrides });
const editEntry = (entry, overrides = {}) => ({ taskId: entry.plan_task_id, id: entry.id, version: entry.version, planVersion: 1, startDate: entry.start_date, endDate: entry.end_date, hours: entry.hours, ...overrides });

test("channel policy: manager and matching recipient can read private messages; viewer cannot write", () => {
  const anna = { role: "executor", memberId: "anna" };
  const manager = { role: "manager", memberId: "me" };
  const viewer = { role: "viewer", memberId: "anna" };
  assert.equal(policy.canReadChannel(anna, "anna"), true);
  assert.equal(policy.canReadChannel(anna, "max"), false);
  assert.equal(policy.canReadChannel(manager, "anna"), true);
  assert.equal(policy.canWriteChannel(manager, "anna"), true);
  assert.equal(policy.canReadChannel(viewer, "anna"), true);
  assert.equal(policy.canReadChannel(viewer, "max"), false);
  assert.equal(policy.canReadChannel(viewer, null), true);
  assert.equal(policy.canWriteChannel(viewer, null), false);
  assert.equal(policy.canWriteChannel(viewer, "anna"), false);
  assert.equal(policy.canSubmit(anna, { ownerId: "max", participants: ["anna"] }), true);
  assert.equal(policy.canSubmit(anna, { ownerId: "max", participants: [] }), false);
});

test("actual SELECT never returns Anna's private messages to Max or a viewer, even with forged viewer input", async (t) => {
  const h = fixture(t);
  h.as("anna");
  assert.equal(redirectMessage(await h.invoke("sendMessage", message({ channelMemberId: "anna", body: "Личный черновик" })), "flash"), "Сообщение отправлено");
  await h.invoke("sendMessage", message({ clientId: "general-message-01", body: "Общая новость" }));
  const node = (await h.loadTree()).children.find((item) => item.id === "launch");
  const forgedManager = { role: "manager", memberId: "me" };
  h.as("max");
  const privateAsMax = await h.collaboration.loadTaskCollaboration(node, forgedManager, "anna");
  assert.deepEqual(plain(privateAsMax.messages), []);
  assert.deepEqual(plain(privateAsMax.channels.map((member) => member.id)), ["max"]);
  assert.deepEqual(plain((await h.collaboration.loadTaskCollaboration(node, forgedManager, "general")).messages.map((entry) => entry.body)), ["Общая новость"]);
  h.as("viewer");
  assert.deepEqual(plain((await h.collaboration.loadTaskCollaboration(node, forgedManager, "anna")).messages), []);
  h.as("manager");
  assert.deepEqual(plain((await h.collaboration.loadTaskCollaboration(node, forgedManager, "anna")).messages.map((entry) => entry.body)), ["Личный черновик"]);
});

function messagePages(h) {
  return loadModule("lib/ruli/collaboration.ts", h.common, ["loadMessagePage", "MessagePageError"]);
}

function seedHistory(h, count, { taskId="launch", channel=null, prefix="history", createdAt="2026-11-18T10:00:00.000Z" } = {}) {
  const insert=h.sqlite.prepare(`INSERT INTO task_messages
    (id,task_id,channel_member_id,author_id,author_user_id,author_name,body,client_id,created_at)
    VALUES (?,?,?,'anna','user-anna','Анна',?,?,?)`);
  const ids=[];
  for(let i=1;i<=count;i++) {
    const id=`${prefix}-${String(i).padStart(4,"0")}`;
    insert.run(id,taskId,channel,`Сообщение ${i}`,id,createdAt);
    ids.push(id);
  }
  return ids;
}

test("message history pages all 251 equal-timestamp messages exactly once without OFFSET", async t => {
  const h=fixture(t);
  const expected=seedHistory(h,251);
  const pages=messagePages(h);
  const latest=await pages.loadMessagePage("launch");
  assert.equal(latest.messages.length,100);
  assert.equal(latest.hasMore,true);
  assert.equal(typeof latest.beforeCursor,"string");
  assert.deepEqual(plain(latest.messages.map(item=>item.id)),expected.slice(151));
  const older=await pages.loadMessagePage("launch","general",latest.beforeCursor);
  const oldest=await pages.loadMessagePage("launch",null,older.beforeCursor);
  assert.equal(older.messages.length,100);
  assert.equal(older.hasMore,true);
  assert.equal(oldest.messages.length,51);
  assert.equal(oldest.hasMore,false);
  assert.equal(oldest.beforeCursor,null);
  assert.deepEqual(plain([...oldest.messages,...older.messages,...latest.messages].map(item=>item.id)),expected);
  assert.equal(new Set([...oldest.messages,...older.messages,...latest.messages].map(item=>item.id)).size,251);
  const selects=h.queried.filter(entry=>entry.sql.includes("FROM task_messages"));
  assert.equal(selects.length,3);
  assert.ok(selects.every(entry=>entry.sql.includes("LIMIT 101")&&!/\bOFFSET\b/i.test(entry.sql)));
  assert.ok(selects.every(entry=>!entry.sql.includes("schedule_entries")));
});

test("new messages arriving after a page do not shift its older-history cursor", async t => {
  const h=fixture(t);
  const expected=seedHistory(h,130);
  const pages=messagePages(h);
  const latest=await pages.loadMessagePage("launch");
  seedHistory(h,3,{prefix:"new",createdAt:"2026-11-18T11:00:00.000Z"});
  const older=await pages.loadMessagePage("launch",null,latest.beforeCursor);
  assert.deepEqual(plain(older.messages.map(item=>item.id)),expected.slice(0,30));
  assert.equal(older.hasMore,false);
  const refreshed=await pages.loadMessagePage("launch");
  assert.deepEqual(plain(refreshed.messages.slice(-3).map(item=>item.id)),["new-0001","new-0002","new-0003"]);
});

test("initial collaboration includes history metadata while preserving messages and schedules", async t => {
  const h=fixture(t);
  seedHistory(h,101);
  const node=(await h.loadTree()).children.find(item=>item.id==="launch");
  const data=await h.collaboration.loadTaskCollaboration(node,await h.access.requireAccess());
  assert.equal(data.messages.length,100);
  assert.equal(data.messagePage.hasMore,true);
  assert.equal(typeof data.messagePage.beforeCursor,"string");
  assert.deepEqual(plain(data.entries),[]);
  assert.equal(data.scheduleVersion,0);
  const h2=fixture(t);
  seedHistory(h2,100);
  const page=await messagePages(h2).loadMessagePage("launch");
  assert.equal(page.hasMore,false);
  assert.equal(page.beforeCursor,null);
});

test("latest and older history enforce current private-channel access and cursor scope", async t => {
  const h=fixture(t);
  seedHistory(h,115,{channel:"anna",prefix:"anna"});
  seedHistory(h,1,{channel:"max",prefix:"max"});
  seedHistory(h,1,{prefix:"general"});
  const pages=messagePages(h);
  h.as("anna");
  const privatePage=await pages.loadMessagePage("launch","anna");
  assert.equal(privatePage.messages.length,100);
  const older=await pages.loadMessagePage("launch","anna",privatePage.beforeCursor);
  assert.equal(older.messages.length,15);
  assert.ok([...privatePage.messages,...older.messages].every(item=>item.channelMemberId==="anna"));
  h.as("max");
  for(const before of [undefined,privatePage.beforeCursor]) {
    await assert.rejects(()=>pages.loadMessagePage("launch","anna",before),error=>error instanceof pages.MessagePageError&&error.status===403);
  }
  h.as("viewer");
  await assert.rejects(()=>pages.loadMessagePage("launch","anna",privatePage.beforeCursor),error=>error.status===403);
  assert.deepEqual(plain((await pages.loadMessagePage("launch")).messages.map(item=>item.id)),["general-0001"]);
  h.as("manager");
  await assert.rejects(()=>pages.loadMessagePage("launch","general",privatePage.beforeCursor),error=>error.status===400);
  await assert.rejects(()=>pages.loadMessagePage("service","anna",privatePage.beforeCursor),error=>error.status===400);
  h.sqlite.prepare("UPDATE tasks SET owner_id='max' WHERE id IN ('launch','letter')").run();
  await assert.rejects(()=>pages.loadMessagePage("launch","anna",privatePage.beforeCursor),error=>error.status===403);
});

test("malformed history cursors are rejected without reading message rows", async t => {
  const h=fixture(t);
  const pages=messagePages(h);
  for(const cursor of ["", "not-json", "{}", "[]", "x".repeat(1025),
    JSON.stringify([2,"launch",null,"2026-11-18T00:00:00.000Z","message-1"]),
    JSON.stringify([1,"launch",null,"2026-02-30T00:00:00.000Z","message-1"]),
    JSON.stringify([1,"launch",null,"2026-11-18T25:00:00.000Z","message-1"]),
    JSON.stringify([1,"launch",null,"2026-11-18T00:00:00.000Z","'; DROP TABLE tasks;--"]),
  ]) {
    await assert.rejects(()=>pages.loadMessagePage("launch",null,cursor),error=>error instanceof pages.MessagePageError&&error.status===400);
  }
  assert.equal(h.queried.filter(entry=>entry.sql.includes("FROM task_messages")).length,0);
  assert.ok(h.one("SELECT id FROM tasks WHERE id='launch'"));
});

test("history rejects a deleted task and a task hidden by its deleted ancestor", async t => {
  const h=fixture(t);
  seedHistory(h,1,{taskId:"letter"});
  const pages=messagePages(h);
  h.sqlite.prepare("UPDATE tasks SET deleted_at='2026-11-18' WHERE id='launch'").run();
  for(const taskId of ["launch","letter","missing-task"]) {
    await assert.rejects(()=>pages.loadMessagePage(taskId),error=>error.status===404);
  }
});

function historyRoute(h, extra={}) {
  const pages=messagePages(h);
  return loadModule("app/api/tasks/[id]/messages/route.ts",{
    ...h.common,...pages,projectChatAiRuns,getChatGPTUser:async()=>({userId:"signed-in"}),
    loadTaskAi:async()=>({chatRuns:[]}),...extra,
  },["GET"]).GET;
}

test("history HTTP endpoint exposes pagination and only safe current AI retry fields", async t => {
  const h=fixture(t);
  seedHistory(h,110);
  const run={id:"run-1",kind:"chat",taskId:"launch",botMemberId:"analyst",channelMemberId:null,inputMessageId:"history-0110",
    error:null,status:"pending",canRetry:false,createdAt:"2026-11-18T10:00:00.000Z",finishedAt:null,
    requesterUserId:"not-for-client",output:"private-provider-output",systemPrompt:"not-for-client",leaseToken:"not-for-client"};
  const route=historyRoute(h,{loadTaskAi:async()=>({chatRuns:[run]})});
  const response=await route(new Request("https://ruli.test/api/tasks/launch/messages?channel=general"),{params:Promise.resolve({id:"launch"})});
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Cache-Control"),"private, no-store");
  assert.equal(response.headers.get("Vary"),"Cookie");
  const first=await response.json();
  assert.equal(first.messages.length,100);
  assert.equal(first.hasMore,true);
  assert.equal(first.aiPending,1);
  assert.deepEqual(Object.keys(first.aiRuns[0]).sort(),["id","botMemberId","channelMemberId","inputMessageId","error","status","canRetry","createdAt","finishedAt","output"].sort());
  assert.equal(first.aiRuns[0].output,null);
  assert.equal(JSON.stringify(first).includes("not-for-client"),false);
  assert.equal(JSON.stringify(first).includes("private-provider-output"),false);
  run.status="failed";run.canRetry=true;run.error="Повторите запрос";run.finishedAt="2026-11-18T10:01:00.000Z";
  const params=new URLSearchParams({channel:"general",before:first.beforeCursor});
  const olderResponse=await route(new Request(`https://ruli.test/api/tasks/launch/messages?${params}`),{params:Promise.resolve({id:"launch"})});
  const older=await olderResponse.json();
  assert.equal(older.messages.length,10);
  assert.equal(older.hasMore,false);
  assert.equal(older.beforeCursor,null);
  assert.equal(older.aiPending,0);
  assert.deepEqual(older.aiRuns,[]);
});

test("history HTTP endpoint returns 400/401/403/404 without exposing messages or AI runs", async t => {
  const h=fixture(t);
  seedHistory(h,110,{channel:"anna"});
  const pages=messagePages(h);
  const privatePage=await pages.loadMessagePage("launch","anna");
  const route=historyRoute(h,{loadTaskAi:async()=>{throw new Error("unauthorized AI read");}});
  const bad=await route(new Request("https://ruli.test/api/tasks/launch/messages?before=broken"),{params:Promise.resolve({id:"launch"})});
  assert.equal(bad.status,400);
  h.as("max");
  const query=new URLSearchParams({channel:"anna",before:privatePage.beforeCursor});
  const forbidden=await route(new Request(`https://ruli.test/api/tasks/launch/messages?${query}`),{params:Promise.resolve({id:"launch"})});
  assert.equal(forbidden.status,403);
  assert.deepEqual(Object.keys(await forbidden.json()),["error"]);
  const missing=await route(new Request("https://ruli.test/api/tasks/missing/messages"),{params:Promise.resolve({id:"missing"})});
  assert.equal(missing.status,404);
  const loggedOut=historyRoute(h,{getChatGPTUser:async()=>null});
  const signedOut=await loggedOut(new Request("https://ruli.test/api/tasks/launch/messages"),{params:Promise.resolve({id:"launch"})});
  assert.equal(signedOut.status,401);
});

test("history HTTP exposes saved stale output only inside its authorized task and private channel",async t=>{
  const h=fixture(t);h.seedTask("bot-child",{parentId:"launch",ownerId:"analyst"});
  seedHistory(h,1,{channel:"analyst"});
  const run={id:"saved",kind:"chat",taskId:"launch",channelMemberId:"analyst",botMemberId:"analyst",inputMessageId:"history-0001",status:"stale",canRetry:true,
    error:"changed",output:"PRIVATE_STALE_OUTPUT",createdAt:"2026-11-18",finishedAt:"2026-11-18",requesterUserId:"PRIVATE_REQUESTER",leaseToken:"PRIVATE_LEASE"};
  let loads=0;
  const route=historyRoute(h,{loadTaskAi:async()=>{loads++;return {chatRuns:[run,{...run,id:"foreign",taskId:"other",output:"FOREIGN_TASK_OUTPUT"}]};}});
  const get=channel=>route(new Request(`https://ruli.test/api/tasks/launch/messages?channel=${channel}`),{params:Promise.resolve({id:"launch"})});
  const own=await get("analyst"),body=await own.json();
  assert.equal(own.status,200);assert.equal(body.aiRuns.length,1);assert.equal(body.aiRuns[0].output,"PRIVATE_STALE_OUTPUT");
  assert.doesNotMatch(JSON.stringify(body),/PRIVATE_REQUESTER|PRIVATE_LEASE|FOREIGN_TASK_OUTPUT/);
  const general=await get("general");assert.deepEqual((await general.json()).aiRuns,[]);
  h.as("max");const before=loads,denied=await get("analyst");
  assert.equal(denied.status,403);assert.equal(loads,before);assert.doesNotMatch(JSON.stringify(await denied.json()),/PRIVATE_STALE_OUTPUT/);
});

test("an open own channel stays readable after executor becomes viewer but reports live write denial",async t=>{
  const h=fixture(t);seedHistory(h,1,{channel:"anna"});h.as("anna");
  const route=historyRoute(h);
  const get=()=>route(new Request("https://ruli.test/api/tasks/launch/messages?channel=anna"),{params:Promise.resolve({id:"launch"})});
  const before=await get();assert.equal(before.status,200);assert.equal((await before.json()).canWrite,true);
  h.sqlite.exec("UPDATE team_accounts SET role='viewer' WHERE member_id='anna'");
  const after=await get(),data=await after.json();assert.equal(after.status,200);assert.equal(data.messages.length,1);assert.equal(data.canWrite,false);
});

test("history API scopes AI text to each actual latest or older message page",async t=>{
  const h=fixture(t);seedHistory(h,250);
  const base={kind:"chat",taskId:"launch",channelMemberId:null,botMemberId:"analyst",status:"stale",error:"changed",output:"X".repeat(1000),canRetry:true,createdAt:"2026-11-18",finishedAt:"2026-11-18"};
  const runs=Array.from({length:250},(_,i)=>({...base,id:`run-${i+1}`,inputMessageId:`history-${String(i+1).padStart(4,"0")}`}));
  const scopes=[];
  const route=historyRoute(h,{loadTaskAi:async(_node,_viewer,_channel,ids)=>{scopes.push([...ids]);return {chatRuns:runs};}});
  const get=before=>route(new Request(`https://ruli.test/api/tasks/launch/messages?channel=general${before?`&before=${encodeURIComponent(before)}`:""}`),{params:Promise.resolve({id:"launch"})});
  const latest=await (await get()).json();
  assert.equal(latest.messages.length,100);assert.equal(latest.aiRuns.length,100);
  assert.deepEqual(scopes[0],latest.messages.map(message=>message.id));
  assert.ok(JSON.stringify(latest.aiRuns).length<140000);assert.equal(latest.aiRuns.some(run=>run.id==="run-1"),false);
  const older=await (await get(latest.beforeCursor)).json();
  assert.equal(older.aiRuns.length,100);assert.deepEqual(scopes[1],older.messages.map(message=>message.id));
  assert.equal(older.aiRuns.some(run=>run.id==="run-250"),false);
  assert.ok(older.aiRuns.every(run=>older.messages.some(message=>message.id===run.inputMessageId)));
});

test("history HTTP endpoint converts revoked team access into JSON 403 without redirecting", async t => {
  const h=fixture(t);
  const {redirect}=await import("../node_modules/vinext/dist/shims/navigation-errors.js");
  const identity=h.identities.anna;
  const access=loadModule("lib/ruli/access.ts",{
    ...h.common,env:{},cache:fn=>fn,initRuli:async()=>{},requireChatGPTUser:async()=>identity,redirect,
  },["requireAccess"]);
  const pages=loadModule("lib/ruli/collaboration.ts",{...h.common,...access},["loadMessagePage","MessagePageError"]);
  const route=loadModule("app/api/tasks/[id]/messages/route.ts",{
    ...h.common,...access,...pages,projectChatAiRuns,getChatGPTUser:async()=>identity,loadTaskAi:async()=>({chatRuns:[]}),
  },["GET"]).GET;
  const request=new Request("https://ruli.test/api/tasks/launch/messages?channel=general");
  assert.equal((await route(request,{params:Promise.resolve({id:"launch"})})).status,200);
  h.sqlite.prepare("DELETE FROM team_accounts WHERE user_id=?").run(identity.userId);
  const denied=await route(request,{params:Promise.resolve({id:"launch"})});
  assert.equal(denied.status,403);
  assert.equal(denied.headers.get("location"),null);
  assert.equal(denied.headers.get("content-type"),"application/json");
  assert.deepEqual(Object.keys(await denied.json()),["error"]);
});

test("history HTTP endpoint only converts exact access-denied redirects", async t => {
  const h=fixture(t);
  const request=new Request("https://ruli.test/api/tasks/launch/messages");
  const canonical=Object.assign(new Error("redirect"),{digest:"NEXT_REDIRECT;replace;/access-denied;307;"});
  const converted=await historyRoute(h,{loadMessagePage:async()=>{throw canonical;}})(request,{params:Promise.resolve({id:"launch"})});
  assert.equal(converted.status,403);
  const {redirect}=await import("../node_modules/vinext/dist/shims/navigation-errors.js");
  let signIn;
  try { redirect("/signin-with-chatgpt?return_to=%2F"); } catch(error) { signIn=error; }
  for(const error of [signIn,new Error("database unavailable"),
    Object.assign(new Error("unrelated"),{digest:"NEXT_REDIRECT;;%2Faccess-denied-other"}),
    Object.assign(new Error("external"),{digest:"NEXT_REDIRECT;replace;https://example.test/access-denied;307;"}),
    Object.assign(new Error("invalid"),{digest:"NEXT_REDIRECT;replace;/access-denied;999;"}),
  ]) {
    const route=historyRoute(h,{loadMessagePage:async()=>{throw error;}});
    await assert.rejects(()=>route(request,{params:Promise.resolve({id:"launch"})}),actual=>actual===error);
  }
});

test("send rejects another executor's channel, viewer writes and deleted tasks; preserves entered text", async (t) => {
  const h = fixture(t);
  h.as("max");
  const privateDenied = await h.invoke("sendMessageState", message({ channelMemberId: "anna" }), true);
  assert.match(privateDenied.state.error, /нет доступа/);
  assert.equal(privateDenied.state.values.body, "Готовим письмо");
  h.as("viewer");
  assert.match((await h.invoke("sendMessageState", message(), true)).state.error, /нет доступа/);
  h.as("anna");
  h.sqlite.prepare("UPDATE tasks SET deleted_at='2026-11-17' WHERE id='launch'").run();
  assert.match((await h.invoke("sendMessageState", message(), true)).state.error, /удалена/);
  assert.equal(h.one("SELECT COUNT(*) AS count FROM task_messages").count, 0);
});

test("message INSERT binds author from trusted identity and retry deduplication survives concurrent sends", async (t) => {
  const h = fixture(t);
  h.as("anna");
  const values = message({ channelMemberId: "anna", authorId: "me", author_user_id: "user-manager" });
  const results = await Promise.all([h.invoke("sendMessage", values), h.invoke("sendMessage", values)]);
  assert.ok(results.every((result) => !redirectMessage(result)));
  const rows = h.all("SELECT * FROM task_messages");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].author_id, "anna");
  assert.equal(rows[0].author_user_id, "user-anna");
  assert.equal(rows[0].channel_member_id, "anna");
  assert.equal(rows[0].body, values.body);
  const changed = await h.invoke("sendMessageState", { ...values, body: "Другой текст" }, true);
  assert.match(changed.state.error, /уже было отправлено/);
  assert.equal(changed.state.values.body, "Другой текст");
  assert.equal(h.one("SELECT COUNT(*) AS count FROM task_messages").count, 1);
});

test("message validation rejects excessive length and malformed retry tokens without truncation", async (t) => {
  const h = fixture(t);
  const body = "x".repeat(5001);
  const long = await h.invoke("sendMessageState", message({ body }), true);
  assert.match(long.state.error, /5000/);
  assert.equal(long.state.values.body, body);
  assert.match((await h.invoke("sendMessageState", message({ clientId: "short" }), true)).state.error, /Обновите/);
  assert.equal(h.one("SELECT COUNT(*) AS count FROM task_messages").count, 0);
});

test("message state acknowledges the exact client token without redirect and retries stay idempotent", async (t) => {
  const h = fixture(t);
  h.as("anna");
  const values = message({ channelMemberId: "anna", clientId: "ack-private-001" });
  const sent = await h.invoke("sendMessageState", values, true);
  assert.equal(sent.redirect, undefined);
  assert.deepEqual(plain(sent.state), { sentClientId: values.clientId });
  const retried = await h.invoke("sendMessageState", values, true);
  assert.deepEqual(plain(retried.state), { sentClientId: values.clientId });
  assert.equal(h.one("SELECT COUNT(*) AS count FROM task_messages").count, 1);
  const changed = await h.invoke("sendMessageState", { ...values, body: "Новый черновик" }, true);
  assert.equal(changed.state.sentClientId, undefined);
  assert.equal(changed.state.values.body, "Новый черновик");
  assert.ok(changed.state.error);
  const ordinary = await h.invoke("sendMessage", message({ clientId: "ordinary-send-001" }));
  assert.equal(redirectMessage(ordinary, "flash"), "Сообщение отправлено");
});

test("sending in a group's private agent channel delivers once without notifying another mentioned agent", async t => {
  const h = fixture(t);
  h.seedTask("analyst-child", { parentId: "launch", ownerId: "analyst" });
  h.seedTask("writer-child", { parentId: "launch", ownerId: "writer" });
  for (const memberId of ["analyst", "writer"]) h.sqlite.prepare(`INSERT INTO bot_configs
    (member_id,provider,model,system_prompt,slug,enabled,version,updated_at)
    VALUES (?,'grok-bot','-','',?,1,1,'2026-11-18')`).run(memberId, memberId);
  const sent = [];
  const actions = loadModule("app/collaboration-actions.ts", {
    ...h.common, ...h.collaboration,
    notifyMessageForAgents: (db, task, entry) => notifyGrokBotMessage({
      db, config: { url: "https://hooks.example/synthetic" },
      fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); },
    }, task, entry),
  }, ["sendMessageState"]);
  const form = makeForm(message({ channelMemberId: "analyst", body: "Private @writer", clientId: "private-group-agent-01" }));
  const state = await actions.sendMessageState({}, form);
  assert.deepEqual(plain(state), { sentClientId: "private-group-agent-01" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].bot.slug, "analyst");
  assert.equal(sent[0].task.id, "launch");
  assert.equal(sent[0].message.text, "Private @writer");
  assert.equal(h.one("SELECT channel_member_id FROM task_messages").channel_member_id, "analyst");
  assert.equal(h.one("SELECT status FROM bot_webhook_outbox").status, "delivered");
  await actions.sendMessageState({}, form);
  assert.equal(sent.length, 1);
  assert.equal(h.one("SELECT COUNT(*) AS count FROM task_messages").count, 1);
  h.sqlite.prepare("UPDATE tasks SET owner_id='anna' WHERE id='analyst-child'").run();
  const revoked = await actions.sendMessageState({}, makeForm(message({ channelMemberId: "analyst", clientId: "private-group-revoked-01" })));
  assert.match(revoked.error, /нет доступа/);
  assert.equal(sent.length, 1);
});

test("generate and update schedule actions deny non-managers before writes", async (t) => {
  const h = fixture(t);
  for (const identity of ["anna", "max", "viewer"]) {
    h.as(identity);
    assert.match(redirectMessage(await h.invoke("generateTaskSchedule", plan())), /руководитель/);
    assert.match(redirectMessage(await h.invoke("updateScheduleEntry", { taskId: "launch" })), /руководитель/);
  }
  assert.equal(h.one("SELECT COUNT(*) AS count FROM schedule_entries").count, 0);
  assert.equal(h.one("SELECT COUNT(*) AS count FROM schedule_plans").count, 0);
  assert.equal(h.one("SELECT version FROM tasks WHERE id='root'").version, 1);
});

test("real generation SQL atomically saves entries/settings and rejects a stale same-plan tab", async (t) => {
  const h = fixture(t);
  h.hooks.beforeBatch = barrier();
  const result = await Promise.all([h.invoke("generateTaskSchedule", plan()), h.invoke("generateTaskSchedule", plan())]);
  assert.equal(result.filter((entry) => !redirectMessage(entry)).length, 1);
  assert.equal(result.filter((entry) => /другой вкладке/.test(redirectMessage(entry))).length, 1);
  assert.equal(h.one("SELECT version FROM tasks WHERE id='root'").version, 2);
  assert.deepEqual(h.one("SELECT version,hours_per_day,weekdays_only FROM schedule_plans WHERE task_id='launch'"), { version: 1, hours_per_day: 8, weekdays_only: 1 });
  assert.equal(h.one("SELECT COUNT(*) AS count FROM schedule_entries").count, 2);
  assert.ok(h.all("SELECT * FROM schedule_entries").every((entry) => entry.plan_task_id === "launch" && entry.hours === 4 && entry.version === 1));
});

test("two different plans racing for the same capacity serialize through the root CAS", async (t) => {
  const h = fixture(t);
  h.hooks.beforeBatch = barrier();
  const result = await Promise.all([h.invoke("generateTaskSchedule", plan({ hoursPerDay: 4 })), h.invoke("generateTaskSchedule", plan({ taskId: "service", hoursPerDay: 4 }))]);
  assert.equal(result.filter((entry) => !redirectMessage(entry)).length, 1);
  assert.equal(result.filter((entry) => redirectMessage(entry)).length, 1);
  const totals = h.all("SELECT member_id,start_date,SUM(hours) AS hours FROM schedule_entries GROUP BY member_id,start_date");
  assert.ok(totals.every((entry) => entry.hours <= 4));
});

test("generation accounts for existing other-plan work while replacement does not reserve itself twice", async (t) => {
  const h = fixture(t);
  assert.equal(redirectMessage(await h.invoke("generateTaskSchedule", plan({ taskId: "service", hoursPerDay: 4 }))), null);
  assert.equal(redirectMessage(await h.invoke("generateTaskSchedule", plan({ hoursPerDay: 4 }))), null);
  const first = h.one("SELECT start_date FROM schedule_entries WHERE task_id='letter'").start_date;
  assert.equal(first, "2026-11-18");
  assert.equal(redirectMessage(await h.invoke("generateTaskSchedule", plan({ version: 1, hoursPerDay: 4, replaceConfirmed: "yes" }))), null);
  assert.equal(h.one("SELECT start_date FROM schedule_entries WHERE task_id='letter'").start_date, first);
  assert.equal(h.one("SELECT COUNT(*) AS count FROM schedule_entries WHERE plan_task_id='launch'").count, 2);
});

test("manual schedule update uses entry and plan CAS; stale tabs cannot overwrite each other", async (t) => {
  const h = fixture(t);
  await h.invoke("generateTaskSchedule", plan());
  const entry = h.one("SELECT * FROM schedule_entries WHERE task_id='letter'");
  h.hooks.beforeBatch = barrier();
  const results = await Promise.all([
    h.invoke("updateScheduleEntry", editEntry(entry, { startDate: "2026-11-18", endDate: "2026-11-18" })),
    h.invoke("updateScheduleEntry", editEntry(entry, { startDate: "2026-11-19", endDate: "2026-11-19" })),
  ]);
  assert.equal(results.filter((result) => !redirectMessage(result)).length, 1);
  assert.equal(results.filter((result) => /другой вкладке/.test(redirectMessage(result))).length, 1);
  assert.equal(h.one("SELECT version FROM schedule_entries WHERE id=?", entry.id).version, 2);
  assert.equal(h.one("SELECT version FROM schedule_plans WHERE task_id='launch'").version, 2);
});

test("manual updates reject other-plan workload conflicts, weekends and invalid dates without writes", async (t) => {
  const h = fixture(t);
  await h.invoke("generateTaskSchedule", plan({ taskId: "service", hoursPerDay: 4 }));
  await h.invoke("generateTaskSchedule", plan({ hoursPerDay: 4 }));
  const entry = h.one("SELECT * FROM schedule_entries WHERE task_id='letter'");
  const version = h.one("SELECT version FROM tasks WHERE id='root'").version;
  assert.match(redirectMessage(await h.invoke("updateScheduleEntry", editEntry(entry, { startDate: "2026-11-17", endDate: "2026-11-17" }))), /превышена дневная загрузка/);
  assert.match(redirectMessage(await h.invoke("updateScheduleEntry", editEntry(entry, { startDate: "2026-11-21", endDate: "2026-11-21" }))), /выходные/);
  assert.match(redirectMessage(await h.invoke("updateScheduleEntry", editEntry(entry, { startDate: "2026-02-31", endDate: "2026-02-31" }))), /существующие даты/);
  assert.deepEqual(h.one("SELECT * FROM schedule_entries WHERE id=?", entry.id), entry);
  assert.equal(h.one("SELECT version FROM tasks WHERE id='root'").version, version);
});

test("manual moves preserve the edit and explicitly name missed leaf and ancestor deadlines", async (t) => {
  const h = fixture(t);
  h.sqlite.prepare("UPDATE tasks SET due_date=? WHERE id IN ('root','launch','letter')").run("2027-01-05");
  await h.invoke("generateTaskSchedule", plan({ startDate: "2027-01-05", hoursPerDay: 4 }));
  const entry = h.one("SELECT * FROM schedule_entries WHERE task_id='letter'");
  const moved = await h.invoke("updateScheduleEntry", editEntry(entry, { startDate: "2027-01-08", endDate: "2027-01-08" }));
  assert.equal(redirectMessage(moved), null);
  const notice = redirectMessage(moved, "flash");
  assert.match(notice, /Предупреждение: нарушены сроки/);
  for (const title of ["root", "launch", "letter"]) {
    assert.ok(notice.includes(`«${title}»: срок 2027-01-05, окончание этапа 2027-01-08`));
  }
  assert.equal(h.one("SELECT end_date FROM schedule_entries WHERE id=?", entry.id).end_date, "2027-01-08");
});

test("completed future work stays in display history while generation and manual edits release its capacity", async (t) => {
  const h = fixture(t);
  await h.invoke("generateTaskSchedule", plan({ taskId: "service", startDate: "2027-01-05", hoursPerDay: 4 }));
  h.sqlite.prepare("UPDATE tasks SET status='done',result='Принято' WHERE id='help'").run();
  assert.equal(redirectMessage(await h.invoke("generateTaskSchedule", plan({ startDate: "2027-01-05", hoursPerDay: 4, estimatedHoursPerTask: 8 }))), null);
  const letter = h.one("SELECT * FROM schedule_entries WHERE task_id='letter' ORDER BY start_date LIMIT 1");
  assert.equal(letter.start_date, "2027-01-05");
  assert.equal(redirectMessage(await h.invoke("updateScheduleEntry", editEntry(letter))), null);
  const history = h.one("SELECT * FROM schedule_entries WHERE task_id='help'");
  const edited = await h.invoke("updateScheduleEntry", editEntry(history, { startDate: "2027-01-06", endDate: "2027-01-06" }));
  assert.equal(redirectMessage(edited), null, "historical done entry must not compete with the active letter on January 6");
  const service = (await h.loadTree()).children.find(node => node.id === "service");
  const displayed = await h.collaboration.loadTaskCollaboration(service, await h.access.requireAccess());
  assert.equal(displayed.entries.length, 1);
  assert.equal(displayed.entries[0].taskId, "help");
  assert.equal(displayed.entries[0].endDate, "2027-01-06");
  assert.equal(h.all(h.collaboration.workloadSelect).some(entry => entry.taskId === "help"), false);
});

test("higher-capacity generation and manual edits cannot override a stricter overlapping plan", async (t) => {
  const h = fixture(t);
  await h.invoke("generateTaskSchedule", plan({ taskId: "service", startDate: "2027-01-05", hoursPerDay: 4, estimatedHoursPerTask: 2 }));
  await h.invoke("generateTaskSchedule", plan({ startDate: "2027-01-05", hoursPerDay: 8, estimatedHoursPerTask: 4 }));
  assert.deepEqual(h.all("SELECT start_date,hours FROM schedule_entries WHERE task_id='letter' ORDER BY start_date"), [
    { start_date: "2027-01-05", hours: 2 }, { start_date: "2027-01-06", hours: 2 },
  ]);
  const entry = h.one("SELECT * FROM schedule_entries WHERE task_id='letter' ORDER BY start_date LIMIT 1");
  const refused = await h.invoke("updateScheduleEntry", editEntry(entry, { hours: 3 }));
  assert.match(redirectMessage(refused), /превышена дневная загрузка.*4 ч/);
  assert.equal(h.one("SELECT hours FROM schedule_entries WHERE id=?", entry.id).hours, 2);
});

test("requireAccess rejects uninvited identities, binds invitations once and ignores caller role claims", async (t) => {
  const h = fixture(t);
  h.as("stranger");
  await assert.rejects(() => h.access.requireAccess(), (error) => error instanceof TestRedirect && error.url === "/access-denied");
  h.sqlite.prepare("INSERT INTO team_accounts(email,member_id,role) VALUES ('invited@example.test','maria','executor')").run();
  h.as({ userId: "verified-invite", email: " Invited@Example.Test ", role: "manager" });
  const access = await h.access.requireAccess();
  assert.equal(access.role, "executor");
  assert.equal(access.memberId, "maria");
  assert.equal(h.one("SELECT user_id FROM team_accounts WHERE member_id='maria'").user_id, "verified-invite");
  h.as({ userId: "different-identity", email: "invited@example.test" });
  await assert.rejects(() => h.access.requireAccess(), (error) => error.url === "/access-denied");
});

test("only configured owner may bootstrap manager access; ordinary first visitor is never promoted", async (t) => {
  const h = fixture(t);
  h.sqlite.exec("DELETE FROM team_accounts");
  h.as("stranger");
  await assert.rejects(() => h.access.requireAccess(), (error) => error.url === "/access-denied");
  assert.equal(h.one("SELECT COUNT(*) AS count FROM team_accounts").count, 0);
  h.env.RULI_OWNER_EMAIL = " MANAGER@EXAMPLE.TEST ";
  h.as("manager");
  const owner = await h.access.requireAccess();
  assert.equal(owner.role, "manager");
  assert.equal(owner.memberId, "me");
});

test("team action is manager-only, refuses manager escalation and binds a new human account", async (t) => {
  const h = fixture(t);
  h.as("anna");
  assert.equal((await h.invoke("addTeamMember", { email: "new@example.test", name: "Новый участник", role: "executor" })).redirect, "/access-denied");
  h.as("manager");
  assert.match(redirectMessage(await h.invoke("addTeamMember", { email: "new@example.test", name: "Новый участник", role: "manager" })), /роль/);
  assert.match(redirectMessage(await h.invoke("addTeamMember", { email: "new@example.test", name: "Новый участник", role: "executor", memberId: "writer" })), /человека/);
  assert.equal(redirectMessage(await h.invoke("addTeamMember", { email: " NEW@example.test ", name: "Новый Участник", role: "executor" })), null);
  const account = h.one("SELECT * FROM team_accounts WHERE email='new@example.test'");
  assert.equal(account.role, "executor");
  assert.equal(account.user_id, null);
  assert.deepEqual(h.one("SELECT name,initials,type FROM members WHERE id=?", account.member_id), { name: "Новый Участник", initials: "НУ", type: "human" });
});

test("simultaneous duplicate invitations roll back the losing member insert", async (t) => {
  const h = fixture(t);
  const before = h.one("SELECT COUNT(*) AS count FROM members").count;
  h.hooks.beforeBatch = barrier();
  const results = await Promise.all([
    h.invoke("addTeamMember", { email: "new@example.test", name: "Новый Участник", role: "executor" }),
    h.invoke("addTeamMember", { email: "new@example.test", name: "Новый Участник", role: "executor" }),
  ]);
  assert.equal(results.filter((result) => !redirectMessage(result)).length, 1);
  assert.equal(results.filter((result) => redirectMessage(result)).length, 1);
  assert.equal(h.one("SELECT COUNT(*) AS count FROM members").count, before + 1);
  assert.equal(h.one("SELECT COUNT(*) AS count FROM team_accounts WHERE email='new@example.test'").count, 1);
});

test("overlapping ancestor/descendant plans are refused without duplicating or changing scheduled work", async (t) => {
  const h = fixture(t);
  await h.invoke("generateTaskSchedule", plan());
  const before = h.all("SELECT * FROM schedule_entries ORDER BY id");
  const rootVersion = h.one("SELECT version FROM tasks WHERE id='root'").version;
  const result = await h.invoke("generateTaskSchedule", plan({ taskId: "root" }));
  assert.ok(redirectMessage(result), "overlapping plans must produce an error");
  assert.deepEqual(h.all("SELECT * FROM schedule_entries ORDER BY id"), before);
  assert.equal(h.one("SELECT version FROM tasks WHERE id='root'").version, rootVersion);
  assert.equal(h.one("SELECT SUM(hours) AS hours FROM schedule_entries WHERE task_id='letter'").hours, 4);
});

test("replacing an existing plan requires explicit confirmation and otherwise preserves manual changes", async (t) => {
  const h = fixture(t);
  await h.invoke("generateTaskSchedule", plan());
  const before = h.all("SELECT * FROM schedule_entries ORDER BY id");
  const result = await h.invoke("generateTaskSchedule", plan({ version: 1, estimatedHoursPerTask: 8 }));
  assert.ok(redirectMessage(result));
  assert.deepEqual(h.all("SELECT * FROM schedule_entries ORDER BY id"), before);
  assert.equal(h.one("SELECT version FROM schedule_plans WHERE task_id='launch'").version, 1);
  assert.equal(redirectMessage(await h.invoke("clearTaskSchedule", { taskId: "launch", version: 1, confirmClear: "yes" })), null);
  const clearedVersion = h.one("SELECT version FROM schedule_plans WHERE task_id='launch'").version;
  assert.ok(clearedVersion > 1);
  assert.equal(redirectMessage(await h.invoke("generateTaskSchedule", plan({ version: clearedVersion }))), null);
  assert.equal(h.one("SELECT COUNT(*) AS count FROM schedule_entries WHERE plan_task_id='launch'").count, 2);
});

test("clearTaskSchedule requires manager, confirmation and current plan version", async (t) => {
  const h = fixture(t);
  await h.invoke("generateTaskSchedule", plan());
  const values = { taskId: "launch", version: 1, confirmClear: "yes" };
  const before = h.all("SELECT * FROM schedule_entries ORDER BY id");
  h.as("anna");
  assert.ok(redirectMessage(await h.invoke("clearTaskSchedule", values)));
  h.as("manager");
  assert.ok(redirectMessage(await h.invoke("clearTaskSchedule", { ...values, confirmClear: undefined })));
  assert.ok(redirectMessage(await h.invoke("clearTaskSchedule", { ...values, version: 99 })));
  assert.deepEqual(h.all("SELECT * FROM schedule_entries ORDER BY id"), before);
  assert.equal(h.one("SELECT version FROM schedule_plans WHERE task_id='launch'").version, 1);
});

test("clearTaskSchedule serializes stale tabs and releases tasks for an ancestor plan", async (t) => {
  const h = fixture(t);
  await h.invoke("generateTaskSchedule", plan());
  h.hooks.beforeBatch = barrier();
  const values = { taskId: "launch", version: 1, confirmClear: "yes" };
  const result = await Promise.all([h.invoke("clearTaskSchedule", values), h.invoke("clearTaskSchedule", values)]);
  assert.equal(result.filter((entry) => !redirectMessage(entry)).length, 1);
  assert.equal(result.filter((entry) => redirectMessage(entry)).length, 1);
  assert.equal(h.one("SELECT COUNT(*) AS count FROM schedule_entries WHERE plan_task_id='launch'").count, 0);
  assert.ok(h.one("SELECT version FROM schedule_plans WHERE task_id='launch'").version > 1);
  h.hooks.beforeBatch = null;
  assert.equal(redirectMessage(await h.invoke("generateTaskSchedule", plan({ taskId: "root" }))), null);
  assert.equal(h.one("SELECT SUM(hours) AS hours FROM schedule_entries WHERE task_id='letter'").hours, 4);
  assert.equal(h.one("SELECT COUNT(DISTINCT plan_task_id) AS count FROM schedule_entries WHERE task_id='letter'").count, 1);
});

test("assigned observers read their own latest and older private messages without gaining write access",async t=>{
  const h=fixture(t);
  h.sqlite.prepare("INSERT INTO task_participants(task_id,member_id) VALUES('letter','observer')").run();
  const node=h.common.findPath("letter",await h.loadTree()).at(-1);
  const sent=await h.actions.sendMessageState({},makeForm(message({taskId:"letter",channelMemberId:"observer",clientId:"observer-manager-message"})));
  assert.equal(sent.sentClientId,"observer-manager-message");
  for(let index=0;index<101;index++)h.sqlite.prepare(`INSERT INTO task_messages
    (id,task_id,channel_member_id,author_id,author_user_id,author_name,body,client_id,created_at)
    VALUES(?,'letter','observer','me','user-manager','Manager',?,?,'2026-11-18T01:00:00Z')`)
    .run(`observer-history-${index}`,`Message ${index}`,`observer-history-client-${index}`);
  h.as("viewer");
  const viewer=await h.access.requireAccess();
  const view=await h.collaboration.loadTaskCollaboration(node,viewer,"observer");
  assert.deepEqual(plain(view.channels.map(member=>member.id)),["observer"]);
  assert.equal(view.messages.length,100);assert.equal(view.messagePage.hasMore,true);
  const pages=loadModule("lib/ruli/collaboration.ts",h.common,["loadMessagePage"]);
  const earlier=await pages.loadMessagePage("letter","observer",view.messagePage.beforeCursor);
  assert.equal(earlier.messages.length,2);
  assert.ok([...view.messages,...earlier.messages].every(item=>item.channelMemberId==="observer"));
  await assert.rejects(pages.loadMessagePage("letter","anna"),error=>error.status===403);
  const before=h.one("SELECT COUNT(*) n FROM task_messages").n;
  const blocked=await h.actions.sendMessageState({},makeForm(message({taskId:"letter",channelMemberId:"observer",clientId:"observer-cannot-send"})));
  assert.match(blocked.error,/нет доступа/);
  assert.equal(h.one("SELECT COUNT(*) n FROM task_messages").n,before);
  h.sqlite.prepare("DELETE FROM task_participants WHERE task_id='letter' AND member_id='observer'").run();
  await assert.rejects(pages.loadMessagePage("letter","observer"),error=>error.status===403);
  await assert.rejects(pages.loadMessagePage("letter","observer",view.messagePage.beforeCursor),error=>error.status===403);
});
