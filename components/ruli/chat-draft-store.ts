"use client";
import {acknowledgeDraft, editDraft, readDraft, type ChatDraft} from "./chat-drafts";

type Snapshot = {draft: ChatDraft; persistent: boolean};
const stores = new Map<string, ReturnType<typeof createStore>>();

function createStore(key: string, initialClientId: string) {
  const serverSnapshot: Snapshot = {draft: {body: "", clientId: initialClientId}, persistent: true};
  let snapshot = serverSnapshot;
  if (typeof window !== "undefined") {
    try { snapshot = {draft: readDraft(window.sessionStorage.getItem(key), initialClientId), persistent: true}; }
    catch { snapshot = {...serverSnapshot, persistent: false}; }
  }
  const listeners = new Set<() => void>();
  function save(draft: ChatDraft) {
    let persistent = true;
    try {
      if (draft.body) window.sessionStorage.setItem(key, JSON.stringify(draft));
      else window.sessionStorage.removeItem(key);
    } catch { persistent = false; }
    snapshot = {draft, persistent};
    listeners.forEach(listener => listener());
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot() { return snapshot; },
    getServerSnapshot() { return serverSnapshot; },
    edit(body: string) {
      const next = editDraft(snapshot.draft, body, crypto.randomUUID());
      if (next !== snapshot.draft) save(next);
    },
    acknowledge(clientId: string) {
      const next = acknowledgeDraft(snapshot.draft, clientId, crypto.randomUUID());
      if (next !== snapshot.draft) save(next);
    },
  };
}

export function getDraftStore(key: string, initialClientId: string) {
  // Server renders never share drafts across requests. Browser stores are scoped to a user and channel.
  if (typeof window === "undefined") return createStore(key, initialClientId);
  let store = stores.get(key);
  if (!store) { store = createStore(key, initialClientId); stores.set(key, store); }
  return store;
}

