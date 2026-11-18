"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, Bot, Check, Copy, History, LoaderCircle, Quote, RefreshCw, Search, User, X } from "lucide-react";
import type { ChatAiRun, ChatMessage, MessagePageInfo } from "@/lib/ruli/collaboration";
import type { Member } from "@/lib/ruli/model";
import { taskPagePath } from "@/lib/ruli/return-path";
import { AiChatRetry } from "./ai-task";
import { MessageContent } from "./message-content";
import {
  advanceHistory, channelKey, createHistoryProgress, feedIssueForStatus, historyPageInfo, mergeMessages, messageDate, messageDayKey, messageDayLabel,
  newIncomingIds, normalizeMessageSearch, parseFeedPayload, searchMessages, shortMessageTime,
  observeHistoryHead,
  type FeedIssue,
} from "./chat-message-utils";

type ReadingPosition = { atBottom: boolean; scrollTop: number; scrollHeight: number; anchorId?: string; anchorOffset?: number };

function MessageItem({ message, member, mine, canWrite, onQuote }: {
  message: ChatMessage; member?: Member; mine: boolean; canWrite: boolean; onQuote: (message: ChatMessage) => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const isBot = member?.type === "bot";
  const initials = member?.initials || message.authorName.trim().split(/\s+/u).slice(0, 2).map(part => Array.from(part)[0]).join("");
  async function copy() {
    try { await navigator.clipboard.writeText(message.body); setCopyStatus("Сообщение скопировано."); }
    catch { setCopyStatus("Не удалось скопировать. Выделите текст и скопируйте вручную."); }
  }
  return <li data-message-id={message.id} className={`message${mine ? " mine" : ""}${isBot ? " is-ai" : ""}`}>
    <span className={`message-avatar ${isBot ? "bot" : "human"}`} aria-hidden="true">{isBot ? <Bot/> : initials || <User/>}</span>
    <div className="message-main">
      <div className="message-meta"><strong>{mine ? "Вы" : message.authorName}</strong>
        {isBot ? <span className="message-author-type">Бот</span> : null}
        <time dateTime={messageDate(message.createdAt)?.toISOString() || message.createdAt} title={messageDate(message.createdAt)?.toLocaleString("ru-RU", { timeZone: "Asia/Barnaul" })}>{shortMessageTime(message.createdAt)}</time>
      </div>
      <MessageContent body={message.body}/>
      <div className="message-actions">
        <button type="button" className="message-action" onClick={copy} aria-label={`Скопировать сообщение от ${message.authorName}`}>
          {copyStatus === "Сообщение скопировано." ? <Check aria-hidden="true"/> : <Copy aria-hidden="true"/>}<span>Копировать</span>
        </button>
        {canWrite ? <button type="button" className="message-action" onClick={() => onQuote(message)} aria-label={`Цитировать сообщение от ${message.authorName}`}><Quote aria-hidden="true"/><span>Цитировать</span></button> : null}
      </div>
      <span className="message-copy-status" role="status">{copyStatus}</span>
    </div>
  </li>;
}

export function MessageFeed({ taskId, channelMemberId, viewerMemberId, initialMessages, members = [], canWrite = false,
  initialPage, initialAiRuns = [] }: {
  taskId: string; channelMemberId?: string; viewerMemberId: string; initialMessages: ChatMessage[];
  members?: Member[]; canWrite?: boolean; initialPage?: MessagePageInfo; initialAiRuns?: ChatAiRun[];
}) {
  const [receivedMessages, setReceivedMessages] = useState(initialMessages);
  const messages = useMemo(() => mergeMessages(initialMessages, receivedMessages, taskId, channelMemberId), [initialMessages, receivedMessages, taskId, channelMemberId]);
  const [query, setQuery] = useState("");
  const normalizedQuery = normalizeMessageSearch(query);
  const shownMessages = useMemo(() => searchMessages(messages, query), [messages, query]);
  const memberMap = useMemo(() => new Map(members.map(member => [member.id, member])), [members]);
  const [historyProgress, setHistoryProgress] = useState(() => createHistoryProgress(initialPage ?? { hasMore: false, beforeCursor: null }));
  const pageInfo = historyPageInfo(historyProgress);
  const pageInitializedRef = useRef(Boolean(initialPage));
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderError, setOlderError] = useState("");
  const [olderStatus, setOlderStatus] = useState("");
  const [issue, setIssue] = useState<FeedIssue | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [newIds, setNewIds] = useState<string[]>([]);
  const [aiRuns, setAiRuns] = useState(initialAiRuns);
  const [aiPending, setAiPending] = useState(initialAiRuns.filter(run => run.status === "pending").length);
  const listRef = useRef<HTMLOListElement>(null);
  const messagesRef = useRef(messages);
  const readingRef = useRef<ReadingPosition | null>(null);
  const searchReadingRef = useRef<ReadingPosition | null>(null);
  const firstPaintRef = useRef(true);
  const previousQueryRef = useRef("");
  const queryRef = useRef(normalizedQuery);
  const jumpToLatestRef = useRef(false);
  const terminalRef = useRef<FeedIssue | null>(null);
  const olderControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const refreshRef = useRef<(force?: boolean) => void>(() => {});

  const rememberPosition = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const bounds = list.getBoundingClientRect();
    const anchor = Array.from(list.children).find(item => (item as HTMLElement).dataset.messageId && item.getBoundingClientRect().bottom > bounds.top);
    const bottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    readingRef.current = { atBottom: bottom, scrollTop: list.scrollTop, scrollHeight: list.scrollHeight,
      anchorId: (anchor as HTMLElement | undefined)?.dataset.messageId,
      anchorOffset: anchor ? anchor.getBoundingClientRect().top - bounds.top : undefined };
    setAtBottom(bottom);
    if (bottom && !queryRef.current) setNewIds(previous => previous.length ? [] : previous);
  }, []);

  useLayoutEffect(() => {
    messagesRef.current = messages;
    queryRef.current = normalizedQuery;
    const list = listRef.current;
    if (!list) return;
    const restore = (position: ReadingPosition | null) => {
      if (!position || position.atBottom) { list.scrollTop = list.scrollHeight; return; }
      const anchor = Array.from(list.children).find(item => (item as HTMLElement).dataset.messageId === position.anchorId);
      if (anchor && position.anchorOffset !== undefined) list.scrollTop += anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - position.anchorOffset;
      else list.scrollTop = Math.max(0, position.scrollTop + list.scrollHeight - position.scrollHeight);
    };
    if (firstPaintRef.current || jumpToLatestRef.current) {
      list.scrollTop = list.scrollHeight;
      firstPaintRef.current = false;
      jumpToLatestRef.current = false;
    } else if (previousQueryRef.current !== normalizedQuery) {
      if (!previousQueryRef.current) searchReadingRef.current = readingRef.current;
      if (normalizedQuery) list.scrollTop = 0;
      else restore(searchReadingRef.current);
    } else restore(readingRef.current);
    previousQueryRef.current = normalizedQuery;
    rememberPosition();
  }, [messages, shownMessages, normalizedQuery, rememberPosition]);

  const notifyAccess = useCallback((allowed: boolean, message = "") => {
    window.dispatchEvent(new CustomEvent("ruli:chat-access", { detail: { taskId, channelMemberId: channelKey(channelMemberId), allowed, message } }));
  }, [taskId, channelMemberId]);

  const showIssue = useCallback((next: FeedIssue) => {
    setIssue(next);
    if (!next.retryable) { terminalRef.current = next; olderControllerRef.current?.abort(); notifyAccess(false, next.message); }
  }, [notifyAccess]);

  const goToLatest = useCallback(() => {
    jumpToLatestRef.current = Boolean(queryRef.current);
    setQuery("");
    setNewIds([]);
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    rememberPosition();
  }, [rememberPosition]);

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    let activeController: AbortController | null = null;
    let failures = 0;
    let retryAfter = 0;

    async function refresh(force = false) {
      if (disposed || activeController || (!force && (document.visibilityState !== "visible" || terminalRef.current || Date.now() < retryAfter))) return;
      const controller = new AbortController();
      activeController = controller;
      setRefreshing(true);
      let timedOut = false;
      const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 8_000);
      try {
        const params = new URLSearchParams({ channel: channelMemberId || "general" });
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/messages?${params}`, {
          credentials: "same-origin", cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" },
        });
        if (disposed || controller.signal.aborted) return;
        if (!response.ok) {
          const next = feedIssueForStatus(response.status);
          if (!next.retryable) { showIssue(next); return; }
          throw new Error("messages-unavailable");
        }
        const data = parseFeedPayload(await response.json(), taskId, channelMemberId);
        if (disposed || controller.signal.aborted) return;
        const wasBlocked = Boolean(terminalRef.current);
        terminalRef.current = null;
        if (wasBlocked) notifyAccess(true);
        setIssue(null);
        failures = 0;
        retryAfter = 0;
        setAiPending(data.aiPending);
        setAiRuns(data.aiRuns);
        const previous = messagesRef.current;
        const merged = mergeMessages(previous, data.messages, taskId, channelMemberId);
        if (!pageInitializedRef.current || !previous.length) {
          setHistoryProgress(createHistoryProgress(data));
          pageInitializedRef.current = true;
        } else setHistoryProgress(current => observeHistoryHead(current, previous, data));
        if (JSON.stringify(merged) === JSON.stringify(previous)) return;
        rememberPosition();
        if (queryRef.current || !readingRef.current?.atBottom) {
          const added = newIncomingIds(previous, merged, viewerMemberId);
          if (added.length) setNewIds(current => [...new Set([...current, ...added])]);
        }
        messagesRef.current = merged;
        setReceivedMessages(merged);
      } catch {
        if (!disposed && (!controller.signal.aborted || timedOut)) {
          failures++;
          retryAfter = Date.now() + Math.min(30_000, 5_000 * 2 ** Math.min(failures - 1, 3));
          if (!terminalRef.current) showIssue(feedIssueForStatus(0));
        }
      } finally {
        window.clearTimeout(timeout);
        if (activeController === controller) { activeController = null; if (!disposed) setRefreshing(false); }
      }
    }
    refreshRef.current = force => { void refresh(force); };
    function visibilityChanged() {
      if (document.visibilityState === "visible") void refresh();
      else activeController?.abort();
    }
    function online() { if (!terminalRef.current) void refresh(true); }
    function messageSent(event: Event) {
      const detail = (event as CustomEvent<{ taskId?: string; channelMemberId?: string | null }>).detail;
      if (detail?.taskId !== taskId || channelKey(detail.channelMemberId) !== channelKey(channelMemberId)) return;
      activeController?.abort();
      activeController = null;
      goToLatest();
      void refresh(true);
    }
    const interval = window.setInterval(() => void refresh(), 5_000);
    void refresh();
    document.addEventListener("visibilitychange", visibilityChanged);
    window.addEventListener("online", online);
    window.addEventListener("ruli:messages-updated", messageSent);
    return () => {
      disposed = true;
      mountedRef.current = false;
      refreshRef.current = () => {};
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibilityChanged);
      window.removeEventListener("online", online);
      window.removeEventListener("ruli:messages-updated", messageSent);
      activeController?.abort();
      olderControllerRef.current?.abort();
    };
  }, [taskId, channelMemberId, viewerMemberId, goToLatest, rememberPosition, showIssue, notifyAccess]);

  async function loadEarlier() {
    if (!pageInfo.hasMore || !pageInfo.beforeCursor || olderControllerRef.current || terminalRef.current) return;
    const requestedCursor = pageInfo.beforeCursor;
    const controller = new AbortController();
    olderControllerRef.current = controller;
    setOlderLoading(true);
    setOlderError("");
    setOlderStatus("");
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 8_000);
    try {
      const params = new URLSearchParams({ channel: channelMemberId || "general", before: requestedCursor });
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/messages?${params}`, {
        credentials: "same-origin", cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" },
      });
      if (!mountedRef.current || controller.signal.aborted) return;
      if (!response.ok) {
        const next = feedIssueForStatus(response.status);
        if (!next.retryable) { showIssue(next); return; }
        throw new Error("history-unavailable");
      }
      const data = parseFeedPayload(await response.json(), taskId, channelMemberId);
      if (!mountedRef.current || controller.signal.aborted) return;
      rememberPosition();
      const previous = messagesRef.current;
      const merged = mergeMessages(previous, data.messages, taskId, channelMemberId);
      messagesRef.current = merged;
      setReceivedMessages(merged);
      setHistoryProgress(current => advanceHistory(current, requestedCursor, previous, data));
      pageInitializedRef.current = true;
      setOlderStatus(merged.length > previous.length ? `Загружено более ранних сообщений: ${merged.length - previous.length}.` : "История обновлена.");
    } catch {
      if (mountedRef.current && (!controller.signal.aborted || timedOut)) setOlderError("Не удалось загрузить историю. Повторите попытку.");
    } finally {
      window.clearTimeout(timeout);
      if (olderControllerRef.current === controller) {
        olderControllerRef.current = null;
        if (mountedRef.current) setOlderLoading(false);
      }
    }
  }

  function quote(message: ChatMessage) {
    if (!canWrite || terminalRef.current) return;
    window.dispatchEvent(new CustomEvent("ruli:quote-message", { detail: {
      taskId, channelMemberId: channelKey(channelMemberId), authorName: message.authorName, body: message.body,
    } }));
  }

  const blocked = Boolean(issue && !issue.retryable);
  const retries = aiRuns.filter(run => run.canRetry && run.status === "failed");
  const returnPath = taskPagePath(taskId, { chat: channelMemberId || "general" });
  return <div className="message-feed">
    <div className="chat-feed-toolbar">
      <label className="chat-search-field"><Search aria-hidden="true"/><span className="sr-only">Поиск по загруженным сообщениям</span>
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Поиск в загруженной переписке" aria-label="Поиск по загруженным сообщениям"/>
      </label>
      {query ? <button type="button" className="chat-search-clear" onClick={() => setQuery("")} aria-label="Очистить поиск"><X aria-hidden="true"/></button> : null}
      <span className="chat-search-count" role="status">{normalizedQuery ? `Найдено: ${shownMessages.length} из ${messages.length}` : `Загружено сообщений: ${messages.length}`}</span>
    </div>
    <div className={`feed-status${issue ? issue.retryable ? " offline" : " terminal" : ""}`} role="status" aria-live="polite">
      {issue ? <><p>{issue.message}</p><div className="feed-status-actions">
        {issue.kind === "auth" ? <a href={`/signin-with-chatgpt?return_to=${encodeURIComponent(returnPath)}`}>Войти снова</a> : null}
        {issue.kind === "missing" ? <Link href="/">К задачам</Link> : null}
        <button type="button" className="feed-retry" disabled={refreshing} onClick={() => refreshRef.current(true)}><RefreshCw aria-hidden="true"/>{issue.retryable ? "Повторить обновление" : "Проверить доступ"}</button>
      </div></> : <span>{refreshing ? <LoaderCircle aria-hidden="true"/> : null}Сообщения обновляются автоматически.</span>}
    </div>
    <div className="message-history-controls">
      {pageInfo.hasMore ? <button type="button" onClick={loadEarlier} disabled={olderLoading || blocked}>
        {olderLoading ? <LoaderCircle aria-hidden="true"/> : <History aria-hidden="true"/>}{olderLoading ? "Загружаем историю…" : olderError ? "Повторить загрузку истории" : "Загрузить раньше"}
      </button> : messages.length ? <span>Начало доступной истории</span> : null}
      {olderError ? <p role="alert">{olderError}</p> : null}<span role="status">{olderStatus}</span>
    </div>
    <ol ref={listRef} onScroll={rememberPosition} className="message-list" role="log" aria-label="Сообщения диалога" aria-live={normalizedQuery ? "off" : "polite"} aria-relevant="additions text" aria-atomic="false" aria-busy={olderLoading} tabIndex={shownMessages.length ? 0 : -1}>
      {shownMessages.map((message, index) => {
        const day = messageDayKey(message.createdAt);
        const showDay = index === 0 || day !== messageDayKey(shownMessages[index - 1].createdAt);
        return <Fragment key={message.id}>
          {showDay ? <li className="message-day-separator" role="presentation"><span>{messageDayLabel(message.createdAt)}</span></li> : null}
          <MessageItem message={message} member={memberMap.get(message.authorId)} mine={message.authorId === viewerMemberId} canWrite={canWrite && !blocked} onQuote={quote}/>
        </Fragment>;
      })}
    </ol>
    {!shownMessages.length ? <p className="empty-copy">{normalizedQuery ? "В загруженной переписке совпадений нет. Измените запрос или загрузите более ранние сообщения." : "Здесь пока нет сообщений. Начните обсуждение задачи."}</p> : null}
    {newIds.length || (!atBottom && messages.length) ? <button type="button" className="chat-new-messages" onClick={goToLatest}><ArrowDown aria-hidden="true"/>{newIds.length ? `Новые сообщения · ${newIds.length}` : "К последним сообщениям"}</button> : null}
    {aiPending > 0 && !blocked ? <p className="chat-ai-status" role="status"><Bot aria-hidden="true"/>AI готовит ответ{aiPending > 1 ? ` · запросов: ${aiPending}` : ""}. Он появится здесь после завершения.</p> : null}
    {retries.length > 0 && canWrite && !blocked ? <div className="chat-ai-retries">{retries.map(run => <AiChatRetry key={run.id} taskId={taskId} run={run} clientId={`retry-${run.id}`}/>)}</div> : null}
  </div>;
}
