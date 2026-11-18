"use client";

import {useActionState,useId,useState} from "react";
import {addTeamMemberState} from "@/app/team-actions";
import type {ActionState} from "@/lib/ruli/action-state";
import type {Member} from "@/lib/ruli/model";
import {SubmitButton} from "./submit-button";

export function TeamRegistration({availableMembers}:{availableMembers:Pick<Member,"id"|"name">[]}) {
  const [state,action,pending]=useActionState<ActionState,FormData>(addTeamMemberState,{});
  const id=useId();
  const field=(key:string,fallback="")=>typeof state.values?.[key]==="string"?state.values[key] as string:fallback;
  const [memberId,setMemberId]=useState(()=>field("memberId"));
  const [name,setName]=useState(()=>field("name"));
  const [email,setEmail]=useState(()=>field("email"));
  const [role,setRole]=useState(()=>field("role","executor"));
  return <form action={action} className="team-registration-form" aria-busy={pending}>
    <label htmlFor={`${id}-member`}>Сотрудник<select id={`${id}-member`} name="memberId" value={memberId} disabled={pending} onChange={event=>{
      const next=event.target.value;setMemberId(next);setName(availableMembers.find(member=>member.id===next)?.name??"");
    }}><option value="">Создать нового сотрудника</option>{availableMembers.map(member=><option key={member.id} value={member.id}>{member.name} — уже в команде</option>)}</select></label>
    <p className="team-field-help">Для существующего сотрудника сохранятся его задачи и переписка. В списке только сотрудники, которым ещё не назначен аккаунт.</p>
    <div className="form-pair">
      <label htmlFor={`${id}-name`}>Имя<input id={`${id}-name`} name="name" required maxLength={120} value={name} onChange={event=>setName(event.target.value)} readOnly={Boolean(memberId)} disabled={pending} autoComplete="off" placeholder="Имя и фамилия"/></label>
      <label htmlFor={`${id}-email`}>Почта для входа<input id={`${id}-email`} name="email" type="email" required maxLength={254} value={email} onChange={event=>setEmail(event.target.value)} disabled={pending} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="name@example.com"/></label>
    </div>
    <label htmlFor={`${id}-role`}>Права<select id={`${id}-role`} name="role" value={role} onChange={event=>setRole(event.target.value)} disabled={pending} aria-describedby={`${id}-role-help`}><option value="executor">Исполнитель</option><option value="viewer">Наблюдатель</option></select></label>
    <p id={`${id}-role-help`} className="team-field-help">Исполнитель работает со своими задачами и пишет в чатах. Наблюдатель может только просматривать.</p>
    {state.error?<p className="form-error" role="alert">{state.error} Введённые данные сохранены в форме.</p>:null}
    <SubmitButton disabled={pending} pendingLabel="Регистрируем…">Зарегистрировать сотрудника</SubmitButton>
  </form>;
}

export function TeamSignInLink({signInPath}:{signInPath:string}) {
  const [status,setStatus]=useState("");
  const [manualLink,setManualLink]=useState("");
  return <div className="team-signin-link">
    <div className="team-signin-actions"><button className="secondary" type="button" onClick={async()=>{
      const link=new URL(signInPath,window.location.origin).href;
      try {await navigator.clipboard.writeText(link);setManualLink("");setStatus("Ссылка скопирована. Передайте её сотруднику.");}
      catch {setManualLink(link);setStatus("Не удалось скопировать автоматически. Выделите ссылку ниже и скопируйте её.");}
    }}>Скопировать ссылку для входа</button><a href={signInPath} target="_blank" rel="noopener noreferrer">Открыть страницу входа <span>(новая вкладка)</span></a></div>
    {status?<p role="status">{status}</p>:null}
    {manualLink?<label>Ссылка для входа<input readOnly value={manualLink} onFocus={event=>event.currentTarget.select()}/></label>:null}
  </div>;
}
