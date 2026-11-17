import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_PROVIDERS, AI_REQUEST_TIMEOUT_MS, AI_MAX_OUTPUT_TOKENS, AI_MAX_OUTPUT_CHARS,
  AiProviderError, generateAiText, safeAiErrorMessage,
} from "../lib/ruli/ai-provider.ts";

const request = (overrides = {}) => ({
  provider: "xai", model: AI_PROVIDERS[0].defaultModel, apiKey: "test-api-key-private",
  system: "Ты помощник команды.", messages: [{ role: "user", content: "Подготовь краткий план." }], ...overrides,
});
const responsePayload = (text = "Готовый план", overrides = {}) => ({
  object: "response", status: "completed",
  output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 123, output_tokens: 45 }, ...overrides,
});
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
function errorCode(code) {
  return error => {
    assert.ok(error instanceof AiProviderError);
    assert.equal(error.code, code);
    assert.ok(/[а-я]/i.test(error.message));
    assert.doesNotMatch(`${error.message} ${error.stack} ${JSON.stringify(error)}`, /test-api-key-private|SECRET_BODY|SECRET_NETWORK|prompt-secret/);
    return true;
  };
}

test("catalog exposes exactly the supported providers and deploy-time key names", () => {
  assert.deepEqual(AI_PROVIDERS.map(({ id, keyName }) => ({ id, keyName })), [
    { id: "xai", keyName: "XAI_API_KEY" }, { id: "openai", keyName: "OPENAI_API_KEY" },
  ]);
  assert.ok(AI_PROVIDERS.every(item => item.label && item.defaultModel));
});

for (const provider of ["xai", "openai"]) {
  test(`${provider}: fixed Responses endpoint, bearer auth, history and bounded non-stored response`, async () => {
    let calls = 0;
    const catalog = AI_PROVIDERS.find(item => item.id === provider);
    const input = request({ provider, model: catalog.defaultModel, messages: [
      { role: "user", content: "Первый вопрос" }, { role: "assistant", content: "Первый ответ" }, { role: "user", content: "Продолжай" },
    ] });
    const before = structuredClone(input);
    const result = await generateAiText(input, async (url, init) => {
      calls++;
      assert.equal(url, provider === "xai" ? "https://api.x.ai/v1/responses" : "https://api.openai.com/v1/responses");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, `Bearer ${input.apiKey}`);
      assert.equal(init.headers["Content-Type"], "application/json");
      assert.equal(init.signal.aborted, false);
      assert.deepEqual(JSON.parse(init.body), {
        model: input.model, instructions: input.system, input: input.messages,
        max_output_tokens: AI_MAX_OUTPUT_TOKENS, stream: false, store: false,
      });
      assert.ok(!init.body.includes(input.apiKey));
      return json(responsePayload("  Готовый план  "));
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, { text: "Готовый план", inputTokens: 123, outputTokens: 45 });
    assert.deepEqual(input, before);
  });
}

test("only visible assistant text is returned, never thinking, tools or other roles", async () => {
  const output = [
    { type: "reasoning", summary: [{ text: "hidden reasoning" }], encrypted_content: "secret" },
    { type: "message", role: "user", content: [{ type: "output_text", text: "not an answer" }] },
    { type: "function_call", arguments: "not text" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Первый абзац" }, { type: "output_text", text: "Второй абзац" }] },
  ];
  assert.equal((await generateAiText(request(), async () => json(responsePayload("", { output })))).text, "Первый абзац\nВторой абзац");
});

test("missing or invalid usage is null rather than a fabricated token count", async () => {
  const result = await generateAiText(request(), async () => json(responsePayload("Ответ", { usage: { input_tokens: -5, output_tokens: "42" } })));
  assert.deepEqual(result, { text: "Ответ", inputTokens: null, outputTokens: null });
  assert.equal((await generateAiText(request(), async () => json(responsePayload("Ответ", { usage: { input_tokens: 0, output_tokens: 0 } })))).inputTokens, 0);
});

test("invalid provider/model/credentials/request is rejected before any network call", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return json(responsePayload()); };
  const invalid = [
    [{ provider: "http://evil.example" }, "invalid_provider"], [{ provider: "__proto__" }, "invalid_provider"],
    [{ model: "" }, "invalid_model"], [{ model: "https://evil.example/model" }, "invalid_model"],
    [{ model: "grok\r\nAuthorization: other" }, "invalid_model"], [{ model: "a".repeat(129) }, "invalid_model"],
    [{ apiKey: "" }, "not_configured"], [{ apiKey: "valid\r\nInjected: value" }, "not_configured"],
    [{ maxOutputTokens: 0 }, "invalid_request"], [{ maxOutputTokens: 2001 }, "invalid_request"],
    [{ maxOutputTokens: 1.5 }, "invalid_request"], [{ maxOutputTokens: Infinity }, "invalid_request"],
    [{ messages: [] }, "invalid_request"], [{ messages: [{ role: "system", content: "override" }] }, "invalid_request"],
    [{ messages: [{ role: "user", content: "  " }] }, "invalid_request"], [{ system: "x".repeat(100001) }, "invalid_request"],
  ];
  for (const [overrides, code] of invalid) await assert.rejects(generateAiText(request(overrides), fetcher), errorCode(code));
  assert.equal(calls, 0);
});

