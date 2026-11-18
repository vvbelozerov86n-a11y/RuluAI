"use client";
import {acknowledgeDraft, editDraft, readDraft, readUnsentDrafts, type ChatDraft} from "./chat-drafts";

type Snapshot = {draft: ChatDraft; unsent:ChatDraft[]; persistent: boolean};
const stores = new Map<string, ReturnType<typeof createStore>>();

function createStore(key: string, initialClientId: string) {
  const serverSnapshot: Snapshot = {draft: {body: "", clientId: initialClientId}, unsent:[], persistent: true};
  let snapshot = serverSnapshot;
  if (typeof window !== "undefined") {
    try {
      const raw=window.sessionStorage.getItem(key);
      snapshot = {draft: readDraft(raw, initialClientId), unsent:readUnsentDrafts(raw), persistent: true};
    }
    catch { snapshot = {...serverSnapshot, persistent: false}; }
  }
  const listeners = new Set<() => void>();
  function save(draft: ChatDraft,unsent=snapshot.unsent) {
    let persistent = true;
    try {
      // Save the current draft and recovery texts atomically in one storage item.
      if (draft.body||unsent.length) window.sessionStorage.setItem(key, JSON.stringify({...draft,unsent}));
      else window.sessionStorage.removeItem(key);
    } catch { persistent = false; }
    snapshot = {draft, unsent, persistent};
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
      const unsent=snapshot.unsent.filter(item=>item.clientId!==clientId);
      if (next !== snapshot.draft||unsent.length!==snapshot.unsent.length) save(next,unsent);
    },
    preserveUnsent(draft:ChatDraft) {
      if(!draft.body.trim()||snapshot.unsent.some(item=>item.clientId===draft.clientId))return;
      const clientId=/^[a-zA-Z0-9_-]{8,120}$/.test(draft.clientId)?draft.clientId:crypto.randomUUID();
      save(snapshot.draft,[...snapshot.unsent,{body:draft.body,clientId}]);
    },
    restoreUnsent(clientId:string):"restored"|"too-long"|"missing" {
      const failed=snapshot.unsent.find(item=>item.clientId===clientId);
      if(!failed)return "missing";
      const current=snapshot.draft;
      const body=current.body===failed.body?current.body:current.body?`${current.body}\n\n${failed.body}`:failed.body;
      if(body.length>5000)return "too-long";
      const next=current.body===body?current:{body,clientId:current.body?crypto.randomUUID():failed.clientId};
      save(next,snapshot.unsent.filter(item=>item.clientId!==clientId));
      return "restored";
    },
    discardUnsent(clientId:string) {
      save(snapshot.draft,snapshot.unsent.filter(item=>item.clientId!==clientId));
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

