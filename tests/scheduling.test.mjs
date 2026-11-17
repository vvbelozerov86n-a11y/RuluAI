import test from "node:test";
import assert from "node:assert/strict";
import { addDaysISO } from "../lib/ruli/model.ts";
import {
  generateSchedule,
  validateScheduleOptions,
  validateScheduleRange,
  MAX_SCHEDULE_DAYS,
  MAX_SCHEDULE_ENTRIES,
} from "../lib/ruli/scheduling.ts";

const leaf = (id, overrides = {}) => ({
  id, parentId: "root", kind: "leaf", title: id, ownerId: "anna", status: "todo",
  dueLabel: "Без срока", dueDate: null, description: "", result: "", size: "small", theme: "teal",
  position: 0, children: [], participants: [], version: 1, deletedAt: null, splitSourceId: null, ...overrides,
});
const group = (children, overrides = {}) => leaf("root", { kind: "group", status: null, parentId: null, children, ...overrides });
const options = (overrides = {}) => ({ startDate: "2026-11-17", hoursPerDay: 8, weekdaysOnly: true, ...overrides });
const existingEntry = (overrides = {}) => ({ taskId: "other", memberId: "anna", title: "Другая работа", startDate: "2026-11-17", endDate: "2026-11-17", hours: 6, ...overrides });

test("график создаёт только реальные незавершённые листья и использует их ответственных", () => {
  const tree = group([
    leaf("first"), leaf("second"), leaf("parallel", { ownerId: "writer" }),
    leaf("complete", { status: "done" }), group([], { id: "empty" }),
    group([leaf("hidden")], { id: "deleted", deletedAt: "2026-11-17T00:00:00Z" }),
  ]);
  const before = structuredClone(tree);
  const result = generateSchedule(tree, options({ hoursPerDay: 6 }));
  assert.deepEqual(result.entries.map(({ taskId, memberId, startDate, hours }) => ({ taskId, memberId, startDate, hours })), [
    { taskId: "first", memberId: "anna", startDate: "2026-11-17", hours: 4 },
    { taskId: "second", memberId: "anna", startDate: "2026-11-17", hours: 2 },
    { taskId: "second", memberId: "anna", startDate: "2026-11-18", hours: 2 },
    { taskId: "parallel", memberId: "writer", startDate: "2026-11-17", hours: 4 },
  ]);
  assert.ok(result.entries.every((entry) => entry.startDate === entry.endDate));
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(tree, before);
});

test("выходные пропускаются, поручения одного исполнителя идут последовательно", () => {
  const result = generateSchedule(group([leaf("first"), leaf("second")]), options({ startDate: "2026-11-20", hoursPerDay: 4, estimatedHoursPerTask: 6 }));
  assert.deepEqual(result.entries.map((entry) => [entry.taskId, entry.startDate, entry.hours]), [
    ["first", "2026-11-20", 4], ["first", "2026-11-23", 2],
    ["second", "2026-11-23", 2], ["second", "2026-11-24", 4],
  ]);
  assert.equal(generateSchedule(leaf("weekend"), options({ startDate: "2026-11-21", weekdaysOnly: false })).entries[0].startDate, "2026-11-21");
});

test("учитывается остаточная дневная загрузка без влияния на другого исполнителя", () => {
  const existing = [existingEntry()];
  const before = structuredClone(existing);
  const result = generateSchedule(group([leaf("a"), leaf("b", { ownerId: "max" })]), options(), existing);
  assert.deepEqual(result.entries.map((entry) => [entry.taskId, entry.startDate, entry.hours]), [
    ["a", "2026-11-17", 2], ["a", "2026-11-18", 2], ["b", "2026-11-17", 4],
  ]);
  assert.deepEqual(existing, before);
});

test("существующий интервал равномерно занимает календарные дни, будущая занятость не игнорируется", () => {
  const result = generateSchedule(leaf("draft"), options({ hoursPerDay: 4, estimatedHoursPerTask: 6 }), [
    existingEntry({ endDate: "2026-11-19", hours: 6 }),
    existingEntry({ taskId: "meeting", startDate: "2026-11-18", endDate: "2026-11-18", hours: 2 }),
  ]);
  assert.deepEqual(result.entries.map((entry) => [entry.startDate, entry.hours]), [["2026-11-17", 2], ["2026-11-19", 2], ["2026-11-20", 2]]);
});

