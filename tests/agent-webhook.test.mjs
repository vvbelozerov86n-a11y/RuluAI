import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  buildPayload, loadTaskOutbox, mentionedAgents, notifyGrokBotTaskChange, notifyGrokBotMessage,
  planMessageEvents, planTaskEvents, retryOutboxEvent, taskUrl, webhookAuthHeader, webhookConfigured,
} from "../lib/ruli/agent-webhook.ts";

const vk = { memberId: "bot-vk", name: "ВКонтакте", shortName: "ВК", slug: "vk", enabled: true };
const dzen = { memberId: "bot-dzen", name: "Дзен", shortName: "Дзен", slug: "dzen", enabled: true };
const off = { memberId: "bot-off", name: "Выключен", shortName: "Выкл", slug: "off", enabled: false };

function task(extra = {}) {
  return {
    id: "task-1", title: "Оформить пост", description: "Текст", status: "todo",
    priority: "high", due: "2026-11-20", parentId: "group", ownerId: "bot-vk", participants: [],
    ...extra,
  };
}

function d1(sqlite) {
  function prepared(sql, values = []) {
    return {
      sql, values,
      bind(...bound) { return prepared(sql, bound); },
      async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
      async first() { const row = sqlite.prepare(sql).get(...values); return row ? { ...row } : null; },
      async all() { return { results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })) }; },
      execute() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
  }
  return {
    prepare: prepared,
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
}

function memory() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../drizzle/", import.meta.url);
  for (const name of fs.readdirSync(dir).filter(name => name.endsWith(".sql")).sort()) {
    sqlite.exec(fs.readFileSync(new URL(name, dir), "utf8"));
  }
  sqlite.exec(`INSERT INTO members(id,name,short_name,role,initials,color,type) VALUES
    ('me','Руководитель','Вы','','','','human'),
    ('bot-vk','ВКонтакте','ВК','соцсети','✳','bot','bot'),
    ('bot-dzen','Дзен','Дзен','контент','✳','bot','bot');
    INSERT INTO bot_configs(member_id,provider,model,system_prompt,slug,enabled,version,updated_at) VALUES
    ('bot-vk','grok-bot','-','','vk',1,1,'2026-11-18T00:00:00.000Z'),
    ('bot-dzen','grok-bot','-','','dzen',1,1,'2026-11-18T00:00:00.000Z');
    INSERT INTO tasks(id,parent_id,kind,title,owner_id,status,priority,description,result) VALUES
    ('root',NULL,'group','Все','me',NULL,NULL,'',''),
    ('task-1','root','leaf','Оформить пост','bot-vk','todo','high','Текст','');`);
  return { sqlite, db: d1(sqlite) };
}

test("webhook header defaults to Bearer and uses a custom header as-is", () => {
  assert.deepEqual(webhookAuthHeader({ key: "secret" }), ["Authorization", "Bearer secret"]);
  assert.deepEqual(webhookAuthHeader({ key: "secret", header: "Authorization" }), ["Authorization", "Bearer secret"]);
  assert.deepEqual(webhookAuthHeader({ key: "secret", header: "X-Webhook-Key" }), ["X-Webhook-Key", "secret"]);
  assert.equal(webhookAuthHeader({}), null);
});

test("task url uses the app base and encodes the id", () => {
  assert.equal(taskUrl("https://ruli.example", "task 1"), "https://ruli.example/t/task%201");
  assert.equal(taskUrl("https://ruli.example/", "root"), "https://ruli.example/");
  assert.equal(taskUrl("", "task-1"), "/t/task-1");
});

test("assigning a Grok Bot agent plans task.assigned and skips a repeated update", () => {
  const created = planTaskEvents(null, task(), [vk, dzen, off]);
  assert.deepEqual(created.map(item => [item.agent.slug, item.event]), [["vk", "task.assigned"]]);
  const updated = planTaskEvents(task({ description: "Старое" }), task({ description: "Новое" }), [vk, dzen]);
  assert.deepEqual(updated.map(item => [item.agent.slug, item.event]), [["vk", "task.updated"]]);
  const assignedAndChanged = planTaskEvents(
    task({ ownerId: "me", description: "Старое" }),
    task({ description: "Новое" }),
    [vk],
  );
  assert.deepEqual(assignedAndChanged.map(item => item.event), ["task.assigned"]);
  assert.deepEqual(planTaskEvents(task(), task(), [vk]), []);
});

