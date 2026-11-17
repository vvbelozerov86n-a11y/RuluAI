import test from "node:test";
import assert from "node:assert/strict";
import * as policy from "../lib/ruli/policy.ts";
import { barrier, collaborationHarness, plain, redirectMessage, TestRedirect } from "./collaboration-helper.mjs";

function fixture(t) { const h = collaborationHarness(); t.after(() => h.close()); return h; }
const message = (overrides = {}) => ({ taskId: "launch", channelMemberId: "", body: "Готовим письмо", clientId: "message-id-0001", ...overrides });
const plan = (overrides = {}) => ({ taskId: "launch", version: 0, startDate: "2026-11-17", hoursPerDay: 8, estimatedHoursPerTask: 4, weekdaysOnly: "on", ...overrides });
const editEntry = (entry, overrides = {}) => ({ taskId: entry.plan_task_id, id: entry.id, version: entry.version, planVersion: 1, startDate: entry.start_date, endDate: entry.end_date, hours: entry.hours, ...overrides });

test("channel policy: manager and matching executor can access private messages; viewer is read-only", () => {
  const anna = { role: "executor", memberId: "anna" };
  const manager = { role: "manager", memberId: "me" };
  const viewer = { role: "viewer", memberId: "anna" };
  assert.equal(policy.canReadChannel(anna, "anna"), true);
  assert.equal(policy.canReadChannel(anna, "max"), false);
  assert.equal(policy.canReadChannel(manager, "anna"), true);
  assert.equal(policy.canWriteChannel(manager, "anna"), true);
  assert.equal(policy.canReadChannel(viewer, "anna"), false);
  assert.equal(policy.canReadChannel(viewer, null), true);
  assert.equal(policy.canWriteChannel(viewer, null), false);
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
