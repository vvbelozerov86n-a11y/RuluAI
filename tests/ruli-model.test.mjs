// Модель «Рули»: агрегаты, сроки и правила даты/числа (чистые функции без Workers).
import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_SIZES,
  addDaysISO,
  dueDateFromInput,
  dueLabelFromISO,
  findPath,
  isBlockSize,
  isBlockTheme,
  isISODate,
  isOverdue,
  leaves,
  peopleOf,
  plural,
  progress,
  stats,
  todayISO,
  validateDueDateInput,
} from "../lib/ruli/model.ts";

const members = new Map([
  ["anna", { id: "anna", name: "Анна", shortName: "Анна", role: "", initials: "АС", color: "rose", type: "human" }],
  ["analyst", { id: "analyst", name: "Grok · Аналитик", shortName: "Grok", role: "", initials: "✳", color: "bot", type: "bot" }],
  ["me", { id: "me", name: "Руководитель", shortName: "Вы", role: "", initials: "ВЫ", color: "", type: "human" }],
]);

function leaf(id, overrides = {}) {
  return {
    id,
    parentId: "group",
    kind: "leaf",
    title: id,
    ownerId: "anna",
    status: "todo",
    dueLabel: "Без срока",
    dueDate: null,
    description: "",
    result: "",
    size: "small",
    theme: "teal",
    position: 0,
    children: [],
    participants: [],
    version: 1,
    deletedAt: null,
    splitSourceId: null,
    ...overrides,
  };
}

function group(id, children, overrides = {}) {
  return {
    id,
    parentId: "root",
    kind: "group",
    title: id,
    ownerId: "me",
    status: null,
    dueLabel: "Без срока",
    dueDate: null,
    description: "",
    result: "",
    size: "small",
    theme: "teal",
    position: 0,
    children,
    participants: [],
    version: 1,
    deletedAt: null,
    splitSourceId: null,
    ...overrides,
  };
}

test("stats считает листья, готовность и просрочки без завершённых", () => {
  const tree = group("root", [
    group("group", [
      leaf("done", { status: "done", dueDate: "2026-01-01" }),
      leaf("review", { status: "review" }),
      leaf("late", { status: "doing", dueDate: "2026-01-01" }),
    ]),
    leaf("plain"),
  ]);
  assert.deepEqual(stats(tree, "2026-01-10"), { total: 4, done: 1, review: 1, late: 1 });
  assert.equal(progress(stats(tree, "2026-01-10")), 25);
  assert.equal(progress({ total: 0, done: 0, review: 0, late: 0 }), 0);
});

test("peopleOf объединяет ответственных и участников по типам без повторов", () => {
  const tree = group("root", [
    group(
      "group",
      [leaf("a", { ownerId: "analyst", participants: ["anna"] }), leaf("b", { ownerId: "analyst" })],
      { ownerId: "me", participants: ["analyst"] },
    ),
  ]);
  const people = peopleOf(tree, members);
  assert.deepEqual(people.human.sort(), ["anna", "me"]);
  assert.deepEqual(people.bot, ["analyst"]);
});

test("findPath возвращает путь от корня и null для отсутствующих id", () => {
  const tree = group("root", [group("group", [leaf("leaf")])]);
  const path = findPath("leaf", tree);
  assert.deepEqual(
    path?.map((node) => node.id),
    ["root", "group", "leaf"],
  );
  assert.equal(findPath("missing", tree), null);
});

test("dueDateFromInput понимает ISO, ДД.ММ.ГГГГ, короткие даты и мусор", () => {
  assert.equal(dueDateFromInput("2026-11-24"), "2026-11-24");
  assert.equal(dueDateFromInput("24.11.2026"), "2026-11-24");
  assert.equal(dueDateFromInput("24 ноября", new Date("2026-11-17T12:00:00Z")), "2026-11-24");
  assert.equal(dueDateFromInput("Без срока"), null);
  assert.equal(dueDateFromInput("скоро"), null);
  assert.equal(dueDateFromInput(""), null);
});

test("dueLabelFromISO помечает сегодня и вчера", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  assert.equal(dueLabelFromISO("2026-11-17", now), "Сегодня");
  assert.equal(dueLabelFromISO("2026-11-16", now), "Вчера");
  assert.equal(dueLabelFromISO("2026-11-24", now).startsWith("24 ноя"), true);
});

test("plural склоняет числа по правилам русского языка", () => {
  assert.equal(plural(1, "задача", "задачи", "задач"), "1 задача");
  assert.equal(plural(2, "задача", "задачи", "задач"), "2 задачи");
  assert.equal(plural(5, "задача", "задачи", "задач"), "5 задач");
  assert.equal(plural(11, "задача", "задачи", "задач"), "11 задач");
  assert.equal(plural(21, "задача", "задачи", "задач"), "21 задача");
});