test("mentions, participants and anti-cycle shape message events", () => {
  const involved = task({ ownerId: "me", participants: ["bot-vk", "bot-dzen"] });
  const human = { id: "m1", authorId: "me", authorName: "Владислав", authorKind: "human", text: "Смотри @ВКонтакте, срочно", channelMemberId: null };
  const planned = planMessageEvents(involved, human, [vk, dzen]);
  assert.deepEqual(planned.map(item => [item.agent.slug, item.event]).sort(), [["dzen", "message.created"], ["vk", "bot.mentioned"]]);
  const self = planMessageEvents(involved, { ...human, authorId: "bot-vk", authorKind: "bot", text: "Готово" }, [vk, dzen]);
  assert.deepEqual(self.map(item => item.agent.slug), []);
  const privateChannel = planMessageEvents(involved, { ...human, text: "Личное", channelMemberId: "bot-dzen" }, [vk, dzen]);
  assert.deepEqual(privateChannel.map(item => item.agent.slug), ["dzen"]);
  assert.deepEqual(mentionedAgents("@Дзен, проверь", [vk, dzen]).map(item => item.slug), ["dzen"]);
});

test("private mentions never forward text to another bot or a human channel's bots", () => {
  const involved = task({ ownerId: "me", participants: ["bot-vk", "bot-dzen"] });
  const message = { id: "private-mention", authorId: "me", authorName: "Manager", authorKind: "human", text: "Private @vk @dzen", channelMemberId: "bot-dzen" };
  assert.deepEqual(planMessageEvents(involved, message, [vk, dzen]).map(item => [item.agent.slug, item.event]), [["dzen", "bot.mentioned"]]);
  assert.deepEqual(planMessageEvents(involved, { ...message, channelMemberId: "human" }, [vk, dzen]), []);
  assert.deepEqual(planMessageEvents(involved, { ...message, authorId: "bot-dzen", authorKind: "bot" }, [vk, dzen]), []);
});

test("ordinary agent replies do not trigger other agents but explicit mentions still deliver",()=>{
  const involved=task({participants:["bot-dzen"]});
  const reply={id:"agent-reply",authorId:"bot-vk",authorName:"VK",authorKind:"bot",text:"Готово, результат для руководителя",channelMemberId:null};
  assert.deepEqual(planMessageEvents(involved,reply,[vk,dzen]),[]);
  assert.deepEqual(planMessageEvents(involved,{...reply,text:"@dzen проверь результат"},[vk,dzen]).map(item=>[item.agent.slug,item.event]),[["dzen","bot.mentioned"]]);
  assert.deepEqual(planMessageEvents(involved,{...reply,authorId:"me",authorKind:"human"},[vk,dzen]).map(item=>item.agent.slug),["vk","dzen"]);
});

test("a group private channel reaches its active descendant agent without expanding the general audience", async t => {
  const { db, sqlite } = memory(); t.after(() => sqlite.close());
  const sent = [];
  const deps = { db, config: { url: "https://hooks.example/synthetic" }, fetch: async (_url, init) => {
    sent.push(JSON.parse(init.body)); return new Response(null, { status: 204 });
  } };
  const group = task({ id: "root", ownerId: "me", parentId: null, status: null, participants: [] });
  const message = { id: "group-private", authorId: "me", authorName: "Manager", authorKind: "human", text: "Private @dzen", channelMemberId: "bot-vk" };
  const rows = await notifyGrokBotMessage(deps, group, message);
  assert.equal(rows.length, 1);
  assert.equal(sent[0].bot.slug, "vk");
  assert.equal(sent[0].task.id, "root");
  assert.equal(sent[0].message.text, message.text);
  assert.deepEqual(await notifyGrokBotMessage(deps, group, { ...message, channelMemberId: null }), []);
  sqlite.prepare("UPDATE tasks SET deleted_at='2026-11-18' WHERE id='task-1'").run();
  assert.deepEqual(await notifyGrokBotMessage(deps, group, message), []);
  assert.equal(sent.length, 1);
});

