"use client";
import {useActionState,useState} from "react";
import {sendMessageState} from "@/app/collaboration-actions";
import type {ActionState} from "@/lib/ruli/action-state";
import {SubmitButton} from "./submit-button";
export function MessageComposer({taskId,channelMemberId="",clientId,mode}:{taskId:string;channelMemberId?:string;clientId:string;mode:string}) {
  const [state,action]=useActionState<ActionState,FormData>(sendMessageState,{});
  const [body,setBody]=useState("");
  return <form className="message-form" action={action}>
    <input type="hidden" name="taskId" value={taskId}/><input type="hidden" name="channelMemberId" value={channelMemberId}/><input type="hidden" name="clientId" value={clientId}/><input type="hidden" name="mode" value={mode}/>
    <label htmlFor="message-body">Сообщение</label><textarea id="message-body" name="body" rows={3} required maxLength={5000} value={body} onChange={e=>setBody(e.target.value)} placeholder="Напишите вопрос или зафиксируйте решение"/>
    {state.error?<p className="form-error" role="alert">{state.error} Сообщение остаётся в форме.</p>:null}
    <div className="detail-actions"><SubmitButton pendingLabel="Отправляем…">Отправить</SubmitButton><span className="detail-note">До 5 000 символов</span></div>
  </form>;
}

