import test from "node:test";
import assert from "node:assert/strict";
import { collaborationHarness, loadModule } from "./collaboration-helper.mjs";
import { workspaceDatabase, workspaceSchemaStatements } from "../db/workspace-storage.ts";
import { configuredBotIntegrations, getCompanyIntegrations } from "../lib/ruli/company-integrations.ts";
import * as model from "../lib/ruli/model.ts";
import * as botCatalog from "../lib/ruli/bot-catalog.ts";
import * as webhook from "../lib/ruli/agent-webhook.ts";
import * as agentChannels from "../lib/ruli/agent-channels.ts";
import * as aiProvider from "../lib/ruli/ai-provider.ts";

const first = "a".repeat(32), second = "b".repeat(32);
function fixture() {
  const integrations = id => ({
    XAI_API_KEY: `fixture-ai-${id}`, GROK_BOT_WEBHOOK_URL: `https://${id}.example/webhook`,
    GROK_BOT_WEBHOOK_KEY: `fixture-webhook-${id}`, RULI_BOT_API_TOKEN: `fixture-bearer-${id}`,
  });
  const companies = { [first]: integrations("one"), [second]: integrations("two") };
  const env = { ...integrations("legacy"), RULI_BASE_URL: "https://app.example", RULI_COMPANY_INTEGRATIONS: JSON.stringify(companies) };
  return { companies, env };
}

test("company settings keep the original bindings in the legacy workspace and do not inherit other credentials", () => {
  const { companies, env } = fixture();
  env.OPENAI_API_KEY = "fixture-legacy-only";
  env.RULI_COMPANY_INTEGRATIONS = JSON.stringify({ ...companies, [first]: {...companies[first], RULI_BASE_URL:"https://unrelated.example"}, legacy:{RULI_BOT_API_TOKEN:"unexpected"} });
  assert.equal(getCompanyIntegrations(env,"legacy").OPENAI_API_KEY,env.OPENAI_API_KEY);
  assert.equal(getCompanyIntegrations(env,"legacy").RULI_BOT_API_TOKEN,env.RULI_BOT_API_TOKEN);
  assert.equal(getCompanyIntegrations(env,first).XAI_API_KEY,companies[first].XAI_API_KEY);
  assert.equal(getCompanyIntegrations(env,first).OPENAI_API_KEY,undefined);
  assert.equal(getCompanyIntegrations(env,first).RULI_BASE_URL,env.RULI_BASE_URL);
  assert.equal(getCompanyIntegrations(env,second).XAI_API_KEY,companies[second].XAI_API_KEY);
  for (const id of [null,"__proto__","c".repeat(32)]) assert.equal(getCompanyIntegrations(env,id).XAI_API_KEY,undefined);
  assert.equal(getCompanyIntegrations({...env,RULI_COMPANY_INTEGRATIONS:"invalid"},first).XAI_API_KEY,undefined);
});

test("LLM checks and outgoing webhook callbacks use only the selected company's settings", async t => {
  const { companies, env } = fixture();
  const h = collaborationHarness(); t.after(()=>h.close());
  let workspaceId, capturedKey;
  const outgoing=[];
  const common={...h.common,env,getCompanyIntegrations,getCurrentWorkspaceId:async()=>workspaceId};
  const ai=loadModule("lib/ruli/ai.ts",{...common,...aiProvider,generateAiText:async({apiKey})=>{capturedKey=apiKey;return {text:"OK"};}},["testAiConnection"]);
  const agent=loadModule("lib/ruli/agent-runtime.ts",{...common,notifyGrokBotTaskChange:async deps=>outgoing.push(deps.config)},["notifyTaskChangeForAgents"]);
  for (const [id,config] of [["legacy",env], [first,companies[first]], [second,companies[second]]]) {
    workspaceId=id;
    await ai.testAiConnection({provider:"xai",model:"fixture"});
    assert.equal(capturedKey,config.XAI_API_KEY);
    await agent.notifyTaskChangeForAgents(h.db,null,{});
    assert.equal(outgoing.at(-1).url,config.GROK_BOT_WEBHOOK_URL);
    assert.equal(outgoing.at(-1).key,config.GROK_BOT_WEBHOOK_KEY);
  }
  workspaceId="c".repeat(32);
  await assert.rejects(ai.testAiConnection({provider:"xai",model:"fixture"}),/не настроен/);
  await agent.notifyTaskChangeForAgents(h.db,null,{});
  assert.equal(outgoing.at(-1).url,undefined);
});

