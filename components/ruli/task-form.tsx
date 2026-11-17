"use client";
import { useActionState, useState } from "react";
import Link from "next/link";
import { createTaskState, updateTaskState, deleteTask } from "@/app/actions";
import type { ActionState } from "@/lib/ruli/action-state";
import { BLOCK_SIZES, BLOCK_THEMES, ROOT_ID, taskHref, type Member, type TaskNode, type ViewMode } from "@/lib/ruli/model";
import { Avatar } from "./ui";
import { SubmitButton } from "./submit-button";

export function TaskForm({kind,node,parentId=ROOT_ID,parentTitle,members,mode,parentVersion=0}:{kind:"create"|"edit";node?:TaskNode;parentId?:string;parentTitle?:string;members:Member[];mode:ViewMode;parentVersion?:number;today?:string}) {
  const isCreate=kind==="create";
  const [state, action, pending]=useActionState<ActionState,FormData>(isCreate?createTaskState:updateTaskState,{});
  const [title,setTitle]=useState(node?.title??"");
  const [owner,setOwner]=useState(node?.ownerId??members.find(m=>m.id==="me")?.id??members[0]?.id??"");
  const [due,setDue]=useState(node?.dueDate??"");
  const [description,setDescription]=useState(node?.description??"");
  const [size,setSize]=useState(node?.size??"small");
  const [theme,setTheme]=useState(node?.theme??"teal");
  const [participants,setParticipants]=useState<string[]>(node?.participants??[]);
  const [nested,setNested]=useState(false);
  const [confirmDelete,setConfirmDelete]=useState(false);
  const back=taskHref(node?.id??parentId,mode);
  return <div className="editor-page">
    <div className="editor-topline"><Link className="editor-back" href={back}>← {node?"К блоку":`К ${parentTitle||"задачам"}`}</Link><span className="editor-eyebrow">{isCreate?"НОВЫЙ БЛОК":"НАСТРОЙКА БЛОКА"}</span></div>
    <div className="editor-panel">
      <h1>{isCreate?"Новая задача":node?.title}</h1>
      <p>{isCreate?`Блок появится внутри «${parentTitle}».`:"Изменения будут видны участникам команды."}</p>
      {state.error?<div className="form-error" role="alert"><p>{state.error}</p><p>Введённый текст сохранён в форме. При конфликте скопируйте нужные изменения и <a href={isCreate?`/new?parent=${parentId}&mode=${mode}`:`/t/${node?.id}/edit?mode=${mode}`}>откройте актуальную версию</a>.</p></div>:null}
      <form action={action}>
        <input type="hidden" name={isCreate?"parent":"id"} value={isCreate?parentId:node?.id}/>
        <input type="hidden" name={isCreate?"parentVersion":"version"} value={isCreate?parentVersion:node?.version}/>
        <input type="hidden" name="mode" value={mode}/>
        <label>Название<input name="title" required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} placeholder="Какой результат нужен?" autoFocus/></label>
        <div className="form-pair">
          <label>Ответственный<select name="owner" value={owner} onChange={e=>setOwner(e.target.value)}>{members.map(m=><option key={m.id} value={m.id}>{m.name}{m.type==="bot"?" · AI":""}</option>)}</select></label>
          <label>Срок<input type="date" name="due" value={due} onChange={e=>setDue(e.target.value)}/></label>
        </div>
        <fieldset className="size-options"><legend>Форма блока</legend>{Object.entries(BLOCK_SIZES).map(([id,s])=><label key={id}><input type="radio" name="size" value={id} checked={size===id} onChange={()=>setSize(id as typeof size)}/><span><i className={`size-preview ${id}`}/>{s.label}</span></label>)}</fieldset>
        <fieldset className="theme-options"><legend>Цвет блока</legend>{Object.entries(BLOCK_THEMES).map(([id,name])=><label key={id} title={name}><input type="radio" name="theme" value={id} checked={theme===id} onChange={()=>setTheme(id as typeof theme)}/><span className={`theme-swatch theme-${id}`}/><span className="sr-only">{name}</span></label>)}</fieldset>
        <fieldset className="member-options"><legend>Участники этого блока</legend><div>{members.map(m=><label key={m.id} className="member-choice">
          <input type="checkbox" name="participants" value={m.id} checked={m.id===owner||participants.includes(m.id)} disabled={m.id===owner} onChange={e=>setParticipants(p=>e.target.checked?[...p,m.id]:p.filter(id=>id!==m.id))}/><Avatar member={m}/><span>{m.name}{m.type==="bot"?<small>AI</small>:null}</span>
        </label>)}</div></fieldset>
        <label>Описание<textarea name="description" rows={5} maxLength={2000} value={description} onChange={e=>setDescription(e.target.value)} placeholder="Что нужно сделать и какой результат ожидается"/></label>
        {isCreate?<label className="check-label"><input type="checkbox" name="nested" checked={nested} onChange={e=>setNested(e.target.checked)}/>Внутри будут подзадачи</label>:null}
        <p className="detail-note">Ответственный входит в состав участников. Задача сохранится для всей команды.</p>
        <div className="dialog-actions"><SubmitButton disabled={pending}>{isCreate?"Создать блок":"Сохранить"}</SubmitButton><Link className="secondary" href={back}>Отмена</Link></div>
      </form>
      {!isCreate&&node&&node.id!==ROOT_ID?<div className="delete-area">
        {!confirmDelete?<button className="remove-button" type="button" onClick={()=>setConfirmDelete(true)}>Переместить в корзину</button>:<div className="delete-confirm" role="alert">
          <h2>Удалить «{node.title}»?</h2><p>Задача и все вложенные подзадачи попадут в корзину. Их можно будет восстановить.</p>
          <form action={deleteTask}><input type="hidden" name="id" value={node.id}/><input type="hidden" name="version" value={node.version}/><input type="hidden" name="mode" value={mode}/><div className="dialog-actions"><SubmitButton className="danger-button">Да, в корзину</SubmitButton><button type="button" className="secondary" onClick={()=>setConfirmDelete(false)}>Оставить задачу</button></div></form>
        </div>}
      </div>:null}
    </div>
  </div>;
}


