export type ChatDraft = {body: string; clientId: string; botMemberId?: string};
function savedRecipient(value: unknown): Pick<ChatDraft, "botMemberId"> {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(value) ? {botMemberId:value} : {};
}
export type DraftContext = {viewerUserId: string; taskId: string; channelMemberId?: string};

export function draftStorageKey(context: DraftContext): string {
  return "ruli:chat-draft:v2:" + [context.viewerUserId, context.taskId, context.channelMemberId || "general"]
    .map(encodeURIComponent).join(":");
}

export function readDraft(raw: string | null, fallbackClientId: string): ChatDraft {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (value && typeof value === "object") {
      const draft = value as Record<string, unknown>;
      if (typeof draft.body === "string" && draft.body.length <= 5000
        && typeof draft.clientId === "string" && /^[a-zA-Z0-9_-]{8,120}$/.test(draft.clientId)) {
        return {body: draft.body, clientId: draft.clientId, ...savedRecipient(draft.botMemberId)};
      }
    }
  } catch { /* An invalid saved draft must not break the composer. */ }
  return {body: "", clientId: fallbackClientId};
}

export function readUnsentDrafts(raw:string|null):ChatDraft[] {
  try {
    const value:unknown=raw?JSON.parse(raw):null;
    if(!value||typeof value!=="object"||!("unsent" in value)||!Array.isArray(value.unsent))return [];
    const byId=new Map<string,ChatDraft>();
    for(const entry of value.unsent) {
      if(!entry||typeof entry!=="object")continue;
      const draft=entry as Record<string,unknown>;
      if(typeof draft.body==="string"&&draft.body.trim()&&typeof draft.clientId==="string"&&/^[a-zA-Z0-9_-]{8,120}$/.test(draft.clientId)) {
        byId.set(draft.clientId,{body:draft.body,clientId:draft.clientId,...savedRecipient(draft.botMemberId)});
      }
    }
    return [...byId.values()];
  } catch { return []; }
}

export function editDraft(current: ChatDraft, body: string, newClientId: string): ChatDraft {
  // Retrying unchanged content keeps its idempotency key. A new revision gets its own key.
  return body === current.body ? current : {...current, body, clientId: newClientId};
}

export function acknowledgeDraft(current: ChatDraft, sentClientId: string, newClientId: string): ChatDraft {
  // A delayed acknowledgment cannot erase a newer revision.
  return current.clientId === sentClientId ? {...current, body: "", clientId: newClientId} : current;
}

