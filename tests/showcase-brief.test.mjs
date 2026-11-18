import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const script = new vm.Script(readFileSync(new URL("../public/belozerov-ai/app.js", import.meta.url), "utf8"));
const demoRequest = "Хочу посмотреть демонстрацию Криппи";

// Exercise the actual click, input, change, submit and clipboard handlers without leaving the test.
function brief(url = "https://example.test/vitrina") {
  function control(props = {}) {
    const handlers = new Map();
    return {
      addEventListener(type, handler) { handlers.set(type, handler); },
      fire(type, target = this) { return handlers.get(type)?.({ target, preventDefault() {} }); },
      closest() { return null; },
      focus() {},
      ...props,
    };
  }

  const field = () => control({ value: "", required: true, setCustomValidity(message) { this.error = message; } });
  const name = field(), contact = field(), task = field();
  task.minLength = 10;
  const topic = {
    value: "other",
    options: ["other", "training", "krippi"].map(value => ({ value, textContent: value })),
    get selectedOptions() { return this.options.filter(option => option.value === this.value); },
  };
  const form = control({
    elements: { namedItem: key => ({name, contact, task, topic})[key] },
    reportValidity: () => [name, contact, task].every(input =>
      !input.error && (!input.required || input.value) && (!input.value || input.value.length >= (input.minLength ?? 0))),
  });
  const general = control({ dataset: {} }), training = control({ dataset: { topic: "training" } });
  const dialog = control({ showModal() { this.open = true; } });
  const intro = { textContent: "Обсудим вашу задачу." };
  const copyButton = control();
  const elements = {
    "#brief-dialog": dialog, ".dialog-intro": intro, "#brief-form": form, "#brief-copy": copyButton,
    "#contact [data-open-brief]": general,
  };
  const { search, hash } = new URL(url);
  const location = { search, hash, href: "" };
  let copied;
  script.runInNewContext({
    document: {
      querySelector: selector => elements[selector] ?? null,
      querySelectorAll: selector => selector === "[data-open-brief]" ? [general, training] : [],
    },
    window: { matchMedia: () => ({matches: false}), location },
    navigator: { clipboard: { async writeText(text) { copied = text; } } },
    URLSearchParams, requestAnimationFrame: callback => callback(),
  });
  return {
    name, contact, task, topic, dialog, intro,
    open: button => ({general, training})[button].fire("click"),
    typeTask(value) { task.value = value; form.fire("input", task); },
    selectTopic(value) { topic.value = value; form.fire("change", topic); },
    send() {
      location.href = "";
      form.fire("submit");
      return location.href ? new URL(location.href).searchParams : null;
    },
    async copy() { copied = null; await copyButton.fire("click"); return copied; },
  };
}

test("an explicit Krippi demo needs only a name and contact and keeps its purpose in both delivery methods", async () => {
  const promo = readFileSync(new URL("../showcase/krippi.html", import.meta.url), "utf8");
  const links = [...promo.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>(?:Запросить|Обсудить) демонстрацию<\/a>/g)];
  assert.equal(links.length, 2);
  for (const [,url] of links) {
    const h = brief(new URL(url, "https://example.test"));
    assert.equal(h.dialog.open, true);
    assert.equal(h.topic.value, "krippi");
    assert.equal(h.task.value, demoRequest);
    assert.match(h.intro.textContent, /показа Криппи.*по желанию/);
    assert.equal(h.task.required, false);
    assert.equal(h.task.minLength, 0);
    assert.equal(await h.copy(), null);
    h.name.value = "Ира";
    h.contact.value = "ira@example.test";
    for (const details of [demoRequest, "", "CRM", demoRequest + " в CRM"]) {
      h.typeTask(details);
      const email = h.send();
      assert.equal(email.get("subject"), "Запрос на демонстрацию Криппи");
      const body = email.get("body");
      assert.equal(body.split(demoRequest).length - 1, 1);
      assert.ok(body.includes(details));
      assert.match(body, /ira@example\.test/);
      const copied = await h.copy();
      assert.ok(copied.endsWith(body));
    }
  }
});

test("a general brief resets an empty preset and restores normal validation while retaining typed drafts", async () => {
  const h = brief("https://example.test/vitrina?topic=krippi#contact");
  h.name.value = "Олег";
  h.contact.value = "oleg@example.test";
  h.open("general");
  assert.equal(h.topic.value, "other");
  assert.equal(h.intro.textContent, "Обсудим вашу задачу.");
  assert.equal(h.task.value, "");
  assert.equal(h.task.required, true);
  assert.equal(h.task.minLength, 10);
  assert.equal(h.name.value, "Олег");
  assert.equal(h.contact.value, "oleg@example.test");
  h.open("training");
  assert.equal(h.topic.value, "training");
  h.open("general");
  assert.equal(h.topic.value, "other");
  h.selectTopic("krippi");
  h.typeTask("CRM");
  assert.equal(await h.copy(), null);
  h.typeTask("Нужно обсудить интеграцию CRM");
  h.open("training");
  h.open("general");
  assert.equal(h.task.value, "Нужно обсудить интеграцию CRM");
  assert.equal(h.topic.value, "training");
  const editing = brief("https://example.test/vitrina?topic=krippi#contact");
  editing.name.value = h.name.value;
  editing.contact.value = h.contact.value;
  editing.typeTask(h.task.value);
  editing.selectTopic("other");
  assert.equal(editing.intro.textContent, "Обсудим вашу задачу.");
  editing.selectTopic("krippi");
  const message = await editing.copy();
  assert.match(message, /Запрос на автоматизацию/);
  assert.ok(!message.includes(demoRequest));
  assert.match(message, /Нужно обсудить интеграцию CRM/);
});
