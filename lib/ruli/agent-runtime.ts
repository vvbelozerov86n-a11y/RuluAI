import { env, waitUntil } from "cloudflare:workers";
import { getCurrentWorkspaceId } from "../../db";
import { getCompanyIntegrations, type CompanyIntegrations } from "./company-integrations";
import {
  loadTaskOutbox,
  notifyGrokBotMessage,
  notifyGrokBotTaskChange,
  retryOutboxEvent,
  type AgentWebhookDependencies,
  type MessageSnapshot,
  type OutboxRow,
  type TaskSnapshot,
} from "./agent-webhook";

async function currentIntegrations() {
  return getCompanyIntegrations(env, await getCurrentWorkspaceId());
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

function agentWebhookDeps(db: D1Database, source: CompanyIntegrations): AgentWebhookDependencies {
  return {
    db,
    config: {
      url: source.GROK_BOT_WEBHOOK_URL,
      key: source.GROK_BOT_WEBHOOK_KEY,
      header: source.GROK_BOT_WEBHOOK_HEADER,
      baseUrl: source.RULI_BASE_URL,
    },
    schedule: scheduleBackground,
  };
}

export async function notifyTaskChangeForAgents(db: D1Database, previous: TaskSnapshot | null, next: TaskSnapshot): Promise<void> {
  try {
    await notifyGrokBotTaskChange(agentWebhookDeps(db, await currentIntegrations()), previous, next);
  } catch {
    // Ошибка доставки не должна ломать сохранение задачи.
  }
}

export async function notifyMessageForAgents(db: D1Database, task: TaskSnapshot, message: MessageSnapshot, source?: CompanyIntegrations): Promise<void> {
  try {
    await notifyGrokBotMessage(agentWebhookDeps(db, source ?? await currentIntegrations()), task, message);
  } catch {
    // Ошибка доставки не должна ломать сохранение сообщения.
  }
}

export async function listTaskDeliveries(db: D1Database, taskId: string): Promise<OutboxRow[]> {
  return loadTaskOutbox(db, taskId);
}

export async function retryAgentDelivery(db: D1Database, eventId: string, expectedTaskId?: string): Promise<OutboxRow | null> {
  return retryOutboxEvent(agentWebhookDeps(db, await currentIntegrations()), eventId, expectedTaskId);
}
