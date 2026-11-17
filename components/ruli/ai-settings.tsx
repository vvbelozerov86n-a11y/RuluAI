"use client";

import {useActionState,useId,useState} from "react";
import {saveBotState} from "@/app/ai-actions";
import type {loadBotSettings} from "@/lib/ruli/ai";
import type {ActionState} from "@/lib/ruli/action-state";
import {SubmitButton} from "./submit-button";

type Settings=Awaited<ReturnType<typeof loadBotSettings>>;
type Bot=Settings["bots"][number];

function BotForm({bot,providers}:{bot?:Bot;providers:Settings["providers"]}) {
  const [state,action,pending]=useActionState<ActionState,FormData>(saveBotState,{});
  const id=useId();
  const [name,setName]=useState(bot?.name??"");
  const [role,setRole]=useState(bot?.role??"");
  const [provider,setProvider]=useState<string>(bot?.provider??providers[0].id);
  const [model,setModel]=useState(bot?.model??providers[0].defaultModel);
  const [instructions,setInstructions]=useState(bot?.systemPrompt??"");
  const [enabled,setEnabled]=useState(bot?.enabled??false);
  const selected=providers.find(item=>item.id===provider)!;
  return <form className="ai-settings-form" action={action}>
    <input type="hidden" name="memberId" value={bot?.memberId??""}/>
    <input type="hidden" name="version" value={bot?.version??0}/>
    <div className="form-pair"><label htmlFor={`${id}-name`}>Имя бота<input id={`${id}-name`} name="name" value={name} onChange={e=>setName(e.target.value)} required maxLength={120} placeholder="Например, Аналитик"/></label><label htmlFor={`${id}-role`}>Роль в команде<input id={`${id}-role`} name="role" value={role} onChange={e=>setRole(e.target.value)} maxLength={120} placeholder="Например, исследование рынка"/></label></div>
    <div className="form-pair"><label htmlFor={`${id}-provider`}>AI-провайдер<select id={`${id}-provider`} name="provider" value={provider} onChange={e=>{const next=providers.find(item=>item.id===e.target.value)!;setProvider(next.id);setModel(next.defaultModel);}}>{providers.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label htmlFor={`${id}-model`}>Модель<input id={`${id}-model`} name="model" value={model} onChange={e=>setModel(e.target.value)} required maxLength={128} spellCheck={false} autoCapitalize="none"/></label></div>
    <p className="detail-note">Используйте идентификатор модели, доступной в аккаунте выбранного провайдера.</p>
    <label htmlFor={`${id}-instructions`}>Инструкции боту<textarea id={`${id}-instructions`} name="systemPrompt" value={instructions} onChange={e=>setInstructions(e.target.value)} rows={5} maxLength={5000} placeholder="Какие задачи решает бот, каким должен быть ответ и что необходимо учитывать"/></label>
    <label className="check-label"><input type="checkbox" name="enabled" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>Включить бота</label>
    <p className={`ai-connection ${!enabled?"disabled":selected.configured?"ready":"missing"}`} role="status">{!enabled?"Бот выключен.":selected.configured?"Ключ провайдера настроен. Подключение будет проверено при первом запросе.":"Нужен ключ провайдера. Настройки бота можно сохранить, но запросы пока недоступны."}</p>
    {state.error?<p className="form-error" role="alert">{state.error} Введённые настройки остаются в форме.</p>:null}
    <SubmitButton disabled={pending}>{bot?"Сохранить настройки":"Создать бота"}</SubmitButton>
  </form>;
}

export function AiSettings({data}:{data:Settings}) {
  return <section className="ai-settings" aria-labelledby="ai-settings-title">
    <h2 id="ai-settings-title">AI-боты</h2>
    <p>Настройте исполнителей для задач и обсуждений. При запуске содержание задачи или выбранного чата передаётся AI-провайдеру. Результат задачи ждёт проверки руководителя.</p>
    <div className="ai-provider-status">{data.providers.map(provider=><div key={provider.id}><strong>{provider.label}</strong><span className={`ai-badge ${provider.configured?"ready":"missing"}`}>{provider.configured?"Ключ настроен":"Нужен ключ"}</span></div>)}</div>
    <details className="ai-connection-help"><summary>Как подключить провайдера</summary><p>Добавьте секрет в настройки проекта Sites. Значения ключей хранятся только на сервере. Не вставляйте их в инструкции бота или сообщения.</p><ul>{data.providers.map(provider=><li key={provider.id}>{provider.label}: <code>{provider.keyName}</code></li>)}</ul><p>Сохраните секрет и опубликуйте обновление сайта, затем обновите страницу. Статус «Ключ настроен» подтверждает наличие ключа; доступ к модели проверяется при запросе.</p></details>
    <div className="ai-bot-settings-list">{data.bots.map(bot=><details className="ai-bot-settings" key={bot.memberId}><summary><span><strong>{bot.name}</strong><small>{bot.model}</small></span><span className={`ai-badge ${!bot.enabled?"disabled":bot.ready?"ready":"missing"}`}>{!bot.enabled?"Выключен":!bot.configured?"Нужен ключ":bot.ready?"Ключ настроен":"Нужно настроить"}</span></summary>{bot.enabled&&!bot.ready&&bot.disabledReason?<p className="ai-connection missing">{bot.disabledReason}</p>:null}<BotForm bot={bot} providers={data.providers}/></details>)}</div>
    <details className="ai-bot-settings ai-create"><summary>Создать AI-бота</summary><BotForm providers={data.providers}/></details>
  </section>;
}
