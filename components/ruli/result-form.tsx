"use client";
import {useActionState,useState} from "react";
import {submitResultState} from "@/app/actions";
import type {ActionState} from "@/lib/ruli/action-state";
import type {TaskNode,ViewMode} from "@/lib/ruli/model";
import {SubmitButton} from "./submit-button";
export function ResultForm({node,mode}:{node:TaskNode;mode:ViewMode}) {
  const [state,action]=useActionState<ActionState,FormData>(submitResultState,{});
  const [body,setBody]=useState(node.result??"");
  return <form className="result-form" action={action}>
    <input type="hidden" name="id" value={node.id}/><input type="hidden" name="version" value={node.version}/><input type="hidden" name="expectedStatus" value={node.status??"todo"}/><input type="hidden" name="mode" value={mode}/>
    <label htmlFor="task-result">Результат работы</label>
    <textarea id="task-result" name="result" rows={6} required maxLength={5000} value={body} onChange={e=>setBody(e.target.value)} placeholder="Что сделано? Добавьте итоговый текст и ссылки."/>
    {state.error?<p className="form-error" role="alert">{state.error} Текст остаётся в форме.</p>:null}
    <div className="detail-actions"><SubmitButton>Отправить на проверку</SubmitButton></div>
  </form>;
}

