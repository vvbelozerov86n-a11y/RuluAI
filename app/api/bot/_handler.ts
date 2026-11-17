import { env } from "cloudflare:workers";
import { getD1 } from "../../../db";
import { notifyMessageForAgents } from "../../../lib/ruli/agent-runtime";
import { botApiDepsFromEnv, handleBotApi } from "../../../lib/ruli/bot-api";

export const dynamic = "force-dynamic";

export function handleIncomingBotRequest(request: Request): Promise<Response> {
  const db = getD1();
  return handleBotApi(request, botApiDepsFromEnv(db, env, {
    onMessage: (task, message) => notifyMessageForAgents(db, task, message),
  }));
}
