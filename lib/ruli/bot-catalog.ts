export const GROK_BOT_PROVIDER = {
  id: "grok-bot",
  label: "Grok Bot (агент)",
  keyName: "GROK_BOT_WEBHOOK_URL",
  defaultModel: "",
  suggestedModels: [] as readonly string[],
  kind: "agent",
} as const;

export const GROK_BOT_SLUG_HINTS = [
  "pinterest", "vk", "dzen", "telegram", "video", "reviews",
  "review-replies", "site-seo", "game-tester", "animation", "grok-bot",
] as const;

export function isLlmProvider(id: string): id is "xai" | "openai" {
  return id === "xai" || id === "openai";
}

export function isGrokBotProvider(id: string): id is "grok-bot" {
  return id === "grok-bot";
}

/** slug: 1–64 символа, латиница, цифры и дефис, без ведущего/концевого дефиса. */
export function isBotSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);
}