test("delivery history retains every unresolved event behind newer successes", async t => {
  const { db, sqlite } = memory(); t.after(() => sqlite.close());
  const insert = sqlite.prepare(`INSERT INTO bot_webhook_outbox
    (id,event,task_id,bot_member_id,bot_slug,payload,status,attempts,created_at,updated_at)
    VALUES (?,'task.assigned',?,'bot-vk','vk','{}',?,0,?,?)`);
  for (let index = 0; index < 25; index++) {
    const stamp = `2026-11-18T01:${String(index).padStart(2, "0")}:00.000Z`;
    insert.run(`ok-${index}`, "task-1", "delivered", stamp, stamp);
  }
  for (const status of ["pending", "failed"]) insert.run(status, "task-1", status, "2026-11-17", "2026-11-17");
  insert.run("other-failed", "root", "failed", "2026-11-17", "2026-11-17");
  const rows = await loadTaskOutbox(db, "task-1");
  assert.equal(rows.filter(row => row.status === "delivered").length, 20);
  assert.deepEqual(rows.filter(row => row.status !== "delivered").map(row => row.id).sort(), ["failed", "pending"]);
  assert.ok(rows.every(row => row.taskId === "task-1"));
});

test("does not enqueue or send when the webhook URL is missing", async () => {
  const { db, sqlite } = memory();
  const rows = await notifyGrokBotTaskChange({ db, config: { baseUrl: "https://ruli.example" }, schedule: work => work }, null, task());
  assert.deepEqual(rows, []);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM bot_webhook_outbox").get().n, 0);
  assert.equal(webhookConfigured({}), false);
});

test("builds a payload with eventId, task url and participants", () => {
  const payload = buildPayload(
    "task.assigned", "evt-1", "2026-11-18T01:00:00.000Z", task(), vk,
    [{ id: "bot-vk", name: "ВКонтакте", type: "bot" }, { id: "me", name: "Владислав", type: "human" }],
    { baseUrl: "https://ruli.example" },
  );
  assert.equal(payload.event, "task.assigned");
  assert.equal(payload.eventId, "evt-1");
  assert.equal(payload.app.baseUrl, "https://ruli.example");
  assert.equal(payload.task.url, "https://ruli.example/t/task-1");
  assert.equal(payload.task.priority, "high");
  assert.deepEqual(payload.bot, { slug: "vk", name: "ВКонтакте" });
  assert.deepEqual(payload.participants, [{ name: "ВКонтакте", kind: "bot" }]);
});

test("delivery failure is recorded and can be retried", async () => {
  const { db, sqlite } = memory();
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    if (calls === 1) return new Response("no", { status: 503 });
    return new Response("ok", { status: 200 });
  };
  const config = { url: "https://hooks.example/webhook", key: "hook-key", baseUrl: "https://ruli.example" };
  const rows = await notifyGrokBotTaskChange({
    db, config, fetch: fetcher, uuid: () => "evt-fail", now: () => new Date("2026-11-18T01:00:00.000Z"),
  }, null, task());
  assert.equal(rows[0].id, "evt-fail");
  const failed = sqlite.prepare("SELECT status,attempts,last_error AS lastError FROM bot_webhook_outbox WHERE id='evt-fail'").get();
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 1);
  assert.match(failed.lastError, /503/);
  const retried = await retryOutboxEvent({ db, config, fetch: fetcher }, "evt-fail");
  assert.equal(retried.status, "delivered");
  assert.equal(calls, 2);
});

test("retry refuses another task before sending or changing its event", async t => {
  const { db, sqlite } = memory(); t.after(() => sqlite.close());
  let calls = 0;
  const deps = { db, config: { url: "https://hooks.example/synthetic" }, uuid: () => "retry-task-guard", fetch: async () => {
    calls++; return new Response(null, { status: 503 });
  } };
  await notifyGrokBotTaskChange(deps, null, task());
  const before = { ...sqlite.prepare("SELECT * FROM bot_webhook_outbox").get() };
  assert.equal(await retryOutboxEvent(deps, "retry-task-guard", "different-task"), null);
  assert.equal(calls, 1);
  assert.deepEqual({ ...sqlite.prepare("SELECT * FROM bot_webhook_outbox").get() }, before);
});

