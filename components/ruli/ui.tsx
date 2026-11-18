import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, PersonIcon, BotIcon } from "./icons";
import type { Member, TaskStatus } from "@/lib/ruli/model";
import { STATUS_NAMES } from "@/lib/ruli/model";
import { ParticipantPopover } from "./participant-popover";
export function Avatar({member,className=""}:{member:Member;className?:string}) {
  return <span className={`avatar ${member.color} ${className}`.trim()} aria-hidden="true">{member.initials}</span>;
}
export function OwnerChip({member,full=false}:{member:Member;full?:boolean}) {
  return <span className="owner"><Avatar member={member}/><span className="owner-name">{full?member.name:member.shortName}{member.type==="bot"?<span className="owner-type">AI</span>:null}</span></span>;
}
export function StateChip({className,label}:{className:string;label:string}) {return <span className={`state-chip ${className}`}>{label}</span>;}
export function TaskStatusChip({status}:{status:TaskStatus}) {return <StateChip className={status} label={STATUS_NAMES[status]}/>;}
export function ParticipantCounters({human,bot,title,people=[]}:{human:number;bot:number;title:string;people?:Member[]}) {
  return <div className="participant-counters">{(["human","bot"] as const).map(type=>{
    const count=type==="human"?human:bot;
    return <ParticipantPopover key={type} className={`participant-square ${type} ${count?"lit":"unlit"}`} label={`${type==="human"?"Люди":"Боты"}: ${count}. ${title}`}
      summary={<><span>{type==="human"?<PersonIcon/>:<BotIcon/>}</span><strong>{count}</strong></>}>
        <strong>{type==="human"?"Люди":"AI-боты"} в задаче</strong>
        {people.filter(m=>m.type===type).map(member=><div className="member-row" key={member.id}><Avatar member={member}/><span>{member.name}<small>{member.role}</small></span></div>)}
        {!count?<p>Пока не назначены.</p>:null}
        <p className="detail-note">Участники этой задачи и всех подзадач.</p>
        <Link href="/team">Вся команда →</Link>
    </ParticipantPopover>;
  })}</div>;
}
export function ProgressBar({percent,label}:{percent:number;label:string}) {
  return <div className="progress-track" role="progressbar" aria-label={`Прогресс: ${label}`} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><i style={{width:`${Math.min(100,Math.max(0,percent))}%`}}/></div>;
}
export function SignalChip({deadline,review,nested,status}:{deadline:ReactNode;review:number;nested:boolean;status:TaskStatus|null}) {
  return <span className="task-signals">{deadline}{review>0&&nested?<StateChip className="review" label={`${review} на проверке`}/>:null}{!nested&&status?<TaskStatusChip status={status}/>:null}</span>;
}
export function SparkIcon(){return <Icon name="spark"/>;}

