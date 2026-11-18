import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {collaborationHarness,loadModule,makeForm,TestRedirect,plain} from "./collaboration-helper.mjs";
import * as provider from "../lib/ruli/ai-provider.ts";
import * as mutations from "../lib/ruli/mutations.ts";
import {projectChatAiRuns} from "../lib/ruli/chat-ai.ts";
import {getCompanyIntegrations} from "../lib/ruli/company-integrations.ts";

function exported(file) {
  return [...fs.readFileSync(new URL(`../${file}`,import.meta.url),"utf8").matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/gm)].map(match=>match[1]);
}
function harness(t) {
  const h=collaborationHarness();t.after(()=>h.close());
  h.env.XAI_API_KEY="test-only-not-a-real-secret";
  h.seedTask("ai-task",{ownerId:"analyst",title:"План запуска"});
  h.sqlite.prepare("UPDATE tasks SET description='Подготовь краткий план запуска' WHERE id='ai-task'").run();
  h.sqlite.prepare("INSERT INTO task_participants(task_id,member_id) VALUES('ai-task','anna')").run();
  for(const id of ["analyst","writer"])h.sqlite.prepare("INSERT INTO bot_configs(member_id,provider,model,system_prompt,enabled,version,updated_at) VALUES(?,'xai','test-model','Отвечай кратко',1,1,?)").run(id,new Date().toISOString());
  const requests=[];
  let responder=async()=>({text:"Подготовленный результат",inputTokens:10,outputTokens:20});
  const bindings={...h.common,...mutations,...provider,env:h.env,getCompanyIntegrations,getCurrentWorkspaceId:async()=>"legacy",
    generateAiText:async(input)=>{requests.push(plain(input));return responder(input);}};
  const ai=loadModule("lib/ruli/ai.ts",bindings,exported("lib/ruli/ai.ts"));
  const actions=loadModule("app/ai-actions.ts",{...bindings,...ai},exported("app/ai-actions.ts"));
  const chat=loadModule("app/collaboration-actions.ts",{...bindings,...ai,...h.collaboration},["sendMessageState"]);
  const invoke=async(name,values)=>{try{return await actions[name]({},makeForm(values));}catch(error){if(error instanceof TestRedirect)return {redirect:error.url};throw error;}};
  let serial=0;
  function human({taskId="ai-task",channel=null,userId="user-manager",memberId="me",body="Составь план",id=`human-${++serial}`,clientId=`client-message-${serial}`}={}) {
    h.sqlite.prepare("INSERT INTO task_messages(id,task_id,channel_member_id,author_id,author_user_id,author_name,body,client_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id,taskId,channel,memberId,userId,"Человек",body,clientId,new Date(Date.now()+serial).toISOString());
    return {id,clientId};
  }
  return {...h,ai,actions,chat,invoke,requests,human,respond(fn){responder=fn;}};
}
const taskRequest=(extra={})=>({taskId:"ai-task",botMemberId:"analyst",version:1,clientId:"task-request-0001",...extra});
const chatRequest=(message,extra={})=>({taskId:"ai-task",botMemberId:"analyst",channelMemberId:null,clientId:message.clientId,inputMessageId:message.id,...extra});

test("AI task result goes to review and preserves usage",async t=>{
  const h=harness(t);const result=await h.invoke("runTaskAiState",taskRequest());
  assert.equal(result.aiStatus,"succeeded",JSON.stringify(result));
  assert.equal(h.one("SELECT status FROM tasks WHERE id='ai-task'").status,"review");
  assert.equal(h.one("SELECT result FROM tasks WHERE id='ai-task'").result,"Подготовленный результат");
  const run=h.one("SELECT * FROM ai_runs");assert.equal(run.input_tokens,10);assert.equal(run.output_tokens,20);assert.equal(run.active_key,null);
  assert.equal(h.requests.length,1);
});

test("AI task rejects viewer and unrelated executor, permits explicit participant",async t=>{
  const h=harness(t);
  h.as("viewer");assert.ok((await h.invoke("runTaskAiState",taskRequest())).error);
  h.as("max");assert.ok((await h.invoke("runTaskAiState",taskRequest())).error);
  assert.equal(h.requests.length,0);
  h.as("anna");assert.equal((await h.invoke("runTaskAiState",taskRequest())).aiStatus,"succeeded");
});

test("AI task cannot run for human owner, review, done, deleted, or wrong version",async t=>{
  const h=harness(t);
  for(const updates of ["owner_id='anna'","status='review'","status='done'","deleted_at='2026-11-17'","version=2"]){
    h.sqlite.prepare("UPDATE tasks SET owner_id='analyst',status='todo',deleted_at=NULL,version=1 WHERE id='ai-task'").run();
    h.sqlite.exec(`UPDATE tasks SET ${updates} WHERE id='ai-task'`);
    assert.ok((await h.invoke("runTaskAiState",taskRequest())).error,updates);
  }
  assert.equal(h.requests.length,0);
});

test("AI task does not overwrite a concurrent human edit",async t=>{
  const h=harness(t);h.respond(async()=>{h.sqlite.prepare("UPDATE tasks SET description='Новые требования',result='Ручной результат',version=version+1 WHERE id='ai-task'").run();return {text:"Старый AI-ответ",inputTokens:1,outputTokens:2};});
  const result=await h.invoke("runTaskAiState",taskRequest());
  assert.equal(result.aiStatus,"stale");
  assert.equal(h.one("SELECT result,status FROM tasks WHERE id='ai-task'").result,"Ручной результат");
  assert.equal(h.one("SELECT output FROM ai_runs").output,"Старый AI-ответ");
});

test("AI private chat reads only its channel and records bot author",async t=>{
  const h=harness(t);
  h.human({channel:null,body:"GENERAL_SECRET"});h.human({channel:"anna",body:"ANNA_PRIVATE_SECRET"});
  const message=h.human({channel:"analyst",body:"BOT_CHANNEL_QUESTION"});
  const run=await h.ai.requestAiReply(chatRequest(message,{channelMemberId:"analyst"}));
  assert.equal(run.status,"succeeded");
  const prompt=JSON.stringify(h.requests[0]);assert.match(prompt,/BOT_CHANNEL_QUESTION/);assert.doesNotMatch(prompt,/GENERAL_SECRET|ANNA_PRIVATE_SECRET/);
  const reply=h.one("SELECT * FROM task_messages WHERE author_id='analyst'");assert.equal(reply.channel_member_id,"analyst");assert.equal(reply.body,"Подготовленный результат");
});

test("AI general context and task context do not disclose private conversations",async t=>{
  const h=harness(t);h.human({channel:"analyst",body:"PRIVATE_BOT_SECRET"});h.human({channel:"anna",body:"PRIVATE_HUMAN_SECRET"});
  const m=h.human({body:"GENERAL_QUESTION"});await h.ai.requestAiReply(chatRequest(m));
  await h.invoke("runTaskAiState",taskRequest());
  assert.equal(h.requests.length,2);
  for(const request of h.requests)assert.doesNotMatch(JSON.stringify(request),/PRIVATE_BOT_SECRET|PRIVATE_HUMAN_SECRET/);
});

test("AI private chat access stays manager-only and input author cannot be forged",async t=>{
  const h=harness(t);const m=h.human({channel:"analyst"});h.as("anna");
  await assert.rejects(h.ai.requestAiReply(chatRequest(m,{channelMemberId:"analyst"})));
  const general=h.human();await assert.rejects(h.ai.requestAiReply(chatRequest(general)));
  assert.equal(h.requests.length,0);
});

test("AI replies only for task participant bots and exact saved input channel",async t=>{
  const h=harness(t);const m=h.human();
  await assert.rejects(h.ai.requestAiReply(chatRequest(m,{botMemberId:"writer"})));
  await assert.rejects(h.ai.requestAiReply(chatRequest(m,{channelMemberId:"analyst"})));
  await assert.rejects(h.ai.requestAiReply(chatRequest(m,{inputMessageId:"missing-input"})));
  assert.equal(h.requests.length,0);
});

test("AI successful chat request is idempotent across client request IDs",async t=>{
  const h=harness(t);const m=h.human();
  const first=await h.ai.requestAiReply(chatRequest(m));
  const second=await h.ai.requestAiReply(chatRequest(m,{clientId:"different-retry-01"}));
  assert.equal(second.id,first.id);assert.equal(second.status,"succeeded");assert.equal(h.requests.length,1);
  assert.equal(h.all("SELECT id FROM task_messages WHERE author_id='analyst'").length,1);
});

test("AI failed reply can be retried without duplicating the human message",async t=>{
  const h=harness(t);const m=h.human();h.respond(async()=>{throw new provider.AiProviderError("rate_limited");});
  const failed=await h.ai.requestAiReply(chatRequest(m));assert.equal(failed.status,"failed");
  h.respond(async()=>({text:"Успешный повтор",inputTokens:1,outputTokens:2}));
  assert.equal((await h.ai.requestAiReply(chatRequest(m))).status,"failed");
  assert.equal(h.requests.length,1,"ordinary message retries must not issue another paid request");
  const retried=await h.ai.retryAiChat(chatRequest(m,{clientId:"retry-request-0002"}));
  assert.equal(retried.status,"succeeded");assert.equal(retried.id,failed.id);
  assert.equal(h.all("SELECT id FROM task_messages WHERE author_id='me'").length,1);
  assert.equal(h.all("SELECT id FROM task_messages WHERE author_id='analyst'").length,1);
});

test("AI preflight without key leaves the message draft unsent",async t=>{
  const h=harness(t);delete h.env.XAI_API_KEY;
  const result=await h.chat.sendMessageState({},makeForm({taskId:"ai-task",channelMemberId:"analyst",body:"Черновик",clientId:"draft-message-0001"}));
  assert.ok(result.error);assert.equal(result.sentClientId,undefined);
  assert.equal(h.all("SELECT id FROM task_messages").length,0);assert.equal(h.requests.length,0);
});

test("AI error after sending acknowledges human draft and exposes safe retry",async t=>{
  const h=harness(t);h.respond(async()=>{throw new Error("Secret upstream error test-only-not-a-real-secret");});
  const result=await h.chat.sendMessageState({},makeForm({taskId:"ai-task",channelMemberId:"analyst",body:"Вопрос",clientId:"sent-message-0001"}));
  assert.equal(result.sentClientId,"sent-message-0001");assert.equal(result.aiStatus,"failed");assert.equal(result.error,undefined);assert.ok(result.aiRunId);
  assert.doesNotMatch(JSON.stringify(result),/test-only-not-a-real-secret|upstream/);
  assert.equal(h.all("SELECT id FROM task_messages WHERE author_id='me'").length,1);
});

test("AI bot configuration is manager-only and rejects stale version",async t=>{
  const h=harness(t);const form={memberId:"analyst",version:1,name:"Аналитик",role:"Анализ",provider:"xai",model:"test-model",systemPrompt:"Помоги",enabled:"on"};
  h.as("anna");assert.ok((await h.invoke("saveBotState",form)).error);h.as("manager");
  const first=await h.invoke("saveBotState",form);assert.equal(first.error,undefined,JSON.stringify(first));
  assert.equal(h.one("SELECT version FROM bot_configs WHERE member_id='analyst'").version,2);
  assert.ok((await h.invoke("saveBotState",{...form,name:"Устаревшая правка"})).error);
  assert.equal(h.one("SELECT name FROM members WHERE id='analyst'").name,"Аналитик");
});

test("AI config and view loaders never serialize the key",async t=>{
  const h=harness(t);const settings=await h.ai.loadBotSettings();
  assert.doesNotMatch(JSON.stringify(settings),/test-only-not-a-real-secret/);
  const node=(await h.loadTree()).children.find(node=>node.id==="ai-task");
  const data=await h.ai.loadTaskAi(node,await h.access.requireAccess());
  assert.doesNotMatch(JSON.stringify(data),/test-only-not-a-real-secret/);
  assert.equal(settings.providers.find(item=>item.id==="xai").configured,true);
});

test("AI context preserves the end of the current 5000-character message",async t=>{
  const h=harness(t);const m=h.human({body:"А".repeat(4900)+"КРИТИЧЕСКОЕ_УСЛОВИЕ_В_КОНЦЕ"});
  await h.ai.requestAiReply(chatRequest(m));
  assert.match(JSON.stringify(h.requests[0]),/КРИТИЧЕСКОЕ_УСЛОВИЕ_В_КОНЦЕ/);
});

test("AI pending duplicate and competing task run do not call provider twice",async t=>{
  const h=harness(t);const m=h.human();let release,started;
  const gate=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
  h.respond(async()=>{started();await gate;return {text:"Единственный ответ",inputTokens:1,outputTokens:2};});
  const first=h.ai.requestAiReply(chatRequest(m));await ready;
  const duplicate=await h.ai.requestAiReply(chatRequest(m));assert.equal(duplicate.status,"pending");
  const task=await h.invoke("runTaskAiState",taskRequest());assert.equal(task.aiStatus,"failed");
  assert.equal(h.requests.length,1);release();assert.equal((await first).status,"succeeded");
});

test("AI expired lease cannot overwrite a later successful retry",async t=>{
  const h=harness(t);const m=h.human();let release,started;
  const gate=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
  h.respond(async()=>{started();await gate;return {text:"Старый запоздалый ответ",inputTokens:1,outputTokens:2};});
  const first=h.ai.requestAiReply(chatRequest(m));await ready;
  h.sqlite.prepare("UPDATE ai_runs SET lease_expires_at='2000-01-01T00:00:00.000Z'").run();
  h.respond(async()=>({text:"Новый ответ",inputTokens:3,outputTokens:4}));
  const second=await h.ai.retryAiChat(chatRequest(m,{clientId:"lease-retry-0002"}));assert.equal(second.status,"succeeded");
  release();await first;
  assert.equal(h.one("SELECT output FROM ai_runs").output,"Новый ответ");
  assert.deepEqual(h.all("SELECT body FROM task_messages WHERE author_id='analyst'"),[{body:"Новый ответ"}]);
});

test("AI config change during generation retains output without publishing it",async t=>{
  const h=harness(t);const m=h.human();
  h.respond(async()=>{h.sqlite.prepare("UPDATE bot_configs SET enabled=0,version=version+1 WHERE member_id='analyst'").run();return {text:"Устаревший ответ",inputTokens:1,outputTokens:1};});
  const run=await h.ai.requestAiReply(chatRequest(m));assert.equal(run.status,"stale");
  assert.equal(h.all("SELECT id FROM task_messages WHERE author_id='analyst'").length,0);assert.equal(run.output,"Устаревший ответ");
  const node=h.common.findPath("ai-task",await h.loadTree()).at(-1);
  assert.equal((await h.ai.loadTaskAi(node,{})).chatRuns.find(item=>item.id===run.id).canRetry,false);
  await assert.rejects(()=>h.ai.retryAiChat(chatRequest(m,{runId:run.id})),/выключен/);
  h.sqlite.exec("UPDATE bot_configs SET enabled=1,model='updated-model',version=version+1 WHERE member_id='analyst'");
  h.respond(async()=>({text:"Ответ новой модели",inputTokens:1,outputTokens:1}));
  const fresh=await h.ai.retryAiChat(chatRequest(m,{runId:run.id}));
  assert.equal(fresh.status,"succeeded");assert.notEqual(fresh.id,run.id);assert.equal(h.requests.at(-1).model,"updated-model");
  assert.equal(h.one("SELECT output FROM ai_runs WHERE id=?",run.id).output,"Устаревший ответ");
});

test("inherited group executors receive an explicit chat AI restriction without changing provider readiness",async t=>{
  const h=harness(t);h.seedTask("group-model",{parentId:"launch",ownerId:"analyst"});h.as("max");
  const group=h.common.findPath("launch",await h.loadTree()).at(-1);
  const data=await h.ai.loadTaskAi(group,{role:"manager"});
  assert.match(data.chatDisabledReason,/назначенные непосредственно/);
  assert.equal(data.bots.find(bot=>bot.memberId==="analyst").ready,true);
  const plainReply=await h.chat.sendMessageState({},makeForm({taskId:"launch",body:"Для команды",clientId:"group-plain-001"}));
  assert.equal(plainReply.sentClientId,"group-plain-001");
  const blocked=await h.chat.sendMessageState({},makeForm({taskId:"launch",body:"Для модели",clientId:"group-model-001",botMemberId:"analyst"}));
  assert.match(blocked.error,/назначенные непосредственно/);assert.equal(h.requests.length,0);
  h.sqlite.exec("INSERT INTO task_participants(task_id,member_id) VALUES ('launch','max')");
  assert.equal((await h.ai.loadTaskAi(group,{})).chatDisabledReason,null);
});

test("stale private output survives reload but is absent from general, foreign and revoked channels",async t=>{
  const h=harness(t),message=h.human({channel:"analyst"});
  h.respond(async()=>{h.sqlite.exec("UPDATE tasks SET version=version+1 WHERE id='ai-task'");return {text:"PRIVATE_STALE_ANSWER",inputTokens:1,outputTokens:2};});
  const run=await h.ai.requestAiReply(chatRequest(message,{channelMemberId:"analyst"}));
  assert.equal(run.status,"stale");
  const node=h.common.findPath("ai-task",await h.loadTree()).at(-1);
  const own=await h.ai.loadTaskAi(node,{},"analyst");
  assert.equal(projectChatAiRuns(own.chatRuns,node.id,"analyst")[0].output,"PRIVATE_STALE_ANSWER");assert.equal(own.chatRuns[0].canRetry,true);
  assert.equal((await h.ai.loadTaskAi(node,{})).chatRuns.length,0);
  h.as("anna");assert.equal((await h.ai.loadTaskAi(node,{role:"manager"},"analyst")).chatRuns.length,0);
  await assert.rejects(()=>h.ai.retryAiChat(chatRequest(message,{channelMemberId:"analyst",runId:run.id})),/нет доступа/);
  h.as("manager");h.sqlite.exec("UPDATE tasks SET owner_id='anna',version=version+1 WHERE id='ai-task'");
  assert.equal((await h.ai.loadTaskAi(node,{},"analyst")).chatRuns.length,0);
  await assert.rejects(()=>h.ai.retryAiChat(chatRequest(message,{channelMemberId:"analyst",runId:run.id})),/назначен/);
  assert.equal(h.requests.length,1);
});

test("refreshing stale chat preserves its original row, uses current context and deduplicates concurrent retries",async t=>{
  const h=harness(t),message=h.human({channel:"analyst",body:"Исходный вопрос"});
  h.respond(async()=>{h.sqlite.exec("UPDATE tasks SET version=version+1 WHERE id='ai-task'");return {text:"Сохранённый старый ответ",inputTokens:1,outputTokens:2};});
  const old=await h.ai.requestAiReply(chatRequest(message,{channelMemberId:"analyst"}));
  const original=h.one("SELECT * FROM ai_runs WHERE id=?",old.id);
  h.sqlite.exec("UPDATE tasks SET description='АКТУАЛЬНЫЙ КОНТЕКСТ',version=version+1 WHERE id='ai-task'");
  h.human({channel:"analyst",body:"НОВОЕ УТОЧНЕНИЕ"});
  let release,started;const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});
  h.respond(async()=>{started();await gate;return {text:"Новый ответ",inputTokens:2,outputTokens:3};});
  const request=chatRequest(message,{channelMemberId:"analyst",runId:old.id,clientId:"refresh-stale-001"});
  const first=h.ai.retryAiChat(request);await ready;
  const duplicate=await h.ai.retryAiChat({...request,clientId:"refresh-stale-002"});
  assert.equal(duplicate.status,"pending");assert.notEqual(duplicate.id,old.id);
  release();const fresh=await first;assert.equal(fresh.id,duplicate.id);assert.equal(fresh.status,"succeeded");
  assert.deepEqual(h.one("SELECT * FROM ai_runs WHERE id=?",old.id),original);
  const sent=JSON.stringify(h.requests.at(-1).messages);
  assert.match(sent,/АКТУАЛЬНЫЙ КОНТЕКСТ/);assert.match(sent,/НОВОЕ УТОЧНЕНИЕ/);assert.match(sent,/Исходный вопрос/);
  assert.equal((await h.ai.retryAiChat(request)).id,fresh.id);assert.equal(h.requests.length,2);
  assert.equal(h.all("SELECT id FROM task_messages WHERE author_id='analyst'").length,1);
  const view=await h.ai.loadTaskAi(h.common.findPath("ai-task",await h.loadTree()).at(-1),{},"analyst");
  assert.equal(view.chatRuns.find(run=>run.id===old.id).canRetry,false);
  assert.equal(projectChatAiRuns(view.chatRuns,"ai-task","analyst").find(run=>run.id===old.id).output,original.output);
});

