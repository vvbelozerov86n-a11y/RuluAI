"use client";

import {useEffect, useLayoutEffect, useRef, useState} from "react";
import type {ChatMessage} from "@/lib/ruli/collaboration";

type ReadingPosition = {
  atBottom: boolean;
  scrollTop: number;
  scrollHeight: number;
  anchorId?: string;
  anchorOffset?: number;
};

function messageTime(value: string): string {
  const date = new Date(value.endsWith("Z") || /[+-]\d\d:\d\d$/.test(value)
    ? value
    : value.replace(" ", "T") + "Z");
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Barnaul",
  }).format(date);
}

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return ["id", "taskId", "authorId", "authorName", "body", "createdAt"].every(key => typeof item[key] === "string")
    && (item.channelMemberId === null || typeof item.channelMemberId === "string");
}

export function MessageFeed({
  taskId,
  channelMemberId,
  viewerMemberId,
  initialMessages,
}: {
  taskId: string;
  channelMemberId?: string;
  viewerMemberId: string;
  initialMessages: ChatMessage[];
}) {
  const [messages, setMessages] = useState(() => initialMessages.slice(-100));
  const [networkError, setNetworkError] = useState("");
  const listRef = useRef<HTMLOListElement>(null);
  const messagesRef = useRef(messages);
  const readingRef = useRef<ReadingPosition | null>(null);
  const firstPaintRef = useRef(true);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (firstPaintRef.current) {
      list.scrollTop = list.scrollHeight;
      firstPaintRef.current = false;
      return;
    }
    const previous = readingRef.current;
    if (!previous) return;
    if (previous.atBottom) {
      list.scrollTop = list.scrollHeight;
    } else {
      const anchor = Array.from(list.children).find(
        item => (item as HTMLElement).dataset.messageId === previous.anchorId,
      );
      if (anchor && previous.anchorOffset !== undefined) {
        list.scrollTop += anchor.getBoundingClientRect().top
          - list.getBoundingClientRect().top - previous.anchorOffset;
      } else {
        list.scrollTop = Math.max(0, previous.scrollTop + list.scrollHeight - previous.scrollHeight);
      }
    }
    readingRef.current = null;
  }, [messages]);

  useEffect(() => {
    let disposed = false;
    let activeController: AbortController | null = null;

    async function refresh() {
      if (document.visibilityState !== "visible" || activeController || disposed) return;
      const controller = new AbortController();
      activeController = controller;
      let timedOut = false;
      const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 8_000);
      try {
        const query = new URLSearchParams({channel: channelMemberId || "general"});
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/messages?${query}`, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
          headers: {Accept: "application/json"},
        });
        if (!response.ok) throw new Error("messages-unavailable");
        const payload: unknown = await response.json();
        const raw = payload && typeof payload === "object" ? (payload as {messages?: unknown}).messages : undefined;
        if (!Array.isArray(raw) || !raw.every(isMessage)) throw new Error("invalid-messages");
        // Reject an unexpected task or channel instead of displaying unrelated messages.
        if (raw.some(message => message.taskId !== taskId
          || message.channelMemberId !== (channelMemberId || null))) throw new Error("wrong-channel");
        const next = raw.slice(-100);
        if (disposed || controller.signal.aborted) return;
        setNetworkError("");
        if (JSON.stringify(next) === JSON.stringify(messagesRef.current)) return;

        const list = listRef.current;
        if (list) {
          const bounds = list.getBoundingClientRect();
          const anchor = Array.from(list.children).find(item => item.getBoundingClientRect().bottom > bounds.top);
          readingRef.current = {
            atBottom: list.scrollHeight - list.scrollTop - list.clientHeight < 40,
            scrollTop: list.scrollTop,
            scrollHeight: list.scrollHeight,
            anchorId: (anchor as HTMLElement | undefined)?.dataset.messageId,
            anchorOffset: anchor ? anchor.getBoundingClientRect().top - bounds.top : undefined,
          };
        }
        messagesRef.current = next;
        setMessages(next);
      } catch {
        if (!disposed && (!controller.signal.aborted || timedOut)) {
          setNetworkError("Не удалось обновить сообщения. Показана предыдущая переписка; попробуем снова автоматически.");
        }
      } finally {
        window.clearTimeout(timeout);
        if (activeController === controller) activeController = null;
      }
    }

    function visibilityChanged() {
      if (document.visibilityState === "visible") void refresh();
      else activeController?.abort();
    }

    const interval = window.setInterval(() => void refresh(), 10_000);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibilityChanged);
      activeController?.abort();
    };
  }, [taskId, channelMemberId]);

  return <div className="message-feed">
    <p className={`feed-status${networkError ? " offline" : ""}`} role="status" aria-live="polite">
      {networkError || "Новые сообщения появляются автоматически."}
    </p>
    <ol ref={listRef} className="message-list" aria-label="Сообщения" aria-live="polite" aria-relevant="additions text" aria-atomic="false">
      {messages.map(message => <li key={message.id} data-message-id={message.id} className={message.authorId === viewerMemberId ? "message mine" : "message"}>
        <div className="message-meta"><strong>{message.authorName}</strong><time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time></div>
        <p>{message.body}</p>
      </li>)}
    </ol>
    {!messages.length ? <p className="empty-copy">Здесь пока нет сообщений. Начните обсуждение задачи.</p> : null}
  </div>;
}

