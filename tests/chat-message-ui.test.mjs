import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const cache = new Map();
function load(relative) {
  let filename = path.resolve(root, relative);
  if (!path.extname(filename)) filename = [".tsx", ".ts"].map(ext => filename + ext).find(fs.existsSync);
  if (!filename) throw new Error(`Module not found: ${relative}`);
  if (cache.has(filename)) return cache.get(filename).exports;
  const compiledModule = { exports: {} };
  cache.set(filename, compiledModule);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module: compiledModule, exports: compiledModule.exports, console, URL,
    require: id => id.startsWith(".") ? load(path.resolve(path.dirname(filename), id)) : require(id),
  }, { filename });
  return compiledModule.exports;
}
const { MessageContent } = load("components/ruli/message-content.tsx");
const render = body => renderToStaticMarkup(React.createElement(MessageContent, { body }));

test("actual rich-text SSR escapes hostile HTML and only creates safe external http(s) links", () => {
  const html = render('<script>alert(1)</script> <img src=x onerror="alert(2)">\njavascript:alert(3) data:text/html,<svg onload=alert(4)>\nhttps://example.com/path?q=1&x=2 http://example.org');
  assert.doesNotMatch(html, /<script\b|<img\b|<svg[^>]*onload|href="(?:javascript:|data:)/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(2\)&quot;&gt;/);
  assert.match(html, /javascript:alert\(3\)/);
  const links = [...html.matchAll(/<a\b[^>]*>/g)].map(match => match[0]);
  assert.equal(links.length, 2);
  for (const link of links) {
    assert.match(link, /href="https?:\/\//);
    assert.match(link, /target="_blank"/);
    assert.match(link, /rel="noopener noreferrer"/);
  }
});

test("fenced code is escaped, remains literal and provides a code-copy control", () => {
  const html = render('```html\n<img src=x onerror="run()">\nhttps://example.com\n```');
  assert.match(html, /<pre[^>]*><code>&lt;img src=x onerror=&quot;run\(\)&quot;&gt;\nhttps:\/\/example.com<\/code><\/pre>/);
  assert.doesNotMatch(html, /<img\b|<a\b/);
  assert.match(html, /aria-label="Скопировать код"/);
});

test("bullets, ordered lists and quotes render semantic elements without interpreting nested HTML", () => {
  const html = render('- Проверка\n- <b>текст</b>\n\n1. Шаг\n2. Результат\n\n> Имя:\n> <iframe src=evil>');
  assert.match(html, /<ul>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<blockquote class="message-quote">/);
  assert.match(html, /&lt;b&gt;текст&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>|<iframe/);
});
