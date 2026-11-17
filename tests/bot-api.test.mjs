import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as model from "../lib/ruli/model.ts";
import * as botCatalog from "../lib/ruli/bot-catalog.ts";
import * as webhook from "../lib/ruli/agent-webhook.ts";
import { loadModule } from "./collaboration-helper.mjs";

const { handleBotApi, timingSafeEqualText } = loadModule("lib/ruli/bot-api.ts", { ...model, ...botCatalog, ...webhook }, ["handleBotApi", "timingSafeEqualText"]);

const TOKEN = "test-bot-token-please-change";

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
    INSERT INTO tasks(id,parent_id,kind,title,owner_id,status,priority,description,result,version) VALUES
    ('root',NULL,'group','Все','me',NULL,NULL,'','',1),
    ('task-vk','root','leaf','Пост ВК','bot-vk','todo','high','Описание','',1),
    ('task-other','root','leaf','Чужое','bot-dzen','doing',NULL,'Секрет','',1);
    INSERT INTO task_messages(id,task_id,channel_member_id,author_id,author_user_id,author_name,body,client_id,created_at) VALUES
    ('msg-1','task-vk',NULL,'me','user-manager','Владислав','Сделай обложку','c1','2026-11-18T00:00:00.000Z');`);
  return { sqlite, db: d1(sqlite) };
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