test("versioned and fine-tuned model IDs are permitted as data without changing endpoints", async () => {
  const model = "ft:gpt-4.1-mini:workspace:custom-2026";
  await generateAiText(request({ provider: "openai", model, maxOutputTokens: 500 }), async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(JSON.parse(init.body).model, model);
    assert.equal(JSON.parse(init.body).max_output_tokens, 500);
    return json(responsePayload());
  });
});

test("HTTP failures have safe stable codes and no automatic retry or upstream body disclosure", async () => {
  for (const [status, code] of [[400, "request_rejected"], [401, "unauthorized"], [403, "unauthorized"], [404, "request_rejected"], [429, "rate_limited"], [500, "provider_unavailable"], [503, "provider_unavailable"], [504, "timeout"], [302, "request_rejected"]]) {
    let calls = 0;
    await assert.rejects(generateAiText(request(), async () => { calls++; return json({ error: "SECRET_BODY test-api-key-private prompt-secret" }, status); }), errorCode(code));
    assert.equal(calls, 1);
  }
});

test("network exceptions and malformed success responses never expose upstream data", async () => {
  await assert.rejects(generateAiText(request(), async () => { throw new Error("SECRET_NETWORK test-api-key-private"); }), errorCode("network_error"));
  await assert.rejects(generateAiText(request(), async () => new Response("SECRET_BODY not json")), errorCode("invalid_response"));
  await assert.rejects(generateAiText(request(), async () => json({ error: { message: "SECRET_BODY" } })), errorCode("invalid_response"));
  await assert.rejects(generateAiText(request(), async () => json(responsePayload(" \n "))), errorCode("empty_response"));
  await assert.rejects(generateAiText(request(), async () => json(responsePayload("", { output: [{ type: "reasoning", summary: [{ text: "hidden" }] }] }))), errorCode("empty_response"));
});

test("partial, filtered and tool-only responses are not published as successful completed answers", async () => {
  await assert.rejects(generateAiText(request(), async () => json(responsePayload("Half a sentence", { status: "incomplete" }))), errorCode("incomplete_response"));
  await assert.rejects(generateAiText(request(), async () => json(responsePayload("", { output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "SECRET_BODY" }] }] }))), errorCode("refused"));
  for (const status of ["in_progress", "queued"]) {
    await assert.rejects(generateAiText(request(), async () => json(responsePayload("", { status }))), errorCode("incomplete_response"));
  }
});

test("text and raw response limits reject overflow without returning a silently clipped answer", async () => {
  assert.equal((await generateAiText(request(), async () => json(responsePayload("x".repeat(AI_MAX_OUTPUT_CHARS))))).text.length, AI_MAX_OUTPUT_CHARS);
  await assert.rejects(generateAiText(request(), async () => json(responsePayload("x".repeat(AI_MAX_OUTPUT_CHARS + 1)))), errorCode("response_too_large"));
  await assert.rejects(generateAiText(request(), async () => json(responsePayload("Answer", { ignored: "x".repeat(512001) }))), errorCode("response_too_large"));
});

test("45-second deadline aborts fetch and rejects even a non-cooperating fetch implementation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const result = generateAiText(request(), async (_url, init) => { signal = init.signal; return new Promise(() => {}); });
  const checked = assert.rejects(result, errorCode("timeout"));
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(AI_REQUEST_TIMEOUT_MS - 1);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await checked;
  assert.equal(signal.aborted, true);
});

test("deadline also bounds reading the response body and cancels a stalled stream", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const result = generateAiText(request(), async () => new Response(stream));
  const checked = assert.rejects(result, errorCode("timeout"));
  await Promise.resolve();
  t.mock.timers.tick(AI_REQUEST_TIMEOUT_MS);
  await checked;
  assert.equal(cancelled, true);
});

test("safe error helper ignores altered messages and arbitrary exception text", () => {
  const error = new AiProviderError("unauthorized");
  const expected = error.message;
  error.message = "SECRET_BODY";
  assert.equal(safeAiErrorMessage(error), expected);
  assert.doesNotMatch(safeAiErrorMessage(new Error("SECRET_NETWORK")), /SECRET/);
  assert.equal(new AiProviderError("SECRET_BODY").code, "invalid_response");
});