test("размеры блоков покрывают все варианты бенто-сетки", () => {
  assert.deepEqual(Object.keys(BLOCK_SIZES), ["small", "wide", "tall", "large"]);
  assert.equal(BLOCK_SIZES.wide.w, 2);
  assert.equal(BLOCK_SIZES.tall.h, 2);
});

test("пустые и удалённые группы не создают незавершённые поручения", () => {
  const empty = group("empty", [], { dueDate: "2026-01-01" });
  assert.deepEqual(leaves(empty), []);
  assert.deepEqual(stats(empty, "2026-11-17"), { total: 0, done: 0, review: 0, late: 0 });
  assert.equal(isOverdue(empty, "2026-11-17"), false);
  const tree = group("root", [empty, group("deleted", [leaf("hidden")], { deletedAt: "2026-11-17T00:00:00Z" })]);
  assert.equal(stats(tree, "2026-11-17").total, 0);
});

test("завершённая группа не просрочена, а незавершённая учитывает собственный срок", () => {
  const tree = group("project", [leaf("ready", { status: "done" }), group("empty", [])], { dueDate: "2026-01-01" });
  assert.equal(isOverdue(tree, "2026-11-17"), false);
  assert.equal(progress(stats(tree, "2026-11-17")), 100);
  tree.children.push(leaf("unfinished"));
  assert.equal(isOverdue(tree, "2026-11-17"), true);
  assert.equal(isOverdue(leaf("invalid", { dueDate: "2026-02-31" }), "2026-11-17"), false);
});

test("строгие календарные даты отклоняют rollover и учитывают правила високосных лет", () => {
  for (const invalid of ["2026-02-31", "31.02.2026", "31 апреля 2026", "29 февраля 1900", "2026-00-01", "2026-13-01", "0000-01-01", "24 ноябелиберда", "29 февраля 2027"]) {
    assert.equal(dueDateFromInput(invalid), null, invalid);
    assert.equal(validateDueDateInput(invalid).valid, false, invalid);
  }
  assert.equal(dueDateFromInput("29 февраля 2000"), "2000-02-29");
  assert.equal(dueDateFromInput("1 май 2027"), "2027-05-01");
  assert.equal(dueDateFromInput("24 нояб. 2027 г."), "2027-11-24");
  assert.equal(isISODate("2024-02-29"), true);
  assert.equal(isISODate("2026-2-01"), false);
  assert.equal(isISODate(null), false);
  assert.deepEqual(validateDueDateInput(" Без срока "), { valid: true, date: null });
  assert.deepEqual(validateDueDateInput(""), { valid: true, date: null });
});

test("день и неявный год определяются в timezone команды, а не в UTC хоста", () => {
  const boundary = new Date("2026-12-31T18:00:00Z");
  assert.equal(todayISO(boundary), "2027-01-01");
  assert.equal(todayISO(boundary, "UTC"), "2026-12-31");
  assert.equal(dueDateFromInput("2 января", boundary), "2027-01-02");
  assert.equal(dueDateFromInput("2 января", boundary, "UTC"), "2026-01-02");
  assert.equal(dueLabelFromISO("2027-01-01", boundary), "Сегодня");
  assert.equal(dueLabelFromISO("2026-12-31", boundary), "Вчера");
  assert.equal(dueLabelFromISO("2027-01-01", new Date("2027-01-01T18:00:00Z")), "Вчера");
  assert.match(dueLabelFromISO("2028-11-24", boundary), /2028/);
  assert.equal(dueLabelFromISO("2026-02-31", boundary), "Некорректная дата");
});

test("календарная арифметика не зависит от DST и не нормализует несуществующие дни", () => {
  assert.equal(addDaysISO("2024-02-28", 1), "2024-02-29");
  assert.equal(addDaysISO("2024-02-29", 1), "2024-03-01");
  assert.equal(addDaysISO("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysISO("2026-03-29", -1), "2026-03-28");
  assert.throws(() => addDaysISO("2026-02-31", 1), RangeError);
  assert.throws(() => addDaysISO("9999-12-31", 1), RangeError);
  assert.throws(() => addDaysISO("2026-11-17", 0.5), RangeError);
});

test("имена свойств прототипа не проходят валидацию размеров и тем", () => {
  for (const value of ["constructor", "toString", "__proto__"]) {
    assert.equal(isBlockSize(value), false);
    assert.equal(isBlockTheme(value), false);
  }
});