test("невозможный срок поручения и родительского запуска дают отдельные предупреждения", () => {
  const result = generateSchedule(group([leaf("letter", { dueDate: "2026-11-17" })], { title: "Запуск", dueDate: "2026-11-17" }), options({ hoursPerDay: 2 }));
  assert.equal(result.entries.at(-1).endDate, "2026-11-18");
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some((message) => /letter.*2026-11-17.*2026-11-18/.test(message)));
  assert.ok(result.warnings.some((message) => /Запуск.*недостижим/.test(message)));
});

test("перегруженные существующие дни дают предупреждение и не получают новой работы", () => {
  const result = generateSchedule(leaf("new"), options(), [existingEntry({ hours: 8 }), existingEntry({ taskId: "conflict", hours: 8 })]);
  assert.equal(result.entries[0].startDate, "2026-11-18");
  assert.match(result.warnings[0], /существующая загрузка превышает/);
});

test("валидация не маскирует плохие даты, часы и диапазоны", () => {
  assert.equal(validateScheduleRange("2026-11-17", "2026-11-18", 16, 8), null);
  for (const [start, end, hours] of [["2026-02-31", "2026-03-01", 4], ["2026-11-18", "2026-11-17", 4], ["2026-11-17", "2026-11-17", 13], ["2026-11-17", "2026-11-17", 0]]) {
    assert.ok(validateScheduleRange(start, end, hours));
  }
  for (const overrides of [{ startDate: "31.02.2026" }, { hoursPerDay: 0 }, { hoursPerDay: 13 }, { hoursPerDay: NaN }, { estimatedHoursPerTask: 0 }, { estimatedHoursPerTask: Infinity }, { estimatedHoursPerTask: 241 }, { weekdaysOnly: "yes" }]) {
    assert.ok(validateScheduleOptions(options(overrides)));
    assert.throws(() => generateSchedule(leaf("a"), options(overrides)), RangeError);
  }
  assert.throws(() => generateSchedule(leaf("a"), options(), [existingEntry({ hours: -1 })]), RangeError);
});

test("лимит записей не оставляет наполовину запланированное поручение", () => {
  const tree = group(Array.from({ length: 9 }, (_, index) => leaf(`task-${index}`)));
  const result = generateSchedule(tree, options({ hoursPerDay: 1, estimatedHoursPerTask: 240, weekdaysOnly: false }));
  assert.equal(result.entries.length, 1920);
  assert.ok(result.entries.length <= MAX_SCHEDULE_ENTRIES);
  assert.equal(result.entries.some((entry) => entry.taskId === "task-8"), false);
  assert.match(result.warnings.at(-1), /лимит 2000 записей/);
  for (let index = 0; index < 8; index++) assert.equal(result.entries.filter((entry) => entry.taskId === `task-${index}`).reduce((sum, entry) => sum + entry.hours, 0), 240);
});

test("500 стандартных поручений помещаются ровно в лимит без превышения дневной ёмкости", () => {
  const result = generateSchedule(group(Array.from({ length: 500 }, (_, index) => leaf(`t-${index}`))), options({ hoursPerDay: 1 }));
  assert.equal(result.entries.length, 2000);
  assert.equal(result.warnings.length, 0);
  const totals = new Map();
  for (const entry of result.entries) totals.set(entry.startDate, (totals.get(entry.startDate) ?? 0) + entry.hours);
  assert.ok([...totals.values()].every((hours) => hours <= 1));
});

test("занятый горизонт останавливает исполнителя, но свободный коллега может работать", () => {
  const opts = options({ hoursPerDay: 1, weekdaysOnly: false });
  const result = generateSchedule(group([leaf("busy"), leaf("free", { ownerId: "max" })]), opts, [
    existingEntry({ endDate: addDaysISO(opts.startDate, MAX_SCHEDULE_DAYS - 1), hours: MAX_SCHEDULE_DAYS }),
  ]);
  assert.deepEqual(result.entries.map((entry) => entry.taskId), ["free", "free", "free", "free"]);
  assert.match(result.warnings.at(-1), /горизонт 3660/);
});

test("пустые планы не придумывают работу или ответственных", () => {
  assert.deepEqual(generateSchedule(group([]), options()), { entries: [], warnings: [] });
  assert.deepEqual(generateSchedule(leaf("done", { status: "done" }), options()), { entries: [], warnings: [] });
  const missing = generateSchedule(leaf("orphan", { ownerId: "" }), options());
  assert.deepEqual(missing.entries, []);
  assert.match(missing.warnings[0], /Не назначен ответственный/);
});
