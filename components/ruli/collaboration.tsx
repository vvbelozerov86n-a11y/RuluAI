import Link from "next/link";
import { loadTaskCollaboration } from "@/lib/ruli/collaboration";
import { generateTaskSchedule, updateScheduleEntry, clearTaskSchedule } from "@/app/collaboration-actions";
import { canManage, type AccessContext } from "@/lib/ruli/access";
import { taskHref, todayISO, plural, type TaskNode, type Member, type ViewMode } from "@/lib/ruli/model";
import { SubmitButton } from "./submit-button";
import { MessageComposer } from "./message-composer";
import { MessageFeed } from "./message-feed";
import {loadTaskAi} from "@/lib/ruli/ai";
import { Bot, LockKeyhole, MessageSquare, ShieldCheck } from "lucide-react";
import { ChatChannels, type ChatChannelItem } from "./chat-channels";
import "./chat.css";

function dayNumber(value:string) {return Date.parse(value+"T12:00:00Z")/86400000;}
function shortDate(value:string) {return new Intl.DateTimeFormat("ru-RU",{day:"numeric",month:"short",timeZone:"Asia/Barnaul"}).format(new Date(value+"T12:00:00Z"));}

export async function TaskCollaboration({node,members,viewer,channel,mode="view"}:{node:TaskNode;members:Member[];viewer:AccessContext;channel?:string;mode?:ViewMode}) {
  let selected=channel&&channel!=="general"?channel:undefined;
  let data=await loadTaskCollaboration(node,viewer,selected);
  const unavailable=Boolean(selected&&!data.channels.some(m=>m.id===selected));
  if(unavailable){selected=undefined;data=await loadTaskCollaboration(node,viewer);}
  const ai=await loadTaskAi(node,viewer,selected);
  const chatAiRuns=ai.chatRuns.map(({id,botMemberId,channelMemberId,inputMessageId,error,status,canRetry,createdAt,finishedAt})=>({
    id,botMemberId,channelMemberId,inputMessageId,error,status,canRetry,createdAt,finishedAt,
  }));
  const messageClientId=crypto.randomUUID();
  const manager=canManage(viewer);
  const selectedMember=data.channels.find(m=>m.id===selected);
  const selectedBot=selectedMember?.type==="bot"?ai.bots.find(bot=>bot.memberId===selected):undefined;
  const ownExecutorChannel=viewer.role==="executor"&&selectedMember?.id===viewer.memberId;
  const chatTitle=ownExecutorChannel?"С руководителем":selectedMember?.name??"Общий чат";
  const providerName=(provider:string)=>provider==="xai"?"xAI · Grok":provider==="openai"?"OpenAI":provider==="grok-bot"?"Grok Bot":"AI-провайдер";
  const configuration=(bot:typeof selectedBot):ChatChannelItem["configuration"]=>!bot?{label:"Нужна настройка",state:"missing"}:!bot.enabled?{label:"Выключен",state:"disabled"}:!bot.configured?{label:bot.kind==="agent"?"Нет подключения":"Нужен ключ",state:"missing"}:!bot.ready?{label:"Недоступен",state:"disabled"}:{label:"Настроен",state:"ready"};
  const selectedConfiguration=selectedMember?.type==="bot"?configuration(selectedBot):undefined;
  const memberMap=new Map(members.map(m=>[m.id,m]));
  const chatHref=(id?:string)=>taskHref(node.id,mode)+"&chat="+encodeURIComponent(id??"general")+"#collaboration";
  const channels:ChatChannelItem[]=data.channels.map(member=>{
    const bot=member.type==="bot"?ai.bots.find(item=>item.memberId===member.id):undefined;
    return {id:member.id,name:member.name,label:viewer.role==="executor"&&member.id===viewer.memberId?"С руководителем":member.name,
      description:member.type==="bot"?providerName(bot?.provider??""):viewer.role==="executor"&&member.id===viewer.memberId?"Личный диалог":member.role||"Личный диалог",initials:member.initials,color:member.color,type:member.type,href:chatHref(member.id),
      configuration:member.type==="bot"?configuration(bot):undefined};
  });
  const begin=data.entries.length?Math.min(...data.entries.map(e=>dayNumber(e.startDate))):0;
  const finish=data.entries.length?Math.max(...data.entries.map(e=>dayNumber(e.endDate))):begin;
  const span=Math.max(1,finish-begin+1);
  const totalHours=data.entries.reduce((sum,e)=>sum+e.hours,0);
  const groups=new Map<string,typeof data.entries>();
  for(const entry of data.entries){const rows=groups.get(entry.memberId)??[];rows.push(entry);groups.set(entry.memberId,rows);}
  return <section className="collaboration" id="collaboration" aria-label="Обсуждение и график выполнения">
    <div className="collaboration-context">
      <div className="collaboration-context-title"><span>Текущая задача</span><a href="#task-title">{node.title}</a></div>
      <nav aria-label="Перейти к разделу совместной работы"><a href="#discussion">К обсуждению ↓</a><a href="#schedule">К графику ↓</a></nav>
      <p>Открыт чат: <strong>{selectedMember?`личный · ${chatTitle}`:"общий"}</strong></p>
    </div>
    <section className="collaboration-panel chat-workspace" id="discussion" aria-labelledby="discussion-title">
      <ChatChannels key={`channels:${node.id}:${selected??"general"}`} channels={channels} selectedId={selected} generalHref={chatHref()}/>
      <div className="chat-thread">
        <header className="chat-thread-header">
          <span className={`chat-thread-avatar ${selectedMember?.type??"general"}`} data-color={selectedMember?.color} aria-hidden="true">{selectedMember?.type==="bot"?<Bot/>:selectedMember?<span>{ownExecutorChannel?<ShieldCheck/>:selectedMember.initials}</span>:<MessageSquare/>}</span>
          <div className="chat-thread-heading">
            <span className="chat-thread-eyebrow">{selectedMember?"Личный диалог":"Обсуждение задачи"}</span>
            <h2 id="discussion-title">{chatTitle}</h2>
            <p className="chat-privacy">{selectedMember?<LockKeyhole aria-hidden="true"/>:<ShieldCheck aria-hidden="true"/>}<span>{ownExecutorChannel?"Ваш личный диалог с руководителем. Остальные участники его не видят.":selectedMember?`Руководитель и ${selectedMember.name}. Остальные участники не видят этот диалог.`:"Общий чат видит команда с доступом к этой задаче."}</span></p>
            {selectedMember?.type==="bot"?<div className="chat-thread-badges"><span className="chat-provider-badge"><Bot aria-hidden="true"/>{providerName(selectedBot?.provider??"")}{selectedBot?.kind==="llm"?` · ${selectedBot.model}`:""}</span>{selectedConfiguration?<span className={`chat-config-badge ${selectedConfiguration.state}`}>{selectedConfiguration.label}</span>:null}</div>:null}
          </div>
        </header>
        {selectedBot?<details className="chat-provider-disclosure"><summary>Как отвечает AI</summary><p>{selectedBot.kind==="agent"?`Сообщения этого диалога передаются внешнему агенту ${selectedBot.name} через Grok Bot. Его ответ появится здесь после обработки.`:`Сообщение, контекст этой задачи и переписка текущего диалога передаются ${providerName(selectedBot.provider)} (${selectedBot.model}). Ответ создаёт AI.`}</p>{selectedBot.disabledReason?<p>{selectedBot.disabledReason}</p>:null}{manager?<Link href="/team">Настройки команды и AI →</Link>:null}</details>:null}
        {unavailable?<p className="page-notice error chat-notice" role="alert">Этот личный диалог недоступен. Открыт общий чат задачи.</p>:null}
        <div className="chat-thread-body">
          <MessageFeed key={`feed:${viewer.userId}:${node.id}:${selected??"general"}`} taskId={node.id} channelMemberId={selected} viewerMemberId={viewer.memberId} initialMessages={data.messages} initialPage={data.messagePage} members={members} canWrite={viewer.role!=="viewer"} initialAiRuns={chatAiRuns}/>
        </div>
        <div className="chat-compose-area">
          {viewer.role!=="viewer"?<MessageComposer key={`composer:${viewer.userId}:${node.id}:${selected??"general"}`} taskId={node.id} channelMemberId={selected} viewerUserId={viewer.userId} clientId={messageClientId} mode={mode} bots={ai.bots} privateBot={selectedBot}/>:<p className="chat-read-only"><LockKeyhole aria-hidden="true"/>У вас доступ для просмотра обсуждения.</p>}
        </div>
      </div>
    </section>
    <section className="collaboration-panel" id="schedule" aria-labelledby="schedule-title">
      <div className="panel-heading"><div><h2 id="schedule-title">График выполнения</h2><p>{data.entries.length?`${plural(data.entries.length,"рабочий отрезок","рабочих отрезка","рабочих отрезков")} · ${totalHours} ч`:"Распределите работу по датам и загрузке исполнителей."}</p></div></div>
      {manager?<details className="schedule-generator" open={!data.entries.length}>
        <summary>{data.entries.length?"Пересчитать график":"Составить график"}</summary>
        <form action={generateTaskSchedule}>
          <input type="hidden" name="taskId" value={node.id}/><input type="hidden" name="version" value={data.scheduleVersion}/><input type="hidden" name="mode" value={mode}/>
          <div className="schedule-fields">
            <label>Начало<input name="startDate" type="date" defaultValue={todayISO()} required/></label>
            <label>Часов в день на исполнителя<input name="hoursPerDay" type="number" min="1" max="12" step="0.25" defaultValue="6" required/></label>
            <label>Оценка на одно поручение, ч<input name="estimatedHoursPerTask" type="number" min="0.25" max="240" step="0.25" defaultValue="4" required/></label>
          </div>
          <label className="check-label"><input name="weekdaysOnly" type="checkbox" defaultChecked/>Только будние дни</label>
          <p className="detail-note">План строится по поручениям этой ветки. Оценку и даты можно уточнить после расчёта.</p>
          {data.entries.length?<label className="check-label"><input name="replaceConfirmed" type="checkbox" required/>Заменить текущий график и ручные правки новым расчётом</label>:null}
          <SubmitButton>{data.entries.length?"Пересчитать график":"Построить график"}</SubmitButton>
        </form>
      </details>:null}
      {manager&&data.entries.length?<details className="schedule-clear"><summary>Удалить график</summary>
        <p>Текущий график и ручные правки будут удалены. Задачи и переписка останутся. После удаления можно построить новый график здесь или в общей задаче выше.</p>
        <form action={clearTaskSchedule}><input type="hidden" name="taskId" value={node.id}/><input type="hidden" name="version" value={data.scheduleVersion}/><input type="hidden" name="mode" value={mode}/>
          <label className="check-label"><input type="checkbox" name="confirmClear" value="yes" required/>Подтверждаю удаление графика и его ручных правок</label>
          <SubmitButton className="danger-button" pendingLabel="Удаляем…">Удалить график</SubmitButton>
        </form>
      </details>:null}
      {data.entries.length?<div className="schedule-view">
        <div className="timeline-range"><span>{shortDate(data.entries.reduce((a,e)=>e.startDate<a?e.startDate:a,data.entries[0].startDate))}</span><span>{shortDate(data.entries.reduce((a,e)=>e.endDate>a?e.endDate:a,data.entries[0].endDate))}</span></div>
        <div className="schedule-groups">{[...groups].map(([memberId,entries],index)=><details className="schedule-person" key={memberId} open={index===0}><summary>{memberMap.get(memberId)?.name??"Не назначен"}<span>{plural(entries.length,"отрезок","отрезка","отрезков")} · {entries.reduce((sum,e)=>sum+e.hours,0)} ч</span></summary>
        <ol className="schedule-rows">{entries.map(entry=><li key={entry.id} className="schedule-row">
          <div className="schedule-row-head"><div><Link href={taskHref(entry.taskId,mode)}>{entry.title}</Link><small>{memberMap.get(entry.memberId)?.name??"Не назначен"}</small></div><span>{shortDate(entry.startDate)}{entry.endDate!==entry.startDate?" — "+shortDate(entry.endDate):""} · {entry.hours} ч</span></div>
          <div className="timeline-track" role="img" aria-label={`${entry.title}: ${entry.startDate} — ${entry.endDate}, ${entry.hours} часов`}><span style={{marginLeft:`${Math.max(0,(dayNumber(entry.startDate)-begin)/span*100)}%`,width:`${(dayNumber(entry.endDate)-dayNumber(entry.startDate)+1)/span*100}%`}}/></div>
          {manager?<details className="schedule-edit"><summary>Изменить даты и часы</summary><form action={updateScheduleEntry}>
            <input type="hidden" name="id" value={entry.id}/><input type="hidden" name="taskId" value={node.id}/><input type="hidden" name="version" value={entry.version}/><input type="hidden" name="planVersion" value={data.scheduleVersion}/><input type="hidden" name="mode" value={mode}/>
            <div className="schedule-fields"><label>Начало<input name="startDate" type="date" defaultValue={entry.startDate} required/></label><label>Окончание<input name="endDate" type="date" defaultValue={entry.endDate} required/></label><label>Часы<input name="hours" type="number" min="0.25" step="0.25" defaultValue={entry.hours} required/></label></div><SubmitButton>Сохранить отрезок</SubmitButton>
          </form></details>:null}
        </li>)}</ol></details>)}</div>
      </div>:<p className="empty-copy">График ещё не составлен.{manager?" Задайте начало и оценку длительности выше.":" Руководитель может составить план для команды."}</p>}
    </section>
  </section>;
}