test("retry refuses deleted tasks, deleted ancestors, revoked assignments and renamed or disabled agents", async t => {
  for (const change of [
    "UPDATE tasks SET deleted_at='2026-11-18' WHERE id='task-1'",
    "UPDATE tasks SET deleted_at='2026-11-18' WHERE id='root'",
    "UPDATE tasks SET owner_id='me' WHERE id='task-1'",
    "UPDATE bot_configs SET enabled=0 WHERE member_id='bot-vk'",
    "UPDATE bot_configs SET slug='renamed' WHERE member_id='bot-vk'",
  ]) {
    const { db, sqlite } = memory(); t.after(() => sqlite.close());
    let calls = 0;
    const deps = { db, config: { url: "https://hooks.example/synthetic" }, uuid: () => "retry-revoked", fetch: async () => {
      calls++; return new Response(null, { status: 503 });
    } };
    await notifyGrokBotTaskChange(deps, null, task());
    const originalPayload = sqlite.prepare("SELECT payload FROM bot_webhook_outbox").get().payload;
    sqlite.exec(change);
    const result = await retryOutboxEvent(deps, "retry-revoked", "task-1");
    assert.equal(calls, 1, change);
    assert.equal(result.status, "failed", change);
    assert.match(result.lastError, /больше недоступно/, change);
    assert.equal(result.attempts, 1, change);
    assert.equal(result.payload, originalPayload, change);
  }
});

test("private group retries preserve the payload but stop when its recipient loses the channel", async t => {
  const { db, sqlite } = memory(); t.after(() => sqlite.close());
  sqlite.prepare(`INSERT INTO task_messages
    (id,task_id,channel_member_id,author_id,author_user_id,author_name,body,client_id,created_at)
    VALUES ('private-source','root','bot-vk','me','manager','Manager','private','private-client','2026-11-18')`).run();
  const sent = [];
  const deps = { db, config: { url: "https://hooks.example/synthetic" }, uuid: () => "private-event", fetch: async (_url, init) => {
    sent.push(init.body); return new Response(null, { status: sent.length === 1 ? 503 : 204 });
  } };
  await notifyGrokBotMessage(deps, task({ id: "root", ownerId: "me", parentId: null, status: null }), {
    id: "private-source", authorId: "me", authorName: "Manager", authorKind: "human", text: "private", channelMemberId: "bot-vk",
  });
  assert.equal((await retryOutboxEvent(deps, "private-event", "root")).status, "delivered");
  assert.equal(sent[1], sent[0]);
  sqlite.prepare("UPDATE tasks SET owner_id='me' WHERE id='task-1'").run();
  assert.match((await retryOutboxEvent(deps, "private-event", "root")).lastError, /больше недоступно/);
  assert.equal(sent.length, 2);
});

test("retry blocks a historical private mention event addressed to a different bot", async t => {
  const { db, sqlite } = memory(); t.after(() => sqlite.close());
  sqlite.prepare("INSERT INTO task_participants(task_id,member_id) VALUES('task-1','bot-dzen')").run();
  sqlite.prepare(`INSERT INTO task_messages
    (id,task_id,channel_member_id,author_id,author_user_id,author_name,body,client_id,created_at)
    VALUES ('private-source','task-1','bot-vk','me','manager','Manager','private @dzen','private-client','2026-11-18')`).run();
  sqlite.prepare(`INSERT INTO bot_webhook_outbox
    (id,event,task_id,bot_member_id,bot_slug,payload,status,attempts,created_at,updated_at)
    VALUES ('old-private-leak','bot.mentioned','task-1','bot-dzen','dzen',?,'failed',1,'2026-11-18','2026-11-18')`)
    .run(JSON.stringify({ message: { id: "private-source", text: "private @dzen" } }));
  let calls = 0;
  const result = await retryOutboxEvent({ db, config: { url: "https://hooks.example/synthetic" }, fetch: async () => {
    calls++; return new Response(null, { status: 204 });
  } }, "old-private-leak", "task-1");
  assert.equal(calls, 0);
  assert.match(result.lastError, /больше недоступно/);
});

test("local webhook receiver gets task.assigned and keeps the original payload on retry", async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
  });
  const port = await new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const { db } = memory();
  try {
    const rows = await notifyGrokBotTaskChange({
      db,
      config: { url: `http://127.0.0.1:${port}/hook`, key: "local-hook", baseUrl: "http://127.0.0.1:5173" },
      uuid: () => "evt-live",
      now: () => new Date("2026-11-18T02:00:00.000Z"),
    }, null, task());
    assert.equal(rows[0].status, "pending");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(received.length, 1);
    assert.equal(received[0].authorization, "Bearer local-hook");
    assert.equal(received[0].body.event, "task.assigned");
    assert.equal(received[0].body.eventId, "evt-live");
    assert.equal(received[0].body.bot.slug, "vk");
    assert.equal(received[0].body.task.url, "http://127.0.0.1:5173/t/task-1");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
