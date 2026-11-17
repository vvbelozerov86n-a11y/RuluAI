import { retryBotWebhook } from "@/app/actions";
import type { OutboxRow } from "@/lib/ruli/agent-webhook";
import { taskHref, type ViewMode } from "@/lib/ruli/model";
import { SubmitButton } from "./submit-button";

const LABELS: Record<OutboxRow["status"], string> = {
  delivered: "Передано боту",
  pending: "Передаём боту…",
  failed: "Не доставлено боту",
};

const EVENTS: Record<OutboxRow["event"], string> = {
  "task.assigned": "Поручение",
  "task.updated": "Изменение задачи",
  "message.created": "Сообщение",
  "bot.mentioned": "Упоминание",
};

// Only delivery metadata may reach the page; payloads can contain private chat text.
export type DeliverySummary = Pick<OutboxRow, "id" | "event" | "status" | "botSlug" | "lastError" | "createdAt">;
export function deliverySummaries(rows: OutboxRow[]): DeliverySummary[] {
  return rows.map(({ id, event, status, botSlug, lastError, createdAt }) => ({ id, event, status, botSlug, lastError, createdAt }));
}

function eventTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short", timeStyle: "short", timeZone: "Asia/Barnaul",
  }).format(date);
}

export function BotDeliveryStatus({ rows, manager, taskId, version, mode }: {
  rows: DeliverySummary[]; manager: boolean; taskId: string; version: number; mode: ViewMode;
}) {
  if (!manager || !rows.length) return null;
  const unresolved = rows.filter(row => row.status !== "delivered");
  const latestSuccess = rows.find(row => row.status === "delivered");
  return <section className="bot-delivery" aria-label="Доставка внешним агентам">
    <h3>Доставка внешним агентам</h3>
    {unresolved.length ? <ul>{unresolved.map(row => {
      const time = eventTime(row.createdAt);
      return <li key={row.id} className={`bot-delivery-event ${row.status}`}>
        <div><p className="detail-note"><strong>{LABELS[row.status]}</strong>{row.botSlug ? ` · ${row.botSlug}` : ""}</p>
          <p className="bot-delivery-meta">{EVENTS[row.event]}{time ? <> · <time dateTime={row.createdAt}>{time}</time></> : null}</p>
          {row.status === "failed" && row.lastError ? <p className="bot-delivery-error">{row.lastError}</p> : null}
        </div>
        {row.status === "failed" ? <form action={retryBotWebhook} className="bot-delivery-retry" aria-label={`Повторить доставку: ${row.botSlug}, ${EVENTS[row.event]}${time ? `, ${time}` : ""}`}>
          <input type="hidden" name="id" value={taskId}/>
          <input type="hidden" name="version" value={version}/>
          <input type="hidden" name="eventId" value={row.id}/>
          <input type="hidden" name="mode" value={mode}/>
          <SubmitButton className="secondary" pendingLabel="Повторяем…">Повторить</SubmitButton>
        </form> : null}
      </li>;
    })}</ul> : null}
    {latestSuccess ? <p className="detail-note">Последняя успешная доставка: {latestSuccess.botSlug} · {EVENTS[latestSuccess.event]}{eventTime(latestSuccess.createdAt) ? ` · ${eventTime(latestSuccess.createdAt)}` : ""}.</p> : null}
    {unresolved.some(row => row.status === "pending") ? <p className="detail-note">Доставка продолжается в фоне. <a href={taskHref(taskId, mode)}>Обновить статус доставки</a></p> : null}
  </section>;
}
