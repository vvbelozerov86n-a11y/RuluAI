"use client";
import {useActionState,useState} from "react";
import {updateTaskState} from "@/app/actions";
import type {ActionState} from "@/lib/ruli/action-state";
import {taskHref,type Member,type TaskNode,type ViewMode} from "@/lib/ruli/model";
import {inheritedMembership} from "@/lib/ruli/task-membership";
import {Avatar} from "./ui";
import {SubmitButton} from "./submit-button";
import "./task-assignments.css";

export function TaskAssignments({node,members,mode}:{node:TaskNode;members:Member[];mode:ViewMode}) {
  const [state,action,pending]=useActionState<ActionState,FormData>(updateTaskState,{});
  const [owner,setOwner]=useState(node.ownerId);
  const [participants,setParticipants]=useState(node.participants);
  const assigned=members.filter(member=>member.id===node.ownerId||node.participants.includes(member.id));
  const inherited=inheritedMembership(node);
  const inheritedMembers=members.filter(member=>inherited.has(member.id));
  return <section id="task-team" className="task-assignments" aria-labelledby="task-team-title">
    <div className="task-team-heading"><div><h2 id="task-team-title">Участники задачи</h2><p>Назначьте людей и AI-ботов для работы и общения в этой задаче.</p></div><a href="#discussion">Открыть чаты ↓</a></div>
    <h3 className="task-team-subheading">Назначены непосредственно</h3>
    <div className="task-team-members">{assigned.map(member=><span key={member.id}><Avatar member={member}/><span>{member.name}<small>{member.id===node.ownerId?"Ответственный":member.type==="bot"?"AI-бот":"Участник"}</small></span></span>)}</div>
    {inheritedMembers.length?<section className="task-team-inherited" aria-label="Участники из подзадач"><h3>Участвуют через подзадачи</h3>
      <p>Их личные диалоги доступны и в этой группе. Снятие прямого назначения ниже не убирает участие в подзадачах. Чтобы изменить его, откройте указанные задачи.</p>
      <ul>{inheritedMembers.map(member=><li key={member.id}><strong>{member.name}</strong><span>{inherited.get(member.id)!.map((source,index)=><span key={source.id}>{index?", ":""}<a href={`${taskHref(source.id,mode)}#task-team`}>{source.title}</a></span>)}</span></li>)}</ul>
    </section>:null}
    <details className="task-team-editor">
      <summary>Добавить сотрудников и ботов</summary>
      <form action={action}>
        {Object.entries({id:node.id,version:node.version,mode,title:node.title,description:node.description,due:node.dueDate??"",priority:node.priority??"",size:node.size,theme:node.theme}).map(([name,value])=><input type="hidden" key={name} name={name} value={value}/>)}
        {state.error?<div className="form-error" role="alert">{state.error} <a href={`${taskHref(node.id,mode)}#task-team`}>Открыть актуальную версию</a></div>:null}
        <label className="task-team-owner">Ответственный<select name="owner" value={owner} onChange={event=>setOwner(event.target.value)}>{members.map(member=><option key={member.id} value={member.id}>{member.name}{member.type==="bot"?" · AI-бот":""}</option>)}</select></label>
        <p>Ответственный включён автоматически. Отметьте дополнительных участников непосредственно этой задачи.{inheritedMembers.length?" Флажки не меняют назначения в подзадачах.":""}</p>
        <div className="task-team-options">{(["human","bot"] as const).map(type=><fieldset key={type}><legend>{type==="human"?"Сотрудники":"AI-боты"}</legend>{members.filter(member=>member.type===type).map(member=><label key={member.id}>
          <input type="checkbox" name="participants" value={member.id} checked={member.id===owner||participants.includes(member.id)} disabled={member.id===owner} onChange={event=>setParticipants(current=>event.target.checked?[...current,member.id]:current.filter(id=>id!==member.id))}/><Avatar member={member}/><span>{member.name}<small>{member.role}{inherited.has(member.id)?" · участвует через подзадачи":""}</small></span>
        </label>)}<a href={type==="human"?"/team#register-employee":"/team#create-bot"}>{type==="human"?"Зарегистрировать сотрудника →":"Создать бота →"}</a></fieldset>)}</div>
        <div className="task-team-save"><SubmitButton disabled={pending}>Сохранить участников</SubmitButton><span>Для участников появятся отдельные диалоги в чатах задачи.</span></div>
      </form>
    </details>
  </section>;
}
