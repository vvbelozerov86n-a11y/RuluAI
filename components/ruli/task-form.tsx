"use client";
import { useActionState, useState } from "react";
import Link from "next/link";
import { createTaskState, updateTaskState, deleteTask } from "@/app/actions";
import type { ActionState } from "@/lib/ruli/action-state";
import { BLOCK_SIZES, BLOCK_THEMES, PRIORITY_NAMES, ROOT_ID, taskHref, type Member, type TaskNode, type TaskPriority, type ViewMode } from "@/lib/ruli/model";
import { Avatar } from "./ui";
import { SubmitButton } from "./submit-button";
import "./task-form.css";

export function TaskForm({kind,node,parentId=ROOT_ID,parentTitle,members,mode,parentVersion=0}:{kind:"create"|"edit";node?:TaskNode;parentId?:string;parentTitle?:string;members:Member[];mode:ViewMode;parentVersion?:number;today?:string}) {
  const isCreate=kind==="create";
  const [state, action, pending]=useActionState<ActionState,FormData>(isCreate?createTaskState:updateTaskState,{});
  const [title,setTitle]=useState(node?.title??"");
  const [owner,setOwner]=useState(node?.ownerId??members.find(m=>m.id==="me")?.id??members[0]?.id??"");
  const [due,setDue]=useState(node?.dueDate??"");
  const [priority,setPriority]=useState<TaskPriority|"">(node?.priority??"");
  const [description,setDescription]=useState(node?.description??"");
  const [size,setSize]=useState(node?.size??"small");
  const [theme,setTheme]=useState(node?.theme??"teal");
  const [participants,setParticipants]=useState<string[]>(node?.participants??[]);
  const [nested,setNested]=useState(false);
  const [confirmDelete,setConfirmDelete]=useState(false);
  const isGroup=isCreate?nested:node?.kind==="group";
  const back=taskHref(isCreate?parentId:node?.id??parentId,mode);
  const backLabel=isCreate
    ? parentId===ROOT_ID?"Ко всем задачам":parentTitle?`К «${parentTitle}»`:"К группе задач"
    : isGroup?"К группе задач":"К задаче";
  const additionalParticipants=participants.filter(id=>id!==owner).length;
  const creationContext=parentId===ROOT_ID
    ? `${isGroup?"Группа":"Задача"} появится на верхнем уровне.`
    : `${isGroup?"Группа":"Задача"} появится внутри «${parentTitle||"родительской группы"}».`;
  return <div className="editor-page task-editor">
    <div className="editor-topline"><Link className="editor-back" href={back}>← {backLabel}</Link><span className="editor-eyebrow">{isCreate?"СОЗДАНИЕ":"ИЗМЕНЕНИЕ"} {isGroup?"ГРУППЫ ЗАДАЧ":"ЗАДАЧИ"}</span></div>
    <div className="editor-panel">
      <h1>{isCreate?isGroup?"Новая группа задач":"Новая задача":node?.title}</h1>
      <p>{isCreate?creationContext:"Изменения будут видны участникам команды."}</p>
      {state.error?<div className="form-error" role="alert"><p>{state.error}</p><p>Введённый текст сохранён в форме. При конфликте скопируйте нужные изменения и <a href={isCreate?`/new?parent=${parentId}&mode=${mode}`:`/t/${node?.id}/edit?mode=${mode}`}>откройте актуальную версию</a>.</p></div>:null}
      <form action={action}>
        <input type="hidden" name={isCreate?"parent":"id"} value={isCreate?parentId:node?.id}/>
        <input type="hidden" name={isCreate?"parentVersion":"version"} value={isCreate?parentVersion:node?.version}/>
        <input type="hidden" name="mode" value={mode}/>
        {isCreate?<fieldset className="task-type-options">
          <legend>Что создаём</legend>
          <div>
            <label className="task-type-choice">
              <input type="radio" name="taskKind" value="task" checked={!nested} onChange={()=>setNested(false)}/>
              <span><strong>Задача</strong><small>Один результат, который ответственный передаст на проверку.</small></span>
            </label>
            <label className="task-type-choice">
              <input type="radio" name="taskKind" value="group" checked={nested} onChange={()=>setNested(true)}/>
              <span><strong>Группа задач</strong><small>Общая цель с подзадачами. Их можно добавить после создания.</small></span>
            </label>
          </div>
          {nested?<input type="hidden" name="nested" value="on"/>:null}
        </fieldset>:null}
        <label>Название<input name="title" required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} placeholder={isGroup?"Какова общая цель?":"Какой результат нужен?"}/></label>
        <label>Описание<textarea name="description" rows={4} maxLength={2000} value={description} onChange={e=>setDescription(e.target.value)} placeholder={isGroup?"Общая цель и ожидаемые результаты подзадач":"Что нужно сделать и какой результат ожидается"}/></label>
        <div className="form-pair">
          <label>Ответственный<select name="owner" value={owner} onChange={e=>setOwner(e.target.value)}>{members.map(m=><option key={m.id} value={m.id}>{m.name}{m.type==="bot"?" · бот":""}</option>)}</select></label>
          <label>Срок <span className="task-field-hint">необязательно</span><input type="date" name="due" value={due} onChange={e=>setDue(e.target.value)}/></label>
        </div>
        <label>Приоритет <span className="task-field-hint">необязательно</span><select name="priority" value={priority} onChange={e=>setPriority((e.target.value||"") as TaskPriority|"")}>
          <option value="">Не указан</option>
          {(Object.keys(PRIORITY_NAMES) as TaskPriority[]).map(id=><option key={id} value={id}>{PRIORITY_NAMES[id]}</option>)}
        </select></label>
        <details className="task-form-extra">
          <summary>Участники <span>{additionalParticipants?`${additionalParticipants} дополнительно`:"Только ответственный"}</span></summary>
          <p>Ответственный участвует автоматически. Добавьте тех, кто помогает выполнить задачу.</p>
          <fieldset className="member-options"><legend className="sr-only">Участники {isGroup?"группы задач":"задачи"}</legend><div>{members.map(m=><label key={m.id} className="member-choice">
            <input type="checkbox" name="participants" value={m.id} checked={m.id===owner||participants.includes(m.id)} disabled={m.id===owner} onChange={e=>setParticipants(p=>e.target.checked?[...p,m.id]:p.filter(id=>id!==m.id))}/><Avatar member={m}/><span>{m.name}{m.type==="bot"?<small>бот</small>:null}</span>
          </label>)}</div></fieldset>
        </details>
        <details className="task-form-extra">
          <summary>Оформление <span>{BLOCK_SIZES[size].label} · {BLOCK_THEMES[theme]}</span></summary>
          <p>Форму и цвет карточки можно изменить в любое время.</p>
          <fieldset className="size-options"><legend>Форма карточки</legend>{Object.entries(BLOCK_SIZES).map(([id,s])=><label key={id}><input type="radio" name="size" value={id} checked={size===id} onChange={()=>setSize(id as typeof size)}/><span><i className={`size-preview ${id}`}/>{s.label}</span></label>)}</fieldset>
          <fieldset className="theme-options"><legend>Цвет карточки</legend>{Object.entries(BLOCK_THEMES).map(([id,name])=><label key={id} title={name}><input type="radio" name="theme" value={id} checked={theme===id} onChange={()=>setTheme(id as typeof theme)}/><span className={`theme-swatch theme-${id}`}/><span className="sr-only">{name}</span></label>)}</fieldset>
        </details>
        <p className="detail-note">{isGroup?"Группа задач сохранится":"Задача сохранится"} для всей команды.</p>
        <div className="dialog-actions"><SubmitButton disabled={pending}>{isCreate?isGroup?"Создать группу задач":"Создать задачу":"Сохранить изменения"}</SubmitButton><Link className="secondary" href={back}>Отмена</Link></div>
      </form>
      {!isCreate&&node&&node.id!==ROOT_ID?<div className="delete-area">
        {!confirmDelete?<button className="remove-button" type="button" onClick={()=>setConfirmDelete(true)}>Переместить в корзину</button>:<div className="delete-confirm" role="alert">
          <h2>Удалить «{node.title}»?</h2><p>{isGroup?"Группа и все её задачи попадут в корзину. Их можно будет восстановить.":"Задача попадёт в корзину. Её можно будет восстановить."}</p>
          <form action={deleteTask}><input type="hidden" name="id" value={node.id}/><input type="hidden" name="version" value={node.version}/><input type="hidden" name="mode" value={mode}/><div className="dialog-actions"><SubmitButton className="danger-button">Да, в корзину</SubmitButton><button type="button" className="secondary" onClick={()=>setConfirmDelete(false)}>Оставить {isGroup?"группу":"задачу"}</button></div></form>
        </div>}
      </div>:null}
    </div>
  </div>;
}


