import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  buildPayload, mentionedAgents, notifyGrokBotTaskChange,
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
  assert.deepEqual(self.map(item => item.agent.slug), ["dzen"]);
  const privateChannel = planMessageEvents(involved, { ...human, text: "Личное", channelMemberId: "bot-dzen" }, [vk, dzen]);
  assert.deepEqual(privateChannel.map(item => item.agent.slug), ["dzen"]);
  assert.deepEqual(mentionedAgents("@Дзен, проверь", [vk, dzen]).map(item => item.slug), ["dzen"]);
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
