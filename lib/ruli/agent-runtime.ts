import { env, waitUntil } from "cloudflare:workers";
import {
  loadTaskOutbox,
  notifyGrokBotMessage,
  notifyGrokBotTaskChange,
  retryOutboxEvent,
  type AgentWebhookDependencies,
  type MessageSnapshot,
  type OutboxRow,
  type TaskSnapshot,
  type WebhookConfig,
} from "./agent-webhook";

type WorkerEnv = {
  DB?: D1Database;
  GROK_BOT_WEBHOOK_URL?: string;
  GROK_BOT_WEBHOOK_KEY?: string;
  GROK_BOT_WEBHOOK_HEADER?: string;
  RULI_BASE_URL?: string;
  RULI_BOT_API_TOKEN?: string;
};

function envBindings(): WorkerEnv {
  return env as unknown as WorkerEnv;
}

export function agentWebhookConfig(source: WorkerEnv = envBindings()): WebhookConfig {
  return {
    url: source.GROK_BOT_WEBHOOK_URL,
    key: source.GROK_BOT_WEBHOOK_KEY,
    header: source.GROK_BOT_WEBHOOK_HEADER,
    baseUrl: source.RULI_BASE_URL,
  };
}

export function agentWebhookConfigured(source: WorkerEnv = envBindings()): boolean {
  return Boolean(source.GROK_BOT_WEBHOOK_URL?.trim());
}

export function botApiToken(source: WorkerEnv = envBindings()): string | undefined {
  return source.RULI_BOT_API_TOKEN;
}

export function appBaseUrl(source: WorkerEnv = envBindings()): string | undefined {
  return source.RULI_BASE_URL;
}

function scheduleBackground(work: Promise<unknown>): void {
  try {
    if (typeof waitUntil === "function") {
      waitUntil(work);
      return;
    }
  } catch {
    // среда без waitUntil (тесты): не блокируем сохранение задачи
  }
  void work;
}

export function agentWebhookDeps(db: D1Database, extra: Partial<AgentWebhookDependencies> = {}): AgentWebhookDependencies {
  return {
    db,
    config: agentWebhookConfig(),
    schedule: scheduleBackground,
    ...extra,
  };
}

export async function notifyTaskChangeForAgents(db: D1Database, previous: TaskSnapshot | null, next: TaskSnapshot): Promise<void> {
  try {
    await notifyGrokBotTaskChange(agentWebhookDeps(db), previous, next);
  } catch {
    // Ошибка доставки не должна ломать сохранение задачи.
  }
}

export async function notifyMessageForAgents(db: D1Database, task: TaskSnapshot, message: MessageSnapshot): Promise<void> {
  try {
    await notifyGrokBotMessage(agentWebhookDeps(db), task, message);
  } catch {
    // Ошибка доставки не должна ломать сохранение сообщения.
  }
}

export async function listTaskDeliveries(db: D1Database, taskId: string): Promise<OutboxRow[]> {
  return loadTaskOutbox(db, taskId);
}

export async function retryAgentDelivery(db: D1Database, eventId: string, expectedTaskId?: string): Promise<OutboxRow | null> {
  return retryOutboxEvent(agentWebhookDeps(db), eventId, expectedTaskId);
}
