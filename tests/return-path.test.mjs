import test from "node:test";
import assert from "node:assert/strict";
import { returnPath, safeRelativeReturnPath, taskPagePath } from "../lib/ruli/return-path.ts";

test("safeRelativeReturnPath keeps same-origin relative paths and query strings", () => {
  assert.equal(safeRelativeReturnPath("/"), "/");
  assert.equal(safeRelativeReturnPath("/team"), "/team");
  assert.equal(safeRelativeReturnPath("/t/launch"), "/t/launch");
  assert.equal(safeRelativeReturnPath("/t/task-1/edit"), "/t/task-1/edit");
  assert.equal(safeRelativeReturnPath("/new?parent=root&mode=view"), "/new?parent=root&mode=view");
  assert.equal(safeRelativeReturnPath("/?q=%D0%BF%D1%80%D0%BE%D0%B4%D0%B0%D0%B6%D0%B8"), "/?q=%D0%BF%D1%80%D0%BE%D0%B4%D0%B0%D0%B6%D0%B8");
  assert.equal(safeRelativeReturnPath("/t/launch#collaboration"), "/t/launch#collaboration");
});

test("safeRelativeReturnPath rejects open redirects and auth loops", () => {
  const rejected = [
    "", "team", "https://evil.example", "http://evil.example", "//evil.example",
    "///evil.example", "/\\evil.example", "/\\\\evil", "\\\\/\\\\/evil.example",
    "javascript:alert(1)", " /team", "/signin-with-chatgpt",
    "/signin-with-chatgpt?return_to=/", "/signout-with-chatgpt", "/callback",
    "/team/..//evil.example", "/team%0d%0aLocation:%20https://evil.example",
    "/team\r\nLocation: https://evil.example",
  ];
  for (const value of rejected) {
    assert.equal(safeRelativeReturnPath(value), "/", value);
  }
});

test("taskPagePath encodes the id as a single segment and keeps allowed filters", () => {
  assert.equal(taskPagePath("root"), "/");
  assert.equal(taskPagePath("launch"), "/t/launch");
  assert.equal(taskPagePath("launch", { mode: "view", layout: "cards", chat: "anna", flash: "ignore" }), "/t/launch?mode=view&layout=cards&chat=anna");
  assert.equal(taskPagePath("launch", { mode: "build" }, "/edit"), "/t/launch/edit?mode=build");
  assert.equal(taskPagePath("a/b?x=1"), "/t/a%2Fb%3Fx%3D1");
  assert.equal(taskPagePath(""), "/");
  assert.equal(returnPath("/new", { parent: "root", mode: "view", error: "no" }, ["parent", "mode"]), "/new?parent=root&mode=view");
  assert.equal(returnPath("/new", { parent: ["x"] }, ["parent"]), "/new");
  assert.equal(returnPath("//evil.example"), "/");
  assert.equal(returnPath("/", { q: "продажи", late: "1", due: "today" }, ["q", "owner", "status", "late", "due", "mode", "layout", "chat"]), "/?q=%D0%BF%D1%80%D0%BE%D0%B4%D0%B0%D0%B6%D0%B8&late=1&due=today");
});
