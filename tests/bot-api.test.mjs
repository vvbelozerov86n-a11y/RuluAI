import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as model from "../lib/ruli/model.ts";
import * as botCatalog from "../lib/ruli/bot-catalog.ts";
import * as webhook from "../lib/ruli/agent-webhook.ts";
import * as agentChannels from "../lib/ruli/agent-channels.ts";
import { loadModule } from "./collaboration-helper.mjs";

const { handleBotApi, timingSafeEqualText } = loadModule("lib/ruli/bot-api.ts", { ...model, ...botCatalog, ...webhook, ...agentChannels }, ["handleBotApi", "timingSafeEqualText"]);

const TOKEN = "test-bot-token-please-change";

function d1(sqlite, hooks = {}) {
  function prepared(sql, values = []) {
    return {
      sql, values,
      bind(...bound) { return prepared(sql, bound); },
      async run() { await hooks.beforeRun?.(sql, values); return this.execute(); },
      async first() { await hooks.beforeFirst?.(sql, values); const row = sqlite.prepare(sql).get(...values); return row ? { ...row } : null; },
      async all() { return { results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })) }; },
      execute() { hooks.beforeExecute?.(sql, values); const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
    };
  }
  return {
    prepare: prepared,
    async batch(statements) {
      await hooks.beforeBatch?.(statements);
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
    INSERT INTO tasks(id,parent_id,kind,title,owner_id,status,priority,description,result,version) VALUES
    ('root',NULL,'group','Все','me',NULL,NULL,'','',1),
    ('task-vk','root','leaf','Пост ВК','bot-vk','todo','high','Описание','',1),
    ('task-other','root','leaf','Чужое','bot-dzen','doing',NULL,'Секрет','',1);
    INSERT INTO task_messages(id,task_id,channel_member_id,author_id,author_user_id,author_name,body,client_id,created_at) VALUES
    ('msg-1','task-vk',NULL,'me','user-manager','Владислав','Сделай обложку','c1','2026-11-18T00:00:00.000Z');`);
  const hooks = {};
  return { sqlite, db: d1(sqlite, hooks), hooks };
}

function request(path, { method = "GET", token = TOKEN, body, key, headers = {} } = {}) {
  return new Request(`https://ruli.example${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function call(db, path, options) {
  const response = await handleBotApi(request(path, options), { db, token: TOKEN, baseUrl: "https://ruli.example" });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, json, headers: response.headers };
}

test("token comparison rejects empty and unequal values", () => {
  assert.equal(timingSafeEqualText(TOKEN, TOKEN), true);
  assert.equal(timingSafeEqualText(TOKEN, "other-token-please"), false);
  assert.equal(timingSafeEqualText("", ""), false);
  assert.equal(timingSafeEqualText(TOKEN, ""), false);
});

test("rejects missing or invalid bearer tokens", async () => {
  const { db } = memory();
  assert.equal((await call(db, "/api/bot/tasks?bot=vk", { token: "" })).status, 401);
  assert.equal((await call(db, "/api/bot/tasks?bot=vk", { token: "wrong-token-value" })).status, 401);
});

test("lists only the requesting bot's tasks and hides a foreign task", async () => {
  const { db } = memory();
  const list = await call(db, "/api/bot/tasks?bot=vk&status=todo");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.tasks.map(item => item.id), ["task-vk"]);
  const foreign = await call(db, "/api/bot/tasks/task-other?bot=vk");
  assert.equal(foreign.status, 403);
  const missing = await call(db, "/api/bot/tasks/no-such?bot=vk");
  assert.equal(missing.status, 404);
  const own = await call(db, "/api/bot/tasks/task-vk?bot=vk");
  assert.equal(own.status, 200);
  assert.equal(own.json.task.title, "Пост ВК");
  assert.equal(own.json.messages[0].body, "Сделай обложку");
});

