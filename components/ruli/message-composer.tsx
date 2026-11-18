"use client";
import {useActionState, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent} from "react";
import {Bot, Check, ChevronDown, Info, LoaderCircle, Send} from "lucide-react";
import {sendMessageState} from "@/app/collaboration-actions";
import type {ActionState} from "@/lib/ruli/action-state";
import {draftStorageKey} from "./chat-drafts";
import {getDraftStore} from "./chat-draft-store";
import {formatQuote} from "./chat-message-utils";
import type {TaskBot} from "@/lib/ruli/ai";
import "./message-composer.css";

export function MessageComposer({taskId,channelMemberId="",viewerUserId,clientId,mode,bots=[],privateBot}:{
  taskId:string;channelMemberId?:string;viewerUserId:string;clientId:string;mode:string;bots?:TaskBot[];privateBot?:TaskBot;
}) {
  const [state,action,pending]=useActionState<ActionState,FormData>(sendMessageState,{});
  const [selectedBot,setSelectedBot]=useState("");
  const [quoteError,setQuoteError]=useState("");
  const [accessError,setAccessError]=useState("");
  const [recoveryStatus,setRecoveryStatus]=useState("");
  const textId=useId();
  const textareaRef=useRef<HTMLTextAreaElement>(null);
  const formRef=useRef<HTMLFormElement>(null);
  const modelBots=bots.filter(item=>item.kind!=="agent");
  const bot=privateBot??(!channelMemberId?modelBots.find(item=>item.memberId===selectedBot):undefined);
  const external=bot?.kind==="agent";
  const generalAgents=!channelMemberId&&bots.some(item=>item.kind==="agent");
  const storageKey=draftStorageKey({viewerUserId,taskId,channelMemberId});
  const store=useMemo(()=>getDraftStore(storageKey,clientId),[storageKey,clientId]);
  const {draft,persistent,unsent=[]}=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getServerSnapshot);
  const acknowledged=useRef<string|null>(null);
  const recovered=useRef(new Set<string>());
  const failedBody=typeof state.values?.body==="string"?state.values.body:"";
  const failedClientId=typeof state.values?.clientId==="string"?state.values.clientId:clientId;
  const unavailable=Boolean(bot&&!bot.ready)||Boolean(accessError);
  const canSend=Boolean(draft.body.trim())&&!unavailable&&!pending;

  useEffect(()=>{
    const sent=state.sentClientId;
    if(!sent||acknowledged.current===sent)return;
    acknowledged.current=sent;
    // Acknowledgments only clear the submitted revision; typing the next draft is safe.
    store.acknowledge(sent);
    window.dispatchEvent(new CustomEvent("ruli:messages-updated",{
      detail:{taskId,channelMemberId:channelMemberId||null},
    }));
  },[state.sentClientId,store,taskId,channelMemberId]);

  useEffect(()=>{
    if(!state.error||!failedBody.trim()||failedBody===draft.body||recovered.current.has(failedClientId))return;
    recovered.current.add(failedClientId);
    store.preserveUnsent({body:failedBody,clientId:failedClientId});
  },[state.error,failedBody,failedClientId,draft.body,store]);

  useEffect(()=>{
    const field=textareaRef.current;
    if(!field)return;
    field.style.height="auto";
    field.style.height=`${Math.min(180,Math.max(64,field.scrollHeight))}px`;
  },[draft.body]);

  useEffect(()=>{
    function sameChannel(detail:{taskId?:string;channelMemberId?:string|null}|undefined) {
      return detail?.taskId===taskId&&(detail.channelMemberId||"")===channelMemberId;
    }
    function quoteMessage(event:Event) {
      const detail=(event as CustomEvent<{taskId?:string;channelMemberId?:string|null;authorName?:string;body?:string}>).detail;
      if(!sameChannel(detail)||typeof detail?.body!=="string"||typeof detail.authorName!=="string")return;
      const current=store.getSnapshot().draft.body;
      const quote=formatQuote(detail.authorName,detail.body);
      const next=current?`${current}\n\n${quote}`:quote;
      if(next.length>5000){setQuoteError("Для цитаты не хватает места. Сократите черновик и повторите.");return;}
      store.edit(next);
      setQuoteError("");
      textareaRef.current?.focus({preventScroll:true});
      textareaRef.current?.scrollIntoView({behavior:"smooth",block:"nearest"});
    }
    function accessChanged(event:Event) {
      const detail=(event as CustomEvent<{taskId?:string;channelMemberId?:string|null;allowed?:boolean;message?:string}>).detail;
      if(!sameChannel(detail))return;
      setAccessError(detail?.allowed===false?detail.message||"Этот диалог больше недоступен.":"");
    }
    window.addEventListener("ruli:quote-message",quoteMessage);
    window.addEventListener("ruli:chat-access",accessChanged);
    return ()=>{window.removeEventListener("ruli:quote-message",quoteMessage);window.removeEventListener("ruli:chat-access",accessChanged);};
  },[store,taskId,channelMemberId]);

  function onKeyDown(event:KeyboardEvent<HTMLTextAreaElement>) {
    if(event.key!=="Enter"||event.nativeEvent.isComposing||event.keyCode===229||event.shiftKey||event.altKey)return;
    const shortcut=event.ctrlKey||event.metaKey||!window.matchMedia("(pointer: coarse)").matches;
    if(!shortcut)return;
    event.preventDefault();
    if(canSend)formRef.current?.requestSubmit();
  }

  return <><form ref={formRef} className="message-form chat-composer-form" action={action} onSubmit={event=>{
    if(!canSend){event.preventDefault();return;}
    setQuoteError("");
  }}>
    <input type="hidden" name="taskId" value={taskId}/>
    <input type="hidden" name="channelMemberId" value={channelMemberId}/>
    <input type="hidden" name="clientId" value={draft.clientId}/>
    <input type="hidden" name="mode" value={mode}/>
    {privateBot?<input type="hidden" name="botMemberId" value={privateBot.memberId}/>:null}
    {(bot||(!channelMemberId&&modelBots.length>0)||generalAgents)?<div className="composer-ai-toolbar">
      {!privateBot&&!channelMemberId&&modelBots.length?<label className="chat-bot-select composer-ai-target"><Bot aria-hidden="true"/><span className="sr-only">Попросить AI ответить</span><select name="botMemberId" aria-label="Попросить AI ответить" value={selectedBot} disabled={pending} onChange={event=>setSelectedBot(event.target.value)}><option value="">Сообщение команде</option>{modelBots.map(item=><option key={item.memberId} value={item.memberId} disabled={!item.ready}>{item.name}{!item.enabled?" · выключен":!item.configured?" · нужен ключ":""}</option>)}</select></label>:bot?<span className="composer-private-ai"><Bot aria-hidden="true"/>{bot.kind==="agent"?"Внешний агент":bot.provider==="xai"?"Grok":"OpenAI"}</span>:<span className="composer-private-ai"><Bot aria-hidden="true"/>Внешние агенты</span>}
      {!privateBot?<details className="composer-info"><summary><Info aria-hidden="true"/><span>Как работает AI</span><ChevronDown aria-hidden="true"/></summary><div>
        {generalAgents?<p>Сообщения общего чата автоматически передаются включённым внешним агентам, назначенным непосредственно на эту задачу. Для обращения к одному агенту откройте его личный чат.{modelBots.length?" Выбор AI-бота не ограничивает этих получателей.":""}</p>:null}
        {bot?<p>{!bot.ready?bot.disabledReason:external?`Сообщение будет передано внешнему агенту ${bot.name} (Grok Bot) через вебхук. Ответ появится в этом чате после обработки агентом.`:`Сообщение и контекст этого чата будут переданы ${bot.provider==="xai"?"xAI · Grok":"OpenAI"} (${bot.model}). Ответит ${bot.name}.`}</p>:<p>Выберите AI-бота, чтобы он ответил с учётом переписки и задачи. Без выбора сообщение отправляется команде.</p>}
      </div></details>:null}
    </div>:null}
    {privateBot&&!privateBot.ready?<p className="composer-status warning" role="status">{privateBot.disabledReason||"Руководитель должен настроить этого бота перед началом диалога."}</p>:null}
    <div className={`composer-input-shell${pending?" is-sending":""}`}>
      <label htmlFor={textId} className="sr-only">Сообщение</label>
      <textarea ref={textareaRef} id={textId} name="body" rows={2} required maxLength={5000}
        value={draft.body} aria-describedby={`${textId}-hint`} onKeyDown={onKeyDown} onChange={event=>{store.edit(event.target.value);setQuoteError("");}}
        placeholder={bot?`Сообщение для ${bot.name}…`:channelMemberId?"Напишите личное сообщение…":"Напишите сообщение команде…"}/>
      <div className="composer-footer">
        <span id={`${textId}-hint`} className="composer-hint"><span className="composer-desktop-hint">Enter — отправить · Shift+Enter — новая строка</span><span className="composer-mobile-hint">Черновик сохраняется</span></span>
        {draft.body.length>=4500?<span className={`composer-count${draft.body.length===5000?" at-limit":""}`} aria-live="polite">{draft.body.length.toLocaleString("ru-RU")} / 5 000</span>:null}
        <button className="composer-send" type="submit" disabled={!canSend} aria-label={pending?"Отправляем сообщение":"Отправить сообщение"} title={pending?"Дождитесь завершения отправки":"Отправить сообщение"}>{pending?<LoaderCircle className="composer-spinner" aria-hidden="true"/>:<Send aria-hidden="true"/>}<span>{pending?"Отправляем":"Отправить"}</span></button>
      </div>
    </div>
    {accessError?<p className="form-error" role="alert">{accessError} Черновик сохранён в этой вкладке.</p>:null}
    {quoteError?<p className="form-error" role="alert">{quoteError}</p>:null}
    {state.error?<p className="form-error" role="alert">{state.error} Текущий черновик не изменён.</p>:null}
    {unsent.length?<details className="composer-recovery" open><summary>Неотправленные сообщения · {unsent.length}</summary>
      <p>Эти сообщения не удалось отправить. Новый черновик сохранён отдельно.</p>
      {unsent.map(item=><div className="composer-recovery-item" key={item.clientId}>
        <textarea readOnly rows={3} value={item.body} aria-label="Сохранённое неотправленное сообщение"/>
        <div className="composer-recovery-actions">
          <button type="button" onClick={()=>{
            const restored=store.restoreUnsent(item.clientId);
            setRecoveryStatus(restored==="too-long"?"Тексты вместе превышают 5 000 символов. Скопируйте сохранённое сообщение или сократите текущий черновик — оба текста остаются сохранены.":restored==="restored"?"Сохранённый текст добавлен к черновику.":"");
            if(restored==="restored")textareaRef.current?.focus({preventScroll:true});
          }}>Добавить к черновику</button>
          <button type="button" onClick={async()=>{
            try {await navigator.clipboard.writeText(item.body);setRecoveryStatus("Неотправленное сообщение скопировано.");}
            catch {setRecoveryStatus("Не удалось скопировать. Выделите текст в сохранённом сообщении и скопируйте вручную.");}
          }}>Копировать</button>
          <button type="button" onClick={()=>{store.discardUnsent(item.clientId);setRecoveryStatus("Сохранённый текст удалён. Текущий черновик не изменён.");}}>Удалить сохранённый текст</button>
        </div>
      </div>)}
    </details>:null}
    {recoveryStatus?<p className="composer-status" role="status">{recoveryStatus}</p>:null}
    {pending?<p className="composer-status" role="status"><LoaderCircle className="composer-spinner" aria-hidden="true"/>{bot&&!external?"AI готовит ответ. Можно набирать следующий черновик.":"Отправляем сообщение… Можно продолжать писать."}</p>:state.sentClientId&&!state.error&&!draft.body?<p className="composer-status sent" role="status"><Check aria-hidden="true"/>{external?"Сохранено в чате. Ответ агента появится после обработки.":"Сообщение отправлено"}</p>:null}
    {state.notice&&!pending?<p className={state.aiStatus==="failed"?"form-error":"composer-status"} role={state.aiStatus==="failed"?"alert":"status"}>{state.notice}</p>:null}
    {!persistent?<p className="form-error" role="status">Браузер не разрешил сохранить черновики. Скопируйте текущий и неотправленные тексты перед обновлением страницы.</p>:null}
  </form></>;
}