test("a failed stale refresh retries its own row and does not discard the saved original output",async t=>{
  const h=harness(t),message=h.human();
  h.respond(async()=>{h.sqlite.exec("UPDATE tasks SET version=version+1 WHERE id='ai-task'");return {text:"Old retained output",inputTokens:1,outputTokens:2};});
  const old=await h.ai.requestAiReply(chatRequest(message));
  h.respond(async()=>{throw new provider.AiProviderError("unavailable");});
  const failed=await h.ai.retryAiChat(chatRequest(message,{runId:old.id}));assert.equal(failed.status,"failed");assert.notEqual(failed.id,old.id);
  h.respond(async()=>({text:"New output",inputTokens:1,outputTokens:2}));
  const fresh=await h.ai.retryAiChat(chatRequest(message,{runId:failed.id}));assert.equal(fresh.id,failed.id);assert.equal(fresh.status,"succeeded");
  assert.equal(h.one("SELECT output FROM ai_runs WHERE id=?",old.id).output,"Old retained output");
});

test("chat AI reads only the requested message page while retaining its old saved output",async t=>{
  const h=harness(t),message=h.human();
  h.respond(async()=>{h.sqlite.exec("UPDATE tasks SET version=version+1 WHERE id='ai-task'");return {text:"Persisted old output",inputTokens:1,outputTokens:2};});
  const stale=await h.ai.requestAiReply(chatRequest(message));
  const row=h.one("SELECT * FROM ai_runs WHERE id=?",stale.id);
  for(let i=0;i<350;i++) {
    const copy={...row,id:`newer-run-${i}`,request_key:`newer-key-${i}`,input_message_id:`unloaded-input-${i}`,status:i%2?"stale":"failed",output:"UNLOADED_OUTPUT".repeat(300),created_at:"2026-12-01T00:00:00Z"};
    h.sqlite.prepare(`INSERT INTO ai_runs (${Object.keys(copy).join(",")}) VALUES (${Object.keys(copy).map(()=>"?").join(",")})`).run(...Object.values(copy));
  }
  h.queried.length=0;
  const node=h.common.findPath("ai-task",await h.loadTree()).at(-1);
  const data=await h.ai.loadTaskAi(node,{},null,[message.id]);
  assert.equal(data.chatRuns.find(run=>run.id===stale.id).output,"Persisted old output");
  assert.equal(data.chatRuns.length,1);assert.ok(JSON.stringify(projectChatAiRuns(data.chatRuns,"ai-task",null,[message.id])).length<1500);
  assert.ok(h.queried.some(query=>/input_message_id IN/.test(query.sql)&&query.values.includes(JSON.stringify([message.id]))));
  assert.ok(h.queried.some(query=>/refreshed.request_key=json_array/.test(query.sql)));
  assert.equal(h.queried.some(query=>/^SELECT request_key AS requestKey FROM ai_runs/.test(query.sql)),false);
  assert.equal((await h.ai.loadTaskAi(node,{},null,[])).chatRuns.length,0);
  assert.equal((await h.ai.loadTaskAi(node,{})).chatRuns.length,20);
  const fullPage=[message.id,...Array.from({length:99},(_,i)=>`unloaded-input-${i}`)];
  h.queried.length=0;
  const full=await h.ai.loadTaskAi(node,{},null,fullPage);
  assert.equal(full.chatRuns.length,100);
  assert.deepEqual(new Set(full.chatRuns.map(run=>run.inputMessageId)),new Set(fullPage));
  const pageQuery=h.queried.find(query=>/input_message_id IN/.test(query.sql));
  assert.match(pageQuery.sql,/json_each\(\?\)/);assert.equal(pageQuery.values.length,3);
  assert.deepEqual(JSON.parse(pageQuery.values[2]),fullPage);
  assert.ok(h.queried.every(query=>query.values.length<=100),"Every statement stays inside D1's bind limit");
});

