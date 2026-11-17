import { retryBotWebhook } from "@/app/actions";
import type { OutboxRow } from "@/lib/ruli/agent-webhook";
import type { ViewMode } from "@/lib/ruli/model";
import { SubmitButton } from "./submit-button";

const LABELS: Record<OutboxRow["status"], string> = {
  delivered: "Передано боту",
  pending: "Передаём боту…",
  failed: "Не доставлено боту",
};

export function BotDeliveryStatus({ rows, manager, taskId, version, mode }: {
  rows: OutboxRow[]; manager: boolean; taskId: string; version: number; mode: ViewMode;
}) {
  if (!rows.length) return null;
  const latest = rows[0];
  return <div className="bot-delivery" role="status">
    <p className="detail-note">{LABELS[latest.status]}{latest.botSlug ? ` · ${latest.botSlug}` : ""}{latest.status === "failed" && latest.lastError ? ` · ${latest.lastError}` : ""}</p>
    {manager && latest.status === "failed" ? <form action={retryBotWebhook} className="bot-delivery-retry">
      <input type="hidden" name="id" value={taskId}/>
      <input type="hidden" name="version" value={version}/>
      <input type="hidden" name="eventId" value={latest.id}/>
      <input type="hidden" name="mode" value={mode}/>
      <SubmitButton className="secondary">Повторить</SubmitButton>
    </form> : null}
  </div>;
}
