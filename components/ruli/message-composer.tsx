"use client";
import {useActionState, useEffect, useMemo, useRef, useSyncExternalStore} from "react";
import {sendMessageState} from "@/app/collaboration-actions";
import type {ActionState} from "@/lib/ruli/action-state";
import {SubmitButton} from "./submit-button";
import {draftStorageKey} from "./chat-drafts";
import {getDraftStore} from "./chat-draft-store";

export function MessageComposer({taskId,channelMemberId="",viewerUserId,clientId,mode}:{
  taskId:string;channelMemberId?:string;viewerUserId:string;clientId:string;mode:string;
}) {
  const [state,action,pending]=useActionState<ActionState,FormData>(sendMessageState,{});
  const storageKey=draftStorageKey({viewerUserId,taskId,channelMemberId});
  const store=useMemo(()=>getDraftStore(storageKey,clientId),[storageKey,clientId]);
  const {draft,persistent}=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getServerSnapshot);
  const acknowledged=useRef<string|null>(null);

  useEffect(()=>{
    const sent=state.sentClientId;
    if(!sent||acknowledged.current===sent)return;
    acknowledged.current=sent;
    store.acknowledge(sent);
    window.dispatchEvent(new CustomEvent("ruli:messages-updated",{
      detail:{taskId,channelMemberId:channelMemberId||null},
    }));
  },[state.sentClientId,store,taskId,channelMemberId]);

  return <form className="message-form" action={action}>
    <input type="hidden" name="taskId" value={taskId}/>
    <input type="hidden" name="channelMemberId" value={channelMemberId}/>
    <input type="hidden" name="clientId" value={draft.clientId}/>
    <input type="hidden" name="mode" value={mode}/>
    <label htmlFor="message-body">Сообщение</label>
    <textarea id="message-body" name="body" rows={3} required maxLength={5000}
      value={draft.body} disabled={pending} onChange={event=>store.edit(event.target.value)}
      placeholder="Напишите вопрос или зафиксируйте решение"/>
    {state.error?<p className="form-error" role="alert">{state.error} Сообщение остаётся в форме.</p>:null}
    {state.sentClientId&&!state.error?<p className="feed-status" role="status">Сообщение отправлено.</p>:null}
    {!persistent?<p className="form-error" role="status">Браузер не разрешил сохранить черновик. Скопируйте текст перед обновлением страницы.</p>:null}
    <div className="detail-actions"><SubmitButton pendingLabel="Отправляем…">Отправить</SubmitButton><span className="detail-note">Черновик сохраняется в этой вкладке · до 5 000 символов</span></div>
  </form>;
}