test("the inbound bearer scopes reads, writes and delivery callbacks; ambiguous or unknown tokens do not open a database",async t=>{
  const { companies, env }=fixture();
  const h=collaborationHarness();t.after(()=>h.close());
  for(const [id,label] of [["legacy","Legacy"],[first,"First"],[second,"Second"]]) {
    if(id!=="legacy"){
      await h.db.batch(await workspaceSchemaStatements(h.db,id));
      await h.db.prepare("INSERT INTO workspaces(id,name) VALUES(?,?)").bind(id,label).run();
    }
    const db=workspaceDatabase(h.db,id);
    await db.prepare("INSERT INTO members(id,name,short_name,role,initials,color,type) VALUES('agent','Agent','A','','','','bot')").run();
    await db.prepare("INSERT INTO bot_configs(member_id,provider,model,slug,enabled,updated_at) VALUES('agent','grok-bot','-','agent',1,'2026-01-01')").run();
    if(id!=="legacy")await db.prepare("INSERT INTO tasks(id,kind,title,owner_id) VALUES('root','group','Root','agent')").run();
    await db.prepare("INSERT INTO tasks(id,parent_id,kind,title,owner_id,status) VALUES('same-task','root','leaf',?,'agent','todo')").bind(label).run();
  }
  const bot=loadModule("lib/ruli/bot-api.ts",{...model,...botCatalog,...webhook,...agentChannels},
    ["handleBotApi","readBearerToken","timingSafeEqualText","botApiDepsFromEnv"]);
  let dbRequests=0;
  const deliveries=[];
  const agent=loadModule("lib/ruli/agent-runtime.ts",{
    getCurrentWorkspaceId:()=>{throw new Error("No browser session on bot API");},
    notifyGrokBotMessage:async({db,config},task,message)=>deliveries.push({title:(await db.prepare("SELECT title FROM tasks WHERE id=?").bind(task.id).first()).title,config,message}),
  },["notifyMessageForAgents"]);
  const {handleIncomingBotRequest}=loadModule("app/api/bot/_handler.ts",{
    ...bot,...agent,env,configuredBotIntegrations,workspaceDatabase,getSystemD1:()=>{dbRequests++;return h.db;},
  },["handleIncomingBotRequest"]);
  function request(token,text) {
    const url=`https://app.example/api/bot/tasks/same-task${text?"/messages":""}?bot=agent`;
    return handleIncomingBotRequest(new Request(url,{method:text?"POST":"GET",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:text?JSON.stringify({text}):undefined}));
  }
  for(const [label,config] of [["Legacy",env],["First",companies[first]],["Second",companies[second]]]){
    const response=await request(config.RULI_BOT_API_TOKEN);
    assert.equal(response.status,200);assert.match(await response.text(),new RegExp('"title":"'+label+'"'));
  }
  const post=await request(companies[first].RULI_BOT_API_TOKEN,"First company message");
  assert.equal(post.status,201);assert.equal(deliveries.length,1);assert.equal(deliveries[0].title,"First");
  assert.equal(deliveries[0].config.url,companies[first].GROK_BOT_WEBHOOK_URL);
  assert.equal(deliveries[0].config.key,companies[first].GROK_BOT_WEBHOOK_KEY);
  const secondResponse=await request(companies[second].RULI_BOT_API_TOKEN);
  assert.doesNotMatch(await secondResponse.text(),/First company message/);
  env.RULI_COMPANY_INTEGRATIONS=JSON.stringify({...companies,[first]:{...companies[first],RULI_BOT_API_TOKEN:env.RULI_BOT_API_TOKEN}});
  const before=dbRequests;
  for(const token of [env.RULI_BOT_API_TOKEN,"unknown"])assert.equal((await request(token)).status,401);
  assert.equal(dbRequests,before);
});