test("AI new bot rejects a forged config version without leaving an orphan",async t=>{
  const h=harness(t);const before=h.all("SELECT id FROM members").length;
  const result=await h.invoke("saveBotState",{version:9,name:"Новый бот",role:"Помощник",provider:"xai",model:"test-model",systemPrompt:"",enabled:"on"});
  assert.ok(result.error);assert.equal(h.all("SELECT id FROM members").length,before);
});

test("AI chat action infers private bot and success retries create no duplicate messages",async t=>{
  const h=harness(t);const form=makeForm({taskId:"ai-task",channelMemberId:"analyst",body:"Вопрос боту",clientId:"inferred-bot-0001"});
  const first=await h.chat.sendMessageState({},form);assert.equal(first.aiStatus,"succeeded");
  const second=await h.chat.sendMessageState({},form);assert.equal(second.aiStatus,"succeeded");
  assert.equal(h.requests.length,1);assert.equal(h.all("SELECT id FROM task_messages").length,2);
});

test("AI task replay after a lost HTTP response acknowledges the original run",async t=>{
  const h=harness(t);const first=await h.invoke("runTaskAiState",taskRequest());
  const replay=await h.invoke("runTaskAiState",taskRequest());
  assert.equal(replay.aiStatus,"succeeded");assert.equal(replay.aiRunId,first.aiRunId);assert.equal(h.requests.length,1);
  assert.ok((await h.invoke("runTaskAiState",taskRequest({clientId:"new-task-request-0002",version:2}))).error);
});

