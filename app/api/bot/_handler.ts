import { env } from "cloudflare:workers";
import { getSystemD1 } from "../../../db";
import { workspaceDatabase } from "../../../db/workspace-storage";
import { notifyMessageForAgents } from "../../../lib/ruli/agent-runtime";
import { botApiDepsFromEnv, handleBotApi, readBearerToken, timingSafeEqualText } from "../../../lib/ruli/bot-api";
import { configuredBotIntegrations } from "../../../lib/ruli/company-integrations";

export const dynamic = "force-dynamic";

export async function handleIncomingBotRequest(request: Request): Promise<Response> {
  const provided = readBearerToken(request);
  const matches = provided ? [...configuredBotIntegrations(env)].filter(([, config]) =>
    timingSafeEqualText(provided, config.RULI_BOT_API_TOKEN ?? "")) : [];
  if (matches.length !== 1) {
    return Response.json({ error: "Нужен действительный токен бота." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const [workspaceId, config] = matches[0];
  const raw = getSystemD1();
  if (workspaceId !== "legacy" && !await raw.prepare("SELECT id FROM workspaces WHERE id=?").bind(workspaceId).first()) {
    return Response.json({ error: "Компания бота не найдена." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  const db = workspaceDatabase(raw, workspaceId);
  return handleBotApi(request, botApiDepsFromEnv(db, config, {
    onMessage: (task, message) => notifyMessageForAgents(db, task, message, config),
  }));
}
