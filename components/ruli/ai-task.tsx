"use client";

import {useActionState,useEffect,useRef} from "react";
import {runTaskAiState,retryAiChatState} from "@/app/ai-actions";
import type {ActionState} from "@/lib/ruli/action-state";
import type {AiRunSummary,loadTaskAi,TaskBot} from "@/lib/ruli/ai";
import {SubmitButton} from "./submit-button";

type TaskAiData=Awaited<ReturnType<typeof loadTaskAi>>;
const statusNames={pending:"Выполняется",succeeded:"Готово",failed:"Ошибка",stale:"Задача изменилась"};
function runTime(value:number|string) {const date=new Date(value);return Number.isNaN(date.getTime())?String(value):new Intl.DateTimeFormat("ru-RU",{dateStyle:"short",timeStyle:"short",timeZone:"Asia/Barnaul"}).format(date);}

function RunFeedback({state,pending}:{state:ActionState;pending:boolean}) {
  if(pending)return <p className="ai-run-status" role="status">AI выполняет запрос. Обычно это занимает до 45 секунд.</p>;
  if(state.error)return <p className="form-error" role="alert">{state.error}</p>;
  return state.notice?<p className={state.aiStatus==="failed"?"form-error":"ai-run-status"} role={state.aiStatus==="failed"?"alert":"status"}>{state.notice}</p>:null;
}

function TaskRunForm({taskId,version,bot,clientId,disabled}:{taskId:string;version:number;bot:TaskBot;clientId:string;disabled:boolean}) {
  const requestId=useRef(clientId);
  const [state,action,pending]=useActionState<ActionState,FormData>(async(previous,form)=>{
    form.set("clientId",requestId.current);
    const next=await runTaskAiState(previous,form);
    if(next.aiStatus&&next.aiStatus!=="pending")requestId.current=crypto.randomUUID();
    return next;
  },{});
  useEffect(()=>{if(state.aiStatus==="succeeded"||state.aiStatus==="stale")window.location.reload();},[state.aiStatus]);
  return <form action={action}>
    <input type="hidden" name="taskId" value={taskId}/><input type="hidden" name="version" value={version}/><input type="hidden" name="botMemberId" value={bot.memberId}/><input type="hidden" name="clientId" value={clientId}/>
    <SubmitButton disabled={disabled||pending} pendingLabel="AI выполняет задачу…">{state.aiStatus==="failed"?"Повторить выполнение с AI":"Выполнить с AI"}</SubmitButton>
    <RunFeedback state={state} pending={pending}/>
  </form>;
}

export function AiRunHistory({runs}:{runs:AiRunSummary[]}) {
  return runs.length?<details className="ai-run-history"><summary>История запусков · {runs.length}</summary><ol>{runs.map(run=><li key={run.id}><div className="ai-run-heading"><strong>{statusNames[run.status]}</strong><time>{runTime(run.createdAt)}</time></div>{run.error?<p className="ai-run-error">{run.error}</p>:null}{run.status==="stale"?<p>Задача изменилась во время запроса. Ответ сохранён в истории и не заменил результат задачи.</p>:null}{run.output?<details><summary>Посмотреть ответ</summary><div className="ai-run-output">{run.output}</div></details>:null}</li>)}</ol></details>:null;
}

export function TaskAiPanel({taskId,version,data,manager,clientId}:{taskId:string;version:number;data:TaskAiData;manager:boolean;clientId:string}) {
  const {bot}=data;
  if(!bot)return null;
  const active=data.runs.some(run=>run.status==="pending");
  return <section className="task-ai" aria-labelledby="task-ai-title"><h3 id="task-ai-title">Выполнить с AI</h3><p><strong>{bot.name}</strong> · {bot.provider==="xai"?"xAI · Grok":"OpenAI"} · {bot.model}</p><p>Название, описание и общая переписка задачи будут переданы выбранному AI-провайдеру. Ответ появится в результате со статусом «На проверке». Только руководитель принимает работу.</p>
    {data.disabledReason?<p className="ai-connection">{data.disabledReason}{manager&&!bot.ready?<> <a href="/team#ai-settings-title">Настроить бота</a></>:null}</p>:null}
    {active?<p className="ai-run-status" role="status">AI выполняет задачу. <a href={`/t/${encodeURIComponent(taskId)}`}>Обновить результат</a></p>:null}
    {data.canRun?<TaskRunForm taskId={taskId} version={version} bot={bot} clientId={clientId} disabled={!bot.ready||active}/>:null}
    <AiRunHistory runs={data.runs}/>
  </section>;
}

type RetryRun=Pick<AiRunSummary,"id"|"botMemberId"|"channelMemberId"|"inputMessageId"|"error">;
export function AiChatRetry({taskId,run,clientId}:{taskId:string;run:RetryRun;clientId:string}) {
  const requestId=useRef(`${clientId}-${run.id}`);
  const [state,action,pending]=useActionState<ActionState,FormData>(async(previous,form)=>{
    form.set("clientId",requestId.current);
    const next=await retryAiChatState(previous,form);
    if(next.aiStatus&&next.aiStatus!=="pending")requestId.current=crypto.randomUUID();
    return next;
  },{});
  useEffect(()=>{if(state.aiStatus==="succeeded")window.location.reload();},[state.aiStatus]);
  return <div className="ai-chat-retry"><p className="ai-run-error">Ответ AI не получен. {run.error}</p><form action={action}><input type="hidden" name="taskId" value={taskId}/><input type="hidden" name="runId" value={run.id}/><input type="hidden" name="botMemberId" value={run.botMemberId}/><input type="hidden" name="channelMemberId" value={run.channelMemberId??""}/><input type="hidden" name="inputMessageId" value={run.inputMessageId??""}/><input type="hidden" name="clientId" value={clientId}/><SubmitButton className="secondary" disabled={pending} pendingLabel="AI готовит ответ…">Повторить ответ AI</SubmitButton><RunFeedback state={state} pending={pending}/></form><small>Повторяется только запрос боту. Ваше сообщение не будет отправлено ещё раз.</small></div>;
}