test("AI busy response remains retryable without resending a saved human message",async t=>{
  const h=harness(t);let release,started;
  const gate=new Promise(resolve=>{release=resolve;});const ready=new Promise(resolve=>{started=resolve;});
  h.respond(async()=>{started();await gate;return {text:"Первый ответ",inputTokens:1,outputTokens:2};});
  const values={taskId:"ai-task",channelMemberId:"analyst",body:"Первый вопрос",clientId:"busy-message-0001"};
  const first=h.chat.sendMessageState({},makeForm(values));await ready;
  const blocked=await h.chat.sendMessageState({},makeForm({...values,body:"Второй вопрос",clientId:"busy-message-0002"}));
  assert.equal(blocked.sentClientId,"busy-message-0002");assert.equal(blocked.aiStatus,"failed");assert.ok(blocked.aiRunId);
  release();await first;h.respond(async()=>({text:"Второй ответ",inputTokens:1,outputTokens:2}));
  const retry=await h.invoke("retryAiChatState",{taskId:"ai-task",channelMemberId:"analyst",botMemberId:"analyst",runId:blocked.aiRunId,clientId:"busy-retry-0002"});
  assert.equal(retry.aiStatus,"succeeded");assert.equal(h.requests.length,2);
  assert.equal(h.all("SELECT id FROM task_messages WHERE author_id='me'").length,2);
  assert.equal(h.all("SELECT id FROM task_messages WHERE author_id='analyst'").length,2);
});