test("posts a chat message as the bot and is idempotent", async () => {
  const { db, sqlite } = memory();
  const first = await call(db, "/api/bot/tasks/task-vk/messages", {
    method: "POST", key: "post-1-unique", body: { bot: "vk", text: "Обложка готова." },
  });
  assert.equal(first.status, 201);
  assert.equal(first.json.text, "Обложка готова.");
  const replay = await call(db, "/api/bot/tasks/task-vk/messages", {
    method: "POST", key: "post-1-unique", body: { bot: "vk", text: "Обложка готова." },
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("Idempotency-Replayed"), "true");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE author_id='bot-vk'").get().n, 1);
  const conflict = await call(db, "/api/bot/tasks/task-vk/status", {
    method: "POST", key: "post-1-unique", body: { bot: "vk", status: "doing" },
  });
  assert.equal(conflict.status, 409);
  const tooLong = await call(db, "/api/bot/tasks/task-vk/messages", {
    method: "POST", body: { bot: "vk", text: "x".repeat(5001) },
  });
  assert.equal(tooLong.status, 400);
});

test("status transitions follow the executor rules", async () => {
  const { db, sqlite } = memory();
  const jump = await call(db, "/api/bot/tasks/task-vk/status", { method: "POST", body: { bot: "vk", status: "done" } });
  assert.equal(jump.status, 409);
  const review = await call(db, "/api/bot/tasks/task-vk/status", {
    method: "POST", body: { bot: "vk", status: "review", result: "Ссылка на пост" },
  });
  assert.equal(review.status, 200);
  assert.equal(sqlite.prepare("SELECT status,result FROM tasks WHERE id='task-vk'").get().status, "review");
  const doneNoResult = await call(db, "/api/bot/tasks/task-vk/status", { method: "POST", body: { bot: "vk", status: "doing" } });
  assert.equal(doneNoResult.status, 200);
  await call(db, "/api/bot/tasks/task-vk/status", { method: "POST", body: { bot: "vk", status: "review" } });
  const done = await call(db, "/api/bot/tasks/task-vk/status", { method: "POST", body: { bot: "vk", status: "done" } });
  assert.equal(done.status, 200);
  assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id='task-vk'").get().status, "done");
});

function seedMessageEvent(sqlite, { id = "evt-private", taskId = "task-vk", botId = "bot-vk", channel = "bot-vk" } = {}) {
  const messageId = `${id}-input`;
  sqlite.prepare(`INSERT INTO task_messages
    (id,task_id,channel_member_id,author_id,author_user_id,author_name,body,client_id,created_at)
    VALUES (?,?,?,'me','user-manager','Manager','Fictional private content',?,'2026-11-18T00:00:00.000Z')`)
    .run(messageId, taskId, channel, messageId);
  sqlite.prepare(`INSERT INTO bot_webhook_outbox
    (id,event,task_id,bot_member_id,bot_slug,payload,status,attempts,created_at,updated_at)
    VALUES (?,'message.created',?,?,?,?,'delivered',1,'2026-11-18','2026-11-18')`)
    .run(id, taskId, botId, botId === "bot-vk" ? "vk" : "dzen", JSON.stringify({ message: { id: messageId } }));
}

function batchBarrier(hooks) {
  let waiting = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  hooks.beforeBatch = async () => {
    if (++waiting === 2) release();
    await gate;
  };
}

test("a reply to a private event stays in that private channel, including the notification", async () => {
  const { db, sqlite } = memory();
  seedMessageEvent(sqlite);
  const notifications = [];
  const response = await handleBotApi(request("/api/bot/tasks/task-vk/messages", {
    method: "POST", key: "private-reply-1", body: { bot: "vk", replyToEventId: "evt-private", text: "Private reply" },
  }), { db, token: TOKEN, onMessage: async (_task, message) => { notifications.push(message); } });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.channelMemberId, "bot-vk");
  const stored = sqlite.prepare("SELECT channel_member_id,body FROM task_messages WHERE id=?").get(body.id);
  assert.equal(stored.channel_member_id, "bot-vk");
  assert.equal(stored.body, "Private reply");
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].channelMemberId, "bot-vk");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE author_id='bot-vk' AND channel_member_id IS NULL").get().n, 0);
});

test("a reply to a general event remains general and unrelated private messages stay hidden", async () => {
  const { db, sqlite } = memory();
  seedMessageEvent(sqlite, { id: "evt-general", channel: null });
  seedMessageEvent(sqlite, { id: "evt-other-private", botId: "bot-dzen", channel: "bot-dzen" });
  const reply = await call(db, "/api/bot/tasks/task-vk/messages", {
    method: "POST", body: { bot: "vk", replyToEventId: "evt-general", text: "General reply" },
  });
  assert.equal(reply.status, 201);
  assert.equal(reply.json.channelMemberId, null);
  const detail = await call(db, "/api/bot/tasks/task-vk?bot=vk");
  assert.equal(detail.json.messages.some(message => message.id === "evt-other-private-input"), false);
});

