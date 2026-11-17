"use client";

import {useActionState,useId,useState} from "react";
import {saveBotState,testAiConnectionState} from "@/app/ai-actions";
import type {AiConnectionState,loadBotSettings} from "@/lib/ruli/ai";
import type {ActionState} from "@/lib/ruli/action-state";
import {SubmitButton} from "./submit-button";
import "./ai-setup.css";

type Settings=Awaited<ReturnType<typeof loadBotSettings>>;
type Bot=Settings["bots"][number];

// Official key-creation links checked against each provider's quickstart.
const keyPages={xai:"https://console.x.ai/team/default/api-keys",openai:"https://platform.openai.com/api-keys"};
const sitesHelp="https://help.openai.com/en/articles/20001339-creating-and-using-chatgpt-sites";

function ConnectionCheck({provider,model}:{provider:Settings["providers"][number];model:string}) {
  const [state,action,pending]=useActionState<AiConnectionState,FormData>(testAiConnectionState,{});
  return <form action={action} className="ai-setup-check" aria-busy={pending}>
    <input type="hidden" name="provider" value={provider.id}/>
    <input type="hidden" name="model" value={model}/>
    <div className="ai-setup-status" aria-live="polite">
      <p><strong>Ключ:</strong> {provider.configured||state.result?"настроен на сервере":"пока не настроен"}.</p>
      <p><strong>Ответ модели:</strong> {pending?"проверяем…":state.result?`получен от ${state.result.model}. Подключение проверено.`:"ещё не проверен"}</p>
    </div>
    <SubmitButton pendingLabel="Проверяем подключение…" disabled={!model.trim()}>Проверить подключение</SubmitButton>
    <p className="ai-setup-note">Отправим короткий тест без содержимого задач и чатов. Запрос расходует API-лимит провайдера; ожидание — до 45 секунд.</p>
    {state.result?<p className="ai-setup-success" role="status">Можно выбрать эту модель в настройках бота ниже. Проверка действительна для текущего подключения; после смены ключа повторите её.</p>:null}
    {state.error?<p className="form-error" role="alert">{state.error}</p>:null}
  </form>;
}

