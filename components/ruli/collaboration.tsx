import Link from "next/link";
import { loadTaskCollaboration } from "@/lib/ruli/collaboration";
import { canManage, type AccessContext } from "@/lib/ruli/access";
import { taskHref, type TaskNode, type Member, type ViewMode } from "@/lib/ruli/model";
import { MessageComposer } from "./message-composer";
import { MessageFeed } from "./message-feed";
import {loadTaskAi} from "@/lib/ruli/ai";
import { Bot, LockKeyhole, MessageSquare, ShieldCheck } from "lucide-react";
import { ChatChannels, type ChatChannelItem } from "./chat-channels";
import "./chat.css";

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
  const chatHref=(id?:string)=>taskHref(node.id,mode)+"&chat="+encodeURIComponent(id??"general")+"#collaboration";
  const channels:ChatChannelItem[]=data.channels.map(member=>{
    const bot=member.type==="bot"?ai.bots.find(item=>item.memberId===member.id):undefined;
    return {id:member.id,name:member.name,label:viewer.role==="executor"&&member.id===viewer.memberId?"С руководителем":member.name,
      description:member.type==="bot"?providerName(bot?.provider??""):viewer.role==="executor"&&member.id===viewer.memberId?"Личный диалог":member.role||"Личный диалог",initials:member.initials,color:member.color,type:member.type,href:chatHref(member.id),
      configuration:member.type==="bot"?configuration(bot):undefined};
  });
  return <section className="collaboration" id="collaboration" aria-label="Обсуждение задачи">
    <div className="collaboration-context">
      <div className="collaboration-context-title"><span>Текущая задача</span><a href="#task-title">{node.title}</a></div>
      <nav aria-label="Перейти к разделу совместной работы"><a href="#discussion">К обсуждению ↓</a></nav>
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

  </section>;
}

