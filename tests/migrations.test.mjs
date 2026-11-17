import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "drizzle");
const journal = JSON.parse(fs.readFileSync(path.join(directory, "meta/_journal.json"), "utf8"));

test("every migration has a linked snapshot and increasing publication timestamp", () => {
  let previous = "00000000-0000-0000-0000-000000000000";
  let timestamp = 0;
  for (const entry of journal.entries) {
    const snapshot = JSON.parse(fs.readFileSync(path.join(directory, "meta", `${String(entry.idx).padStart(4, "0")}_snapshot.json`), "utf8"));
    assert.equal(snapshot.prevId, previous);
    assert.ok(entry.when > timestamp, `${entry.tag} must follow its predecessor`);
    assert.ok(fs.existsSync(path.join(directory, `${entry.tag}.sql`)));
    previous = snapshot.id;
    timestamp = entry.when;
  }
});

test("request hash migration preserves existing bot replies and outbox records", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const entry of journal.entries.filter(entry => entry.idx <= 4)) {
      db.exec(fs.readFileSync(path.join(directory, `${entry.tag}.sql`), "utf8"));
    }
    db.exec(`INSERT INTO bot_api_idempotency VALUES ('bot-test','request-test','POST','/api/bot/tasks/task/status',200,'{"version":2}','2026-11-18T00:00:00Z');
      INSERT INTO bot_webhook_outbox (id,event,task_id,bot_member_id,bot_slug,payload,status,created_at,updated_at)
      VALUES ('event-test','task.assigned','task','bot-test','test','{}','failed','2026-11-18T00:00:00Z','2026-11-18T00:00:00Z');`);
    for (const entry of journal.entries.filter(entry => entry.idx > 4)) {
      db.exec(fs.readFileSync(path.join(directory, `${entry.tag}.sql`), "utf8"));
    }
    const record = db.prepare("SELECT status,body,request_hash AS requestHash FROM bot_api_idempotency").get();
    assert.deepEqual({ ...record }, { status: 200, body: '{"version":2}', requestHash: null });
    assert.equal(db.prepare("SELECT status FROM bot_webhook_outbox WHERE id='event-test'").get().status, "failed");
    const primaryKey = db.prepare("PRAGMA table_info(bot_api_idempotency)").all().filter(column => column.pk).map(column => column.name);
    assert.deepEqual(primaryKey, ["bot_member_id", "idempotency_key"]);
  } finally { db.close(); }
});

test("unchanged schema generates no duplicate migration", () => {
  const tempBase = path.resolve(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(tempBase, "ruli-migration-check-"));
  const output = path.join(scratch, "drizzle");
  try {
    fs.cpSync(directory, output, { recursive: true });
    const before = fs.readdirSync(output).filter(name => name.endsWith(".sql")).sort();
    execFileSync(process.execPath, [path.join(root, "node_modules/drizzle-kit/bin.cjs"), "generate", "--dialect", "sqlite", "--schema", "db/schema.ts", "--out", output.replaceAll("\\", "/")], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
    });
    const after = fs.readdirSync(output).filter(name => name.endsWith(".sql")).sort();
    assert.deepEqual(after, before, "Schema generation must not recreate existing tables or columns");
  } finally {
    const resolved = path.resolve(scratch);
    assert.equal(path.dirname(resolved), tempBase);
    assert.ok(path.basename(resolved).startsWith("ruli-migration-check-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
