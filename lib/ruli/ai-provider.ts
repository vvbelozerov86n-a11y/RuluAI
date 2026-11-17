/** Server-side HTTP adapter with no runtime/framework imports.
 * Official API contracts checked 2026-11-17:
 * https://docs.x.ai/developers/rest-api-reference/inference/responses
 * https://developers.openai.com/api/reference/resources/responses/methods/create
 */
export type AiProvider = "xai" | "openai";

export const AI_PROVIDERS = [
  { id: "xai", label: "xAI · Grok", keyName: "XAI_API_KEY", defaultModel: "grok-4.7" },
  { id: "openai", label: "OpenAI", keyName: "OPENAI_API_KEY", defaultModel: "gpt-6-luna" },
] as const;

export type AiTextRequest = {
  provider: AiProvider;
  model: string;
  apiKey: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxOutputTokens?: number;
};
export type AiTextResponse = { text: string; inputTokens: number | null; outputTokens: number | null };

export const AI_REQUEST_TIMEOUT_MS = 45_000;
export const AI_MAX_OUTPUT_TOKENS = 2000;
export const AI_MAX_OUTPUT_CHARS = 12_000;
const MAX_RESPONSE_BYTES = 512_000;
const MAX_INPUT_CHARS = 100_000;
const ENDPOINTS: Readonly<Record<AiProvider, string>> = Object.freeze({
  xai: "https://api.x.ai/v1/responses",
  openai: "https://api.openai.com/v1/responses",
});
const ERROR_MESSAGES = Object.freeze({
  invalid_provider: "Выберите поддерживаемого AI-провайдера.",
  invalid_model: "Укажите корректный идентификатор AI-модели.",
  not_configured: "Ключ AI-провайдера не настроен или имеет неверный формат. Обратитесь к руководителю.",
  invalid_request: "Не удалось подготовить запрос к AI. Проверьте сообщение и настройки.",
  unauthorized: "AI-провайдер отклонил ключ или доступ. Проверьте настройки подключения.",
  rate_limited: "AI-провайдер ограничил запросы. Проверьте доступный лимит и повторите позже.",
  provider_unavailable: "AI-провайдер временно недоступен. Повторите позже.",
  request_rejected: "AI-провайдер отклонил запрос. Проверьте модель и настройки подключения.",
  timeout: "AI не ответил за 45 секунд. Попробуйте повторить запрос.",
  network_error: "Не удалось связаться с AI-провайдером. Попробуйте позже.",
  invalid_response: "AI-провайдер вернул некорректный ответ. Попробуйте позже.",
  empty_response: "AI не вернул текст ответа. Уточните запрос и повторите.",
  incomplete_response: "AI не завершил ответ в установленном лимите. Сократите запрос и повторите.",
  response_too_large: "Ответ AI превышает допустимый размер. Попросите более короткий ответ.",
  refused: "AI-провайдер не смог выполнить этот запрос. Переформулируйте сообщение.",
});
export type AiProviderErrorCode = keyof typeof ERROR_MESSAGES;

function knownCode(code: unknown): AiProviderErrorCode {
  return typeof code === "string" && Object.hasOwn(ERROR_MESSAGES, code) ? code as AiProviderErrorCode : "invalid_response";
}

/** Never attaches the upstream exception, body, prompt or credentials. */
export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode;
  constructor(code: AiProviderErrorCode) {
    const safeCode = knownCode(code);
    super(ERROR_MESSAGES[safeCode]);
    this.name = "AiProviderError";
    this.code = safeCode;
  }
}

export function safeAiErrorMessage(error: unknown): string {
  return ERROR_MESSAGES[error instanceof AiProviderError ? knownCode(error.code) : "invalid_response"];
}