test("AI connection diagnostic is manager-only before reading credentials or generating",async t=>{
  const h=harness(t);
  for(const role of ["viewer","anna","max"]){
    h.as(role);
    const result=await h.invoke("testAiConnectionState",{provider:"xai",model:"test-model",apiKey:"forged-secret"});
    assert.match(result.error,/только руководитель/);
    assert.equal(result.result,undefined);
    assert.doesNotMatch(JSON.stringify(result),/forged-secret/);
  }
  assert.equal(h.requests.length,0);
  const diagnostic=h.ai.createAiEngine({
    requireAccess:async()=>({role:"viewer"}),
    getApiKey(){assert.fail("Unauthorized diagnostic read a key");},
    generate(){assert.fail("Unauthorized diagnostic called a provider");},
  });
  await assert.rejects(()=>diagnostic.testAiConnection({provider:"xai",model:"test-model"}),/только руководитель/);
});

test("AI connection diagnostic reports the missing key without a paid request",async t=>{
  const h=harness(t);delete h.env.XAI_API_KEY;
  const result=await h.invoke("testAiConnectionState",{provider:"xai",model:"test-model"});
  assert.match(result.error,/XAI_API_KEY.*не настроен/);
  assert.match(result.error,/Sites/);
  assert.equal(result.result,undefined);assert.equal(h.requests.length,0);
  assert.equal(h.all("SELECT id FROM ai_runs").length,0);
});

