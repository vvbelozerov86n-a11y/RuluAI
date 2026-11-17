"use client";
import {useActionState, useEffect, useMemo, useRef, useState, useSyncExternalStore} from "react";
import {sendMessageState} from "@/app/collaboration-actions";
import type {ActionState} from "@/lib/ruli/action-state";
import {SubmitButton} from "./submit-button";
import {draftStorageKey} from "./chat-drafts";
import {getDraftStore} from "./chat-draft-store";
import type {TaskBot} from "@/lib/ruli/ai";
import {AiChatRetry} from "./ai-task";

export function MessageComposer({taskId,channelMemberId="",viewerUserId,clientId,mode,bots=[],privateBot}:{
  taskId:string;channelMemberId?:string;viewerUserId:string;clientId:string;mode:string;bots?:TaskBot[];privateBot?:TaskBot;
}) {
  const [state,action,pending]=useActionState<ActionState,FormData>(sendMessageState,{});
  const [selectedBot,setSelectedBot]=useState("");
  const [submittedBot,setSubmittedBot]=useState("");
  const bot=privateBot??(!channelMemberId?bots.find(item=>item.memberId===selectedBot):undefined);
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

  return <><form className="message-form" action={action} onSubmit={()=>{setSubmittedBot(bot?.memberId??"");}}>
    <input type="hidden" name="taskId" value={taskId}/>
    <input type="hidden" name="channelMemberId" value={channelMemberId}/>
    <input type="hidden" name="clientId" value={draft.clientId}/>
    <input type="hidden" name="mode" value={mode}/>
    {privateBot?<input type="hidden" name="botMemberId" value={privateBot.memberId}/>:!channelMemberId&&bots.length?<label className="chat-bot-select">Попросить AI ответить<select name="botMemberId" value={selectedBot} disabled={pending} onChange={event=>setSelectedBot(event.target.value)}><option value="">Без AI — сообщение команде</option>{bots.map(item=><option key={item.memberId} value={item.memberId} disabled={!item.ready}>{item.name}{!item.enabled?" · выключен":!item.configured?" · нужен ключ":""}</option>)}</select></label>:null}
    {bot?<p className="channel-note">{bot.ready?`Сообщение и контекст этого чата будут переданы ${bot.provider==="xai"?"xAI · Grok":"OpenAI"} (${bot.model}). Ответит ${bot.name}.`:bot.disabledReason}</p>:null}
    <label htmlFor="message-body">Сообщение</label>
    <textarea id="message-body" name="body" rows={3} required maxLength={5000}
      value={draft.body} disabled={pending} onChange={event=>store.edit(event.target.value)}
      placeholder="Напишите вопрос или зафиксируйте решение"/>
    {state.error?<p className="form-error" role="alert">{state.error} Сообщение остаётся в форме.</p>:null}
    {state.sentClientId&&!state.error?<p className="feed-status" role="status">Сообщение отправлено.</p>:null}
    {pending&&bot?<p className="ai-run-status" role="status">Ожидаем ответ AI. Обычно это занимает до 45 секунд.</p>:null}
    {state.notice?<p className={state.aiStatus==="failed"?"form-error":"feed-status"} role={state.aiStatus==="failed"?"alert":"status"}>{state.notice}</p>:null}
    {!persistent?<p className="form-error" role="status">Браузер не разрешил сохранить черновик. Скопируйте текст перед обновлением страницы.</p>:null}
    <div className="detail-actions"><SubmitButton disabled={Boolean(privateBot&&!privateBot.ready)} pendingLabel={bot?"Отправляем и ждём AI…":"Отправляем…"}>Отправить</SubmitButton><span className="detail-note">Черновик сохраняется в этой вкладке · до 5 000 символов</span></div>
  </form>{state.aiStatus==="failed"&&state.aiRunId&&submittedBot?<AiChatRetry taskId={taskId} clientId={clientId} key={state.aiRunId} run={{id:state.aiRunId,botMemberId:submittedBot,channelMemberId:channelMemberId||null,inputMessageId:null,error:null}}/>:null}</>;
}