function validate(input: AiTextRequest): { model: string; apiKey: string; maxOutputTokens: number } {
  if (!input || !Object.hasOwn(ENDPOINTS, input.provider)) throw new AiProviderError("invalid_provider");
  const model = typeof input.model === "string" ? input.model.trim() : "";
  // A model ID is data, never an endpoint. Allow versioned and fine-tuned IDs.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model)) throw new AiProviderError("invalid_model");
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (!apiKey || apiKey.length > 4096 || /[^\x21-\x7e]/.test(apiKey)) throw new AiProviderError("not_configured");
  const maxOutputTokens = input.maxOutputTokens ?? AI_MAX_OUTPUT_TOKENS;
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > AI_MAX_OUTPUT_TOKENS) {
    throw new AiProviderError("invalid_request");
  }
  if (typeof input.system !== "string" || !Array.isArray(input.messages) || !input.messages.length || input.messages.length > 200) {
    throw new AiProviderError("invalid_request");
  }
  let length = input.system.length;
  for (const message of input.messages) {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || !message.content.trim()) {
      throw new AiProviderError("invalid_request");
    }
    length += message.content.length;
  }
  if (length > MAX_INPUT_CHARS) throw new AiProviderError("invalid_request");
  return { model, apiKey, maxOutputTokens };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function tokens(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new AiProviderError("invalid_response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0, json = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        cancel();
        throw new AiProviderError("response_too_large");
      }
      json += decoder.decode(chunk.value, { stream: true });
    }
    json += decoder.decode();
    try { return JSON.parse(json); }
    catch { throw new AiProviderError("invalid_response"); }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function parseResponse(payload: unknown): AiTextResponse {
  const data = record(payload);
  if (!data || data.error) throw new AiProviderError("invalid_response");
  const parts: string[] = [];
  if (data.status === "incomplete" || data.status === "in_progress" || data.status === "queued") throw new AiProviderError("incomplete_response");
  if (data.status !== "completed" || !Array.isArray(data.output)) throw new AiProviderError("invalid_response");
  for (const value of data.output) {
    const message = record(value);
    if (message?.type !== "message" || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const value of message.content) {
      const block = record(value);
      if (block?.type === "refusal") throw new AiProviderError("refused");
      if (block?.type === "output_text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  const text = parts.join("\n").trim();
  if (!text) throw new AiProviderError("empty_response");
  if (text.length > AI_MAX_OUTPUT_CHARS) throw new AiProviderError("response_too_large");
  const usage = record(data.usage);
  return { text, inputTokens: tokens(usage?.input_tokens), outputTokens: tokens(usage?.output_tokens) };
}

/** One bounded call, without automatic retries or provider conversation storage. */
export async function generateAiText(input: AiTextRequest, fetcher: typeof fetch = fetch): Promise<AiTextResponse> {
  const { model, apiKey, maxOutputTokens } = validate(input);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiProviderError("timeout"));
    }, AI_REQUEST_TIMEOUT_MS);
  });
  const execute = async () => {
    const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
    const messages = input.messages.map(({ role, content }) => ({ role, content }));
    const body = { model, instructions: input.system, input: messages, max_output_tokens: maxOutputTokens, stream: false, store: false };
    const response = await fetcher(ENDPOINTS[input.provider], {
      method: "POST", headers, body: JSON.stringify(body), signal: controller.signal, redirect: "error",
    });
    if (!response.ok) {
      // Do not read upstream error bodies: they may echo credentials or prompts.
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) throw new AiProviderError("unauthorized");
      if (response.status === 429) throw new AiProviderError("rate_limited");
      if (response.status === 408 || response.status === 504) throw new AiProviderError("timeout");
      if (response.status >= 500) throw new AiProviderError("provider_unavailable");
      throw new AiProviderError("request_rejected");
    }
    return parseResponse(await responseJson(response, controller.signal));
  };
  try { return await Promise.race([execute(), deadline]); }
  catch (error) {
    if (controller.signal.aborted) throw new AiProviderError("timeout");
    if (error instanceof AiProviderError) throw new AiProviderError(error.code);
    throw new AiProviderError("network_error");
  } finally { clearTimeout(timer); }
}