test("reply event must belong to this bot, task and its permitted message channel", async () => {
  const { db, sqlite } = memory();
  seedMessageEvent(sqlite, { id: "evt-other-bot", botId: "bot-dzen", channel: "bot-dzen" });
  seedMessageEvent(sqlite, { id: "evt-other-task", taskId: "task-other" });
  seedMessageEvent(sqlite, { id: "evt-old-leaked", channel: "bot-dzen" });
  seedMessageEvent(sqlite, { id: "evt-missing-input" });
  sqlite.prepare("DELETE FROM task_messages WHERE id='evt-missing-input-input'").run();
  for (const [eventId, expected] of [["missing", 403], ["evt-other-bot", 403], ["evt-other-task", 403], ["evt-old-leaked", 403], ["evt-missing-input", 409]]) {
    const response = await call(db, "/api/bot/tasks/task-vk/messages", {
      method: "POST", body: { bot: "vk", replyToEventId: eventId, text: "Must not be posted" },
    });
    assert.equal(response.status, expected, eventId);
  }
  for (const invalid of [null, "", 123, "x".repeat(201)]) {
    assert.equal((await call(db, "/api/bot/tasks/task-vk/messages", {
      method: "POST", body: { bot: "vk", replyToEventId: invalid, text: "Must not be posted" },
    })).status, 400);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE author_id='bot-vk'").get().n, 0);
});

test("a descendant participant can reply only in its own private group channel", async () => {
  const { db, sqlite } = memory();
  sqlite.prepare("UPDATE tasks SET owner_id='me' WHERE id='task-vk'").run();
  sqlite.prepare("INSERT INTO task_participants(task_id,member_id) VALUES('task-vk','bot-vk')").run();
  seedMessageEvent(sqlite, { taskId: "root" });
  const reply = await call(db, "/api/bot/tasks/root/messages", {
    method: "POST", body: { bot: "vk", replyToEventId: "evt-private", text: "Private group reply" },
  });
  assert.equal(reply.status, 201);
  assert.equal(reply.json.channelMemberId, "bot-vk");
  assert.equal((await call(db, "/api/bot/tasks/root?bot=vk")).status, 403);
  assert.equal((await call(db, "/api/bot/tasks/root/messages", { method: "POST", body: { bot: "vk", text: "General group reply" } })).status, 403);
  assert.equal((await call(db, "/api/bot/tasks/task-other/status", { method: "POST", body: { bot: "vk", status: "review", result: "Other task" } })).status, 403);
  sqlite.prepare("UPDATE tasks SET deleted_at='2026-11-18' WHERE id='task-vk'").run();
  assert.equal((await call(db, "/api/bot/tasks/root/messages", {
    method: "POST", body: { bot: "vk", replyToEventId: "evt-private", text: "Deleted participant" },
  })).status, 403);
  sqlite.prepare("UPDATE tasks SET deleted_at=NULL WHERE id='task-vk'").run();
  seedMessageEvent(sqlite, { id: "evt-child-private" });
  sqlite.prepare("UPDATE tasks SET deleted_at='2026-11-18' WHERE id='root'").run();
  assert.equal((await call(db, "/api/bot/tasks/task-vk/messages", {
    method: "POST", body: { bot: "vk", replyToEventId: "evt-child-private", text: "Hidden by deleted ancestor" },
  })).status, 404);
});

test("deleted ancestors hide tasks from reads, listings and all writes", async () => {
  const { db, sqlite } = memory();
  sqlite.prepare("UPDATE tasks SET deleted_at='2026-11-18' WHERE id='root'").run();
  assert.equal((await call(db, "/api/bot/tasks/task-vk?bot=vk")).status, 404);
  assert.deepEqual((await call(db, "/api/bot/tasks?bot=vk")).json.tasks, []);
  assert.equal((await call(db, "/api/bot/tasks/task-vk/messages", { method: "POST", body: { bot: "vk", text: "Hidden task" } })).status, 404);
  assert.equal((await call(db, "/api/bot/tasks/task-vk/status", { method: "POST", body: { bot: "vk", status: "doing" } })).status, 404);
});

test("deleting an ancestor between authorization and writing is rejected atomically", async () => {
  for (const action of ["messages", "status"]) {
    const { db, sqlite, hooks } = memory();
    hooks.beforeBatch = () => { sqlite.prepare("UPDATE tasks SET deleted_at='2026-11-18' WHERE id='root'").run(); };
    const response = await call(db, `/api/bot/tasks/task-vk/${action}`, {
      method: "POST", key: "ancestor-race-key", body: { bot: "vk", ...(action === "status" ? { status: "doing" } : { text: "Hidden task" }) },
    });
    assert.equal(response.status, 409);
    assert.equal(sqlite.prepare("SELECT version FROM tasks WHERE id='task-vk'").get().version, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE author_id='bot-vk'").get().n, 0);
  }
});

test("disabled or reconfigured agents cannot finish an authorized write", async () => {
  for (const change of ["enabled=0", "provider='openai'", "slug='renamed'"]) {
    for (const action of ["messages", "status"]) {
      const { db, sqlite, hooks } = memory();
      hooks.beforeBatch = () => { sqlite.exec(`UPDATE bot_configs SET ${change} WHERE member_id='bot-vk'`); };
      const response = await call(db, `/api/bot/tasks/task-vk/${action}`, {
        method: "POST", key: "disabled-race-key", body: { bot: "vk", ...(action === "status" ? { status: "doing" } : { text: "Disabled agent" }) },
      });
      assert.equal(response.status, 409);
      assert.equal(sqlite.prepare("SELECT version FROM tasks WHERE id='task-vk'").get().version, 1);
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE author_id='bot-vk'").get().n, 0);
    }
  }
});

test("accepted results are immutable and an identical done retry is a no-op", async () => {
  const { db, sqlite } = memory();
  sqlite.prepare("UPDATE tasks SET status='done',result='Accepted by manager' WHERE id='task-vk'").run();
  for (const result of ["Changed", ""]) {
    const response = await call(db, "/api/bot/tasks/task-vk/status", { method: "POST", body: { bot: "vk", status: "done", result } });
    assert.equal(response.status, 409);
  }
  assert.equal((await call(db, "/api/bot/tasks/task-vk/status", { method: "POST", body: { bot: "vk", status: "doing" } })).status, 409);
  const same = await call(db, "/api/bot/tasks/task-vk/status", { method: "POST", body: { bot: "vk", status: "done", result: "Accepted by manager" } });
  assert.equal(same.status, 200);
  assert.equal(same.json.version, 1);
  assert.equal(sqlite.prepare("SELECT result FROM tasks WHERE id='task-vk'").get().result, "Accepted by manager");
});

test("review requires a nonblank result, including updates of an existing review", async () => {
  const { db, sqlite } = memory();
  for (const status of ["todo", "doing", "review"]) {
    sqlite.prepare("UPDATE tasks SET status=?,result='' WHERE id='task-vk'").run(status);
    for (const result of [undefined, "", " \n "]) {
      const response = await call(db, "/api/bot/tasks/task-vk/status", { method: "POST", body: { bot: "vk", status: "review", result } });
      assert.equal(response.status, 409, `${status}: ${result}`);
      assert.equal(sqlite.prepare("SELECT version FROM tasks WHERE id='task-vk'").get().version, 1);
    }
  }
});

test("message authorization is checked atomically after owner or participant revocation", async () => {
  for (const participant of [false, true]) {
    for (const key of [undefined, "revoked-message-key"]) {
      const { db, sqlite, hooks } = memory();
      if (participant) {
        sqlite.prepare("UPDATE tasks SET owner_id='me' WHERE id='task-vk'").run();
        sqlite.prepare("INSERT INTO task_participants(task_id,member_id) VALUES('task-vk','bot-vk')").run();
      }
      const revoke = () => {
        sqlite.prepare("UPDATE tasks SET owner_id='me' WHERE id='task-vk'").run();
        sqlite.prepare("DELETE FROM task_participants WHERE task_id='task-vk' AND member_id='bot-vk'").run();
      };
      if (key) hooks.beforeBatch = revoke;
      else hooks.beforeRun = sql => { if (sql.includes("INSERT INTO task_messages")) revoke(); };
      const response = await call(db, "/api/bot/tasks/task-vk/messages", { method: "POST", key, body: { bot: "vk", text: "Revoked access" } });
      assert.equal(response.status, 409);
      assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE author_id='bot-vk'").get().n, 0);
    }
  }
});

test("a private group reply rechecks descendant membership inside its transaction", async () => {
  const { db, sqlite, hooks } = memory();
  seedMessageEvent(sqlite, { taskId: "root" });
  hooks.beforeBatch = () => { sqlite.prepare("UPDATE tasks SET owner_id='me' WHERE id='task-vk'").run(); };
  const response = await call(db, "/api/bot/tasks/root/messages", {
    method: "POST", key: "private-race-key", body: { bot: "vk", replyToEventId: "evt-private", text: "Revoked private access" },
  });
  assert.equal(response.status, 409);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE author_id='bot-vk'").get().n, 0);
});

test("status authorization is checked atomically even without a version change", async () => {
  const { db, sqlite, hooks } = memory();
  hooks.beforeBatch = () => { sqlite.prepare("UPDATE tasks SET owner_id='me' WHERE id='task-vk'").run(); };
  const response = await call(db, "/api/bot/tasks/task-vk/status", {
    method: "POST", key: "status-revocation-key", body: { bot: "vk", status: "doing" },
  });
  assert.equal(response.status, 409);
  assert.equal(sqlite.prepare("SELECT status FROM tasks WHERE id='task-vk'").get().status, "todo");
});

test("concurrent identical status requests mutate once and replay the committed response", async () => {
  const { db, sqlite, hooks } = memory();
  batchBarrier(hooks);
  const options = { method: "POST", key: "concurrent-status-key", body: { bot: "vk", status: "doing" } };
  const responses = await Promise.all([call(db, "/api/bot/tasks/task-vk/status", options), call(db, "/api/bot/tasks/task-vk/status", options)]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.deepEqual(responses[0].json, responses[1].json);
  assert.equal(responses[0].json.version, 2);
  assert.equal(responses.filter(response => response.headers.get("Idempotency-Replayed") === "true").length, 1);
  assert.equal(sqlite.prepare("SELECT version FROM tasks WHERE id='task-vk'").get().version, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM bot_api_idempotency").get().n, 1);
});

test("concurrent message retries create and notify exactly once", async () => {
  const { db, sqlite, hooks } = memory();
  batchBarrier(hooks);
  const notifications = [];
  const deps = { db, token: TOKEN, onMessage: async (_task, message) => { notifications.push(message.id); } };
  const options = { method: "POST", key: "concurrent-message-key", body: { bot: "vk", text: "Only once" } };
  const responses = await Promise.all([
    handleBotApi(request("/api/bot/tasks/task-vk/messages", options), deps),
    handleBotApi(request("/api/bot/tasks/task-vk/messages", options), deps),
  ]);
  assert.deepEqual(responses.map(response => response.status), [201, 201]);
  assert.deepEqual(await responses[0].json(), await responses[1].json());
  assert.equal(notifications.length, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE author_id='bot-vk'").get().n, 1);
});

test("the same key rejects a changed body, while JSON property order does not matter", async () => {
  const { db, sqlite } = memory();
  const first = await call(db, "/api/bot/tasks/task-vk/status", {
    method: "POST", key: "body-match-key", body: { bot: "vk", status: "doing" },
  });
  const reordered = await call(db, "/api/bot/tasks/task-vk/status", {
    method: "POST", key: "body-match-key", body: { status: "doing", bot: "vk" },
  });
  assert.deepEqual(reordered.json, first.json);
  assert.equal(reordered.headers.get("Idempotency-Replayed"), "true");
  const changed = await call(db, "/api/bot/tasks/task-vk/status", {
    method: "POST", key: "body-match-key", body: { bot: "vk", status: "review", result: "Different request" },
  });
  assert.equal(changed.status, 409);
  assert.equal(sqlite.prepare("SELECT status,version FROM tasks WHERE id='task-vk'").get().version, 2);
});

test("competing bodies using one key cannot both mutate the task", async () => {
  const { db, sqlite, hooks } = memory();
  batchBarrier(hooks);
  const responses = await Promise.all([
    call(db, "/api/bot/tasks/task-vk/status", { method: "POST", key: "competing-bodies-key", body: { bot: "vk", status: "doing" } }),
    call(db, "/api/bot/tasks/task-vk/status", { method: "POST", key: "competing-bodies-key", body: { bot: "vk", status: "review", result: "Competing request" } }),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(sqlite.prepare("SELECT version FROM tasks WHERE id='task-vk'").get().version, 2);
});

test("concurrent requests on different routes cannot reuse one key for two mutations", async () => {
  const { db, sqlite, hooks } = memory();
  batchBarrier(hooks);
  const responses = await Promise.all([
    call(db, "/api/bot/tasks/task-vk/status", { method: "POST", key: "different-routes-key", body: { bot: "vk", status: "doing" } }),
    call(db, "/api/bot/tasks/task-vk/messages", { method: "POST", key: "different-routes-key", body: { bot: "vk", text: "Different route" } }),
  ]);
  assert.equal(responses.filter(response => response.status === 409).length, 1);
  const statusWrites = sqlite.prepare("SELECT version-1 AS n FROM tasks WHERE id='task-vk'").get().n;
  const messageWrites = sqlite.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE author_id='bot-vk'").get().n;
  assert.equal(statusWrites + messageWrites, 1);
});

test("responses stored before request hashes were introduced remain replayable", async () => {
  const { db, sqlite } = memory();
  const original = { id: "task-vk", status: "doing", result: "", version: 2 };
  sqlite.prepare(`INSERT INTO bot_api_idempotency
    (bot_member_id,idempotency_key,method,path,status,body,created_at)
    VALUES ('bot-vk','legacy-key-123','POST','/api/bot/tasks/task-vk/status',200,?,'2026-11-18')`)
    .run(JSON.stringify(original));
  const response = await call(db, "/api/bot/tasks/task-vk/status", {
    method: "POST", key: "legacy-key-123", body: { bot: "vk", status: "doing" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Idempotency-Replayed"), "true");
  assert.deepEqual(response.json, original);
  assert.equal(sqlite.prepare("SELECT version FROM tasks WHERE id='task-vk'").get().version, 1);
});

test("failure saving the idempotency response rolls back the mutation and permits retry", async () => {
  for (const action of ["status", "messages"]) {
    const { db, sqlite, hooks } = memory();
    hooks.beforeExecute = sql => { if (sql.includes("INSERT OR IGNORE INTO bot_api_idempotency")) throw new Error("simulated response persistence failure"); };
    const options = { method: "POST", key: "rollback-idempotency-key", body: { bot: "vk", ...(action === "status" ? { status: "doing" } : { text: "Retry safely" }) } };
    await assert.rejects(() => call(db, `/api/bot/tasks/task-vk/${action}`, options), /simulated response persistence failure/);
    assert.equal(sqlite.prepare("SELECT version FROM tasks WHERE id='task-vk'").get().version, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM task_messages WHERE author_id='bot-vk'").get().n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM bot_api_idempotency").get().n, 0);
    hooks.beforeExecute = null;
    const retried = await call(db, `/api/bot/tasks/task-vk/${action}`, options);
    assert.equal(retried.status, action === "status" ? 200 : 201);
  }
});

test("end-to-end: local receiver, assign event, then bot replies through the API", async () => {
  const { notifyGrokBotTaskChange } = await import("../lib/ruli/agent-webhook.ts");
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200); res.end("ok");
    });
  });
  const port = await new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const { db, sqlite } = memory();
  try {
    await notifyGrokBotTaskChange({
      db,
      config: { url: `http://127.0.0.1:${port}/hook`, key: "e2e-key", baseUrl: "http://127.0.0.1:5173" },
      uuid: () => "evt-e2e",
      now: () => new Date("2026-11-18T03:00:00.000Z"),
    }, null, {
      id: "task-vk", title: "Пост ВК", description: "Описание", status: "todo",
      priority: "high", due: null, parentId: "root", ownerId: "bot-vk", participants: [],
    });
    const started = Date.now();
    while (!received.length && Date.now() - started < 2000) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(received[0].event, "task.assigned");
    assert.equal(received[0].eventId, "evt-e2e");
    const api = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const headers = new Headers(req.headers);
      const response = await handleBotApi(new Request(`https://ruli.example${url.pathname}${url.search}`, {
        method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
      }), { db, token: TOKEN, baseUrl: "http://127.0.0.1:5173" });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    const apiPort = await new Promise(resolve => api.listen(0, "127.0.0.1", () => resolve(api.address().port)));
    try {
      const reply = await fetch(`http://127.0.0.1:${apiPort}/api/bot/tasks/task-vk/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Idempotency-Key": "e2e-reply-1" },
        body: JSON.stringify({ bot: "vk", text: "Пост опубликован.", replyToEventId: "evt-e2e" }),
      });
      assert.equal(reply.status, 201);
      const row = sqlite.prepare("SELECT body,author_name AS name FROM task_messages WHERE author_id='bot-vk'").get();
      assert.equal(row.body, "Пост опубликован.");
      assert.equal(row.name, "ВКонтакте");
    } finally {
      await new Promise(resolve => api.close(resolve));
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