test("AI connection diagnostic validates provider and model before generating",async t=>{
  const h=harness(t);
  for(const values of [
    {provider:"forged",model:"test-model"},
    {provider:"xai",model:""},
    {provider:"xai",model:"https://attacker.invalid/model"},
    {provider:"xai",model:"x".repeat(129)},
  ])assert.ok((await h.invoke("testAiConnectionState",values)).error);
  assert.equal(h.requests.length,0);
});

test("AI connection diagnostic tests the selected model with no task context or state changes",async t=>{
  const h=harness(t);h.env.OPENAI_API_KEY="openai-test-only-secret";
  h.human({body:"PRIVATE_MESSAGE_DO_NOT_SEND"});
  const before={task:h.one("SELECT * FROM tasks WHERE id='ai-task'"),messages:h.all("SELECT * FROM task_messages"),bots:h.all("SELECT * FROM bot_configs")};
  h.respond(async()=>({text:"UPSTREAM_TEXT_DO_NOT_RETURN",inputTokens:8,outputTokens:2}));
  const result=await h.invoke("testAiConnectionState",{
    provider:"openai",model:"  selected-test-model  ",system:"FORGED_PROMPT",taskId:"ai-task",apiKey:"FORGED_SECRET",messages:"FORGED_MESSAGES",
  });
  assert.equal(result.error,undefined);assert.equal(result.result.provider,"openai");assert.equal(result.result.model,"selected-test-model");
  assert.ok(Number.isFinite(Date.parse(result.result.checkedAt)));
  assert.equal(h.requests.length,1);
  assert.deepEqual(h.requests[0],{
    provider:"openai",model:"selected-test-model",apiKey:"openai-test-only-secret",
    system:"Это проверка подключения. Ответь одним словом OK.",
    messages:[{role:"user",content:"Проверка подключения."}],maxOutputTokens:512,
  });
  assert.doesNotMatch(JSON.stringify(result),/secret|UPSTREAM_TEXT|FORGED|PRIVATE_MESSAGE/);
  assert.equal(h.all("SELECT id FROM ai_runs").length,0);
  assert.deepEqual({task:h.one("SELECT * FROM tasks WHERE id='ai-task'"),messages:h.all("SELECT * FROM task_messages"),bots:h.all("SELECT * FROM bot_configs")},before);
});

