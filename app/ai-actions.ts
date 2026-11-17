"use server";

import { redirect } from "next/navigation";
import type { ActionState } from "../lib/ruli/action-state";
import { aiErrorMessage, retryAiChat, runTaskAi, saveBot, type AiRunSummary } from "../lib/ruli/ai";

function value(form: FormData, key: string): string {
  const item = form.get(key);
  return typeof item === "string" ? item : "";
}
function failure(form: FormData, error: unknown): ActionState {
  // Authentication redirects remain framework control flow.
  if (error && typeof error === "object" && "digest" in error && String(error.digest).startsWith("NEXT_REDIRECT")) throw error;
  return {
    error: aiErrorMessage(error),
    values: Object.fromEntries([...form.entries()].filter((entry): entry is [string, string] => typeof entry[1] === "string" && !entry[0].startsWith("$ACTION"))),
  };
}
function outcome(run: AiRunSummary): ActionState {
  return {
    aiRunId: run.id, aiStatus: run.status,
    notice: run.error || (run.status === "pending" ? "AI уже выполняет запрос. Обновите страницу немного позже."
      : run.kind === "task" ? "AI подготовил результат и передал его на проверку." : "Ответ AI сохранён в диалоге."),
  };
}

export async function saveBotState(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    await saveBot({
      memberId: value(form, "memberId").trim() || undefined,
      version: Number(value(form, "version")), name: value(form, "name"), role: value(form, "role"),
      provider: value(form, "provider"), model: value(form, "model"), systemPrompt: value(form, "systemPrompt"),
      enabled: form.has("enabled") && !["false", "0", ""].includes(value(form, "enabled")),
    });
  } catch (error) { return failure(form, error); }
  redirect(`/team?flash=${encodeURIComponent("Настройки AI-бота сохранены.")}`);
}

export async function runTaskAiState(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    return outcome(await runTaskAi({
      taskId: value(form, "taskId").trim(), botMemberId: value(form, "botMemberId").trim(),
      version: Number(value(form, "version")), clientId: value(form, "clientId").trim(),
    }));
  } catch (error) { return failure(form, error); }
}

export async function retryAiChatState(_previous: ActionState, form: FormData): Promise<ActionState> {
  try {
    return outcome(await retryAiChat({
      taskId: value(form, "taskId").trim(), botMemberId: value(form, "botMemberId").trim(),
      channelMemberId: value(form, "channelMemberId").trim() || null, clientId: value(form, "clientId").trim(),
      inputMessageId: value(form, "inputMessageId").trim() || undefined, runId: value(form, "runId").trim() || undefined,
    }));
  } catch (error) { return failure(form, error); }
}