function ConnectionGuide({providers}:{providers:Settings["providers"]}) {
  const id=useId();
  const [providerId,setProviderId]=useState<string>(providers[0].id);
  const selected=providers.find(provider=>provider.id===providerId)!;
  const [model,setModel]=useState<string>(selected.defaultModel);
  const [copyStatus,setCopyStatus]=useState("");
  const [selectionVersion,setSelectionVersion]=useState(0);
  async function copyName() {
    try { await navigator.clipboard.writeText(selected.keyName);setCopyStatus("Имя переменной скопировано."); }
    catch { setCopyStatus("Не удалось скопировать. Выделите имя переменной и скопируйте вручную."); }
  }
  return <section className="ai-setup" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Подключите AI за 3 шага</h3>
    <p>Понадобится API-ключ Grok или OpenAI и доступ владельца сайта к настройкам Sites.</p>
    <ol className="ai-setup-steps">
      <li><h4>Создайте ключ у провайдера</h4>
        <label htmlFor={`${id}-provider`}>Провайдер<select id={`${id}-provider`} value={providerId} onChange={event=>{const next=providers.find(provider=>provider.id===event.target.value)!;setProviderId(next.id);setModel(next.defaultModel);setCopyStatus("");setSelectionVersion(value=>value+1);}}>{providers.map(provider=><option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
        <p><a href={keyPages[selected.id]} target="_blank" rel="noopener noreferrer">Открыть API Keys {selected.label} <span className="ai-setup-note">(новая вкладка)</span></a></p>
        <p className="ai-setup-note">Войдите в аккаунт, выберите проект или команду и создайте API-ключ. Убедитесь, что у аккаунта есть доступ к выбранной модели и API-лимит.</p>
      </li>
      <li><h4>Добавьте секрет в Sites</h4>
        <p>В ChatGPT откройте <strong>Sites → ваш сайт «Рули» → настройки сайта → секреты / переменные окружения</strong>. Этот раздел доступен владельцу сайта.</p>
        <p>В поле имени укажите:</p>
        <div className="ai-setup-key"><code>{selected.keyName}</code><button type="button" className="secondary" onClick={copyName}>Копировать имя</button></div>
        <p className="ai-setup-copy" role="status">{copyStatus}</p>
        <p>В значение секрета вставьте ключ, полученный у провайдера. Сохраните, опубликуйте обновление сайта и обновите эту страницу.</p>
        <p className="ai-setup-note">Ключ вводится только в настройках Sites, а не в инструкции бота или чат. Если раздел не виден, обратитесь к владельцу сайта. <a href={sitesHelp} target="_blank" rel="noopener noreferrer">Инструкция Sites (новая вкладка)</a>.</p>
      </li>
      <li><h4>Проверьте ответ модели</h4>
        <label htmlFor={`${id}-model`}>Модель для проверки<input id={`${id}-model`} list={`${id}-models`} value={model} onChange={event=>{setModel(event.target.value);setSelectionVersion(value=>value+1);}} required maxLength={128} spellCheck={false} autoCapitalize="none" aria-describedby={`${id}-model-help`}/></label>
        {selected.suggestedModels.length?<datalist id={`${id}-models`}>{selected.suggestedModels.map(item=><option key={item} value={item}/>)}</datalist>:null}
        <p id={`${id}-model-help`} className="ai-setup-note">Укажите идентификатор модели из аккаунта {selected.label}. Для Grok по умолчанию используется {selected.id==="xai"?selected.defaultModel:"идентификатор из кабинета"}. Проверка не меняет настройки ботов.</p>
        <ConnectionCheck key={selectionVersion} provider={selected} model={model}/>
      </li>
    </ol>
  </section>;
}

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
    <div className="form-pair"><label htmlFor={`${id}-provider`}>AI-провайдер<select id={`${id}-provider`} name="provider" value={provider} onChange={e=>{const next=providers.find(item=>item.id===e.target.value)!;setProvider(next.id);setModel(next.defaultModel);}}>{providers.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label htmlFor={`${id}-model`}>Модель<input id={`${id}-model`} name="model" list={`${id}-models`} value={model} onChange={e=>setModel(e.target.value)} required maxLength={128} spellCheck={false} autoCapitalize="none"/></label></div>
    {selected.suggestedModels.length?<datalist id={`${id}-models`}>{selected.suggestedModels.map(item=><option key={item} value={item}/>)}</datalist>:null}
    <p className="detail-note">Используйте идентификатор модели, доступной в аккаунте выбранного провайдера. Для xAI · Grok текущая модель по умолчанию — {selected.id==="xai"?selected.defaultModel:"указанная в кабинете"}.</p>
    <label htmlFor={`${id}-instructions`}>Инструкции боту<textarea id={`${id}-instructions`} name="systemPrompt" value={instructions} onChange={e=>setInstructions(e.target.value)} rows={5} maxLength={5000} placeholder="Какие задачи решает бот, каким должен быть ответ и что необходимо учитывать"/></label>
    <label className="check-label"><input type="checkbox" name="enabled" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>Включить бота</label>
    <p className={`ai-connection ${!enabled?"disabled":selected.configured?"ready":"missing"}`} role="status">{!enabled?"Бот выключен.":selected.configured?"Ключ провайдера настроен. Доступ к модели можно проверить в помощнике подключения выше.":"Нужен ключ провайдера. Настройки бота можно сохранить, но запросы пока недоступны."}</p>
    {state.error?<p className="form-error" role="alert">{state.error} Введённые настройки остаются в форме.</p>:null}
    <SubmitButton disabled={pending}>{bot?"Сохранить настройки":"Создать бота"}</SubmitButton>
  </form>;
}

export function AiSettings({data}:{data:Settings}) {
  return <section className="ai-settings" aria-labelledby="ai-settings-title">
    <h2 id="ai-settings-title">AI-боты</h2>
    <p>Настройте исполнителей для задач и обсуждений. При запуске содержание задачи или выбранного чата передаётся AI-провайдеру. Результат задачи ждёт проверки руководителя.</p>
    <div className="ai-provider-status">{data.providers.map(provider=><div key={provider.id}><strong>{provider.label}</strong><span className={`ai-badge ${provider.configured?"ready":"missing"}`}>{provider.configured?"Ключ настроен":"Нужен ключ"}</span></div>)}</div>
    <ConnectionGuide providers={data.providers}/>
    <div className="ai-bot-settings-list">{data.bots.map(bot=><details className="ai-bot-settings" key={bot.memberId}><summary><span><strong>{bot.name}</strong><small>{bot.model}</small></span><span className={`ai-badge ${!bot.enabled?"disabled":bot.ready?"ready":"missing"}`}>{!bot.enabled?"Выключен":!bot.configured?"Нужен ключ":bot.ready?"Ключ настроен":"Нужно настроить"}</span></summary>{bot.enabled&&!bot.ready&&bot.disabledReason?<p className="ai-connection missing">{bot.disabledReason}</p>:null}<BotForm bot={bot} providers={data.providers}/></details>)}</div>
    <details className="ai-bot-settings ai-create"><summary>Создать AI-бота</summary><BotForm providers={data.providers}/></details>
  </section>;
}