test("AI connection diagnostic does not load tasks, messages or bot settings",async t=>{
  const h=harness(t);let calls=0;
  const diagnostic=h.ai.createAiEngine({
    requireAccess:async()=>({role:"manager"}),
    db:{prepare(){assert.fail("Diagnostic queried the database");}},
    loadTree(){assert.fail("Diagnostic loaded task data");},
    getMembers(){assert.fail("Diagnostic loaded bot settings");},
    getApiKey:()=>"test-only-secret",
    generate:async()=>{calls++;return {text:"OK",inputTokens:1,outputTokens:1};},
    now:()=>new Date("2026-11-18T00:00:00.000Z"),
  });
  const result=await diagnostic.testAiConnection({provider:"xai",model:"test-model"});
  assert.equal(result.checkedAt,"2026-11-18T00:00:00.000Z");assert.equal(calls,1);
});

test("AI connection diagnostic reports safe provider errors and permits an explicit retry",async t=>{
  const h=harness(t);
  h.respond(async()=>{throw new provider.AiProviderError("unauthorized");});
  const denied=await h.invoke("testAiConnectionState",{provider:"xai",model:"test-model"});
  assert.match(denied.error,/отклонил ключ или доступ/);assert.equal(denied.result,undefined);
  h.respond(async()=>{throw new Error("Upstream key=test-only-not-a-real-secret raw-body");});
  const failure=await h.invoke("testAiConnectionState",{provider:"xai",model:"test-model"});
  assert.ok(failure.error);assert.doesNotMatch(JSON.stringify(failure),/test-only-not-a-real-secret|raw-body|Upstream/);
  h.respond(async()=>({text:"OK",inputTokens:1,outputTokens:1}));
  const retry=await h.invoke("testAiConnectionState",{provider:"xai",model:"test-model"});
  assert.ok(retry.result);assert.equal(retry.error,undefined);assert.equal(h.requests.length,3);
});
