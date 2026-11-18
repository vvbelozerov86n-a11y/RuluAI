import type { AiRunSummary } from "./ai";
import type { ChatAiRun } from "./collaboration";

/** Call only after loading runs for the viewer's authorized current channel. */
export function projectChatAiRuns(runs: AiRunSummary[], taskId: string, channelMemberId: string | null, messageIds?: string[]): ChatAiRun[] {
  const pageIds=messageIds?new Set(messageIds):null;
  return runs.filter(run => run.kind === "chat" && run.taskId === taskId && run.channelMemberId === channelMemberId
    && (!pageIds || Boolean(run.inputMessageId&&pageIds.has(run.inputMessageId)))).map(run => ({
    id: run.id, botMemberId: run.botMemberId, channelMemberId: run.channelMemberId, inputMessageId: run.inputMessageId,
    error: run.error, status: run.status, canRetry: run.canRetry, createdAt: run.createdAt, finishedAt: run.finishedAt,
    output: run.status === "stale" ? run.output ?? null : null,
  }));
}
