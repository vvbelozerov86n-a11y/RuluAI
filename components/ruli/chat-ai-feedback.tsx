"use client";
import type {ChatAiRun} from "@/lib/ruli/collaboration";
import type {Member} from "@/lib/ruli/model";
import {AiChatRetry} from "./ai-task";
import {MessageContent} from "./message-content";

export function ChatAiFeedback({taskId,runs,members,canWrite}:{taskId:string;runs:ChatAiRun[];members:Member[];canWrite:boolean}) {
  const visible=runs.filter(run=>run.status==="stale"||(run.status==="failed"&&run.canRetry&&canWrite));
  if(!visible.length)return null;
  return <section className="chat-ai-retries" aria-label="Сохранённые ответы и повторные запросы AI">{visible.map(run=>run.status==="stale"?
    <article className="chat-ai-saved" key={run.id}>
      <h3>{members.find(member=>member.id===run.botMemberId)?.name??"AI"}: ответ сохранён отдельно</h3>
      <p>Во время ответа задача или настройки изменились. Этот текст не опубликован как актуальный ответ в переписке.</p>
      {run.output?<details><summary>Посмотреть сохранённый ответ</summary><div className="chat-ai-output"><MessageContent body={run.output}/></div></details>:null}
      {run.canRetry&&canWrite?<AiChatRetry taskId={taskId} run={run} clientId={`retry-${run.id}`}/>:null}
    </article>:<AiChatRetry key={run.id} taskId={taskId} run={run} clientId={`retry-${run.id}`}/>)}</section>;
}
