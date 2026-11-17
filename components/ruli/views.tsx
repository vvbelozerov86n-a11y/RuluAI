import Link from "next/link";
import type {CSSProperties} from "react";
import {nestTask,unnestTask,moveTask,setStatus} from "@/app/actions";
import {canManage,type AccessContext} from "@/lib/ruli/access";
import {BackArrow,Icon} from "./icons";
import {OwnerChip,ParticipantCounters,ProgressBar,SignalChip,StateChip,TaskStatusChip} from "./ui";
import {ResultForm} from "./result-form";
import {SubmitButton} from "./submit-button";
import {TaskCollaboration} from "./collaboration";
import {TaskAiPanel} from "./ai-task";
import {loadTaskAi} from "@/lib/ruli/ai";
import {BLOCK_SIZES,ROOT_ID,STATUS_NAMES,isOverdue,peopleOf,plural,progress,stats,taskHref,type Member,type TaskNode,type ViewMode} from "@/lib/ruli/model";
import {dueTodaySource,hasTaskFilters,normalizeTaskFilters,overdueSource,searchTasks,taskAttentionSummary,type TaskEntry,type TaskFilters} from "@/lib/ruli/task-search";
import "./overview.css";
export {taskHref}; export type {ViewMode};
export type {TaskFilters};
export type OverviewLayout="list"|"cards";

export function NavigationRow({path,mode}:{path:TaskNode[];mode?:ViewMode}) {
  const parent=path.at(-2);
  return <div className="navigation-row">{parent?<Link className="back-button" href={taskHref(parent.id,mode)} aria-label="На уровень выше"><BackArrow/></Link>:<button className="back-button" disabled aria-label="На уровень выше"><BackArrow/></button>}
    <nav id="breadcrumbs" aria-label="Путь задачи">{path.map((n,i)=><span className="crumb" key={n.id}>{i?<span className="separator" aria-hidden="true">/</span>:null}{i===path.length-1?<span aria-current="page">{n.title}</span>:<Link href={taskHref(n.id,mode)}>{n.title}</Link>}</span>)}</nav><span className="depth">УРОВЕНЬ {String(path.length).padStart(2,"0")}</span>
  </div>;
}
export function Toasts({flash,error}:{flash?:string;error?:string}) {
  return error||flash?<div className={`page-notice ${error?"error":"success"}`} role={error?"alert":"status"} aria-live="polite">{error||flash}</div>:null;
}
export function WorkspaceFooter({hint}:{hint:string}) {return <footer className="workspace-footer"><span><i className="quiet-dot"/>Изменения сохраняются для всей команды</span><span>{hint}</span></footer>;}
function MutationFields({node,mode}:{node:TaskNode;mode:ViewMode}) {return <><input type="hidden" name="id" value={node.id}/><input type="hidden" name="version" value={node.version}/><input type="hidden" name="expectedStatus" value={node.status??""}/><input type="hidden" name="mode" value={mode}/></>;}
function branchPeople(node:TaskNode,members:Member[]) {const p=peopleOf(node,new Map(members.map(m=>[m.id,m])));return {counts:p,list:members.filter(m=>p.human.includes(m.id)||p.bot.includes(m.id))};}

export function TaskCard({node,index,siblingCount,mode,members,today,viewer,path=[node]}:{node:TaskNode;index:number;siblingCount:number;mode:ViewMode;members:Member[];today:string;viewer:AccessContext;path?:TaskNode[]}) {
  const nested=node.kind==="group", s=stats(node,today),size=BLOCK_SIZES[node.size],people=branchPeople(node,members),owner=members.find(m=>m.id===node.ownerId);
  const late=Boolean(overdueSource({node,path},today))||(nested&&taskAttentionSummary(node,today).late>0);
  return <article className={`task-block bento-card size-${node.size} theme-${node.theme}`} style={{"--span-w":size.w,"--span-h":size.h} as CSSProperties}>
    <Link className="block-open" href={taskHref(node.id,mode)} aria-label={`${nested?"Открыть подзадачи: ":"Открыть задачу: "}${node.title}`}/>
    <div className="block-top"><span className="block-index">{String(index+1).padStart(2,"0")}</span><SignalChip late={late} review={s.review} nested={nested} status={node.status}/><span className="enter-arrow" aria-hidden="true">↘</span></div>
    <div className="block-title"><h2 title={node.title}>{node.title}</h2><span className="block-subtitle">{nested?plural(node.children.length,"подзадача","подзадачи","подзадач"):"Задача"}</span></div>
    <div className="card-owner">{owner?<><span>Ответственный</span><OwnerChip member={owner}/></>:null}</div>
    <div className="block-bottom"><div className="people-line"><ParticipantCounters human={people.counts.human.length} bot={people.counts.bot.length} title={node.title} people={people.list}/><span className="due">{node.dueLabel}</span></div>
      <div className="bento-progress"><span>{nested?`${s.done} / ${s.total} выполнено`:STATUS_NAMES[node.status??"todo"]}</span><span>{nested?`${progress(s)}%`:owner?.type==="bot"?"AI":"Человек"}</span></div><ProgressBar percent={progress(s)} label={node.title}/>
    </div>
    {mode==="build"&&canManage(viewer)?<div className="card-builder-tools">
      <Link href={`/t/${node.id}/edit?mode=${mode}`} aria-label={`Изменить ${nested?"группу":"задачу"}: ${node.title}`} title={nested?"Изменить группу":"Изменить задачу"}><Icon name="edit"/></Link>
      {nested?<Link href={`/new?parent=${node.id}&mode=${mode}`} aria-label={`Добавить подзадачу в: ${node.title}`} title="Добавить подзадачу"><Icon name="plus"/></Link>:<form className="inline" action={nestTask}><MutationFields node={node} mode={mode}/><button type="submit" title="Разбить на подзадачи" aria-label={`Разбить на подзадачи: ${node.title}`}><Icon name="plus"/></button></form>}
      <span className="tools-divider"/>
      {[-1,1].map(delta=><form className="inline" action={moveTask} key={delta}><MutationFields node={node} mode={mode}/><input type="hidden" name="delta" value={delta}/><button type="submit" disabled={delta<0?index===0:index===siblingCount-1} aria-label={`Переместить ${delta<0?"раньше":"позже"}: ${node.title}`}>{delta<0?"←":"→"}</button></form>)}
      <Link className="size-button" href={`/t/${node.id}/edit?mode=${mode}`}>{size.label}</Link>
    </div>:null}
  </article>;
}

function viewHref(id:string,layout:OverviewLayout="list",mode:ViewMode="view") {return taskHref(id,mode)+(layout==="cards"?"&layout=cards":"");}

function TaskContents({detail=false}:{detail?:boolean}) {
  return <nav className="task-contents" aria-label="Перейти к разделу"><span>Перейти к разделу:</span><a href={detail?"#task-details":"#task-list"}>{detail?"Описание и результат":"Задачи"}</a><a href="#discussion">Обсуждение</a><a href="#schedule">График выполнения</a></nav>;
}

function AttentionSummary({tree,today,filters}:{tree:TaskNode;today:string;filters:TaskFilters}) {
  const summary=taskAttentionSummary(tree,today);
  const items=[{label:"Ждут проверки",count:summary.review,query:"status=review",active:filters.status==="review"},{label:"Просрочены",count:summary.late,query:"late=1",active:filters.late==="1"},{label:"Срок сегодня",count:summary.today,query:"due=today",active:filters.due==="today"}];
  return <section className="attention-summary" aria-label="Требуют внимания">{items.map(item=><a key={item.query} href={`/?${item.query}#task-results`} className={item.active?"active":undefined}><strong>{item.count}</strong><span>{item.label}</span><span className="sr-only"> — открыть задачи</span></a>)}</section>;
}

function CompactTaskList({entries,members,today,mode,showPath=false}:{entries:TaskEntry[];members:Member[];today:string;mode:ViewMode;showPath?:boolean}) {
  const memberMap=new Map(members.map(member=>[member.id,member]));
  return <div className="compact-task-list"><div className="compact-list-head" aria-hidden="true"><span>Задача / группа</span><span>Ответственный</span><span>Срок</span><span>Статус / прогресс</span></div><ul>{entries.map(({node,path})=>{
    const summary=stats(node,today),group=node.kind==="group",owner=memberMap.get(node.ownerId),lateSource=overdueSource({node,path},today),todaySource=dueTodaySource({node,path},today),late=Boolean(lateSource)||(group&&taskAttentionSummary(node,today).late>0),inheritedLate=!group&&lateSource&&lateSource.id!==node.id,inheritedToday=!group&&todaySource&&todaySource.id!==node.id,sourceGroup=inheritedLate?lateSource:inheritedToday?todaySource:null;
    return <li className="compact-task-row" key={node.id}>
      <div className="compact-task-title"><Link href={taskHref(node.id,mode)}>{node.title}<span aria-hidden="true"> ↗</span></Link><span className="compact-task-kind">{group?"Группа задач":"Задача"}</span>{showPath?<nav className="compact-task-path" aria-label={`Путь: ${node.title}`}>{path.slice(0,-1).map((ancestor,index)=><span key={ancestor.id}>{index?" / ":""}<Link href={taskHref(ancestor.id,mode)}>{ancestor.title}</Link></span>)}</nav>:null}</div>
      <div className="compact-task-owner"><span className="compact-mobile-label">Ответственный</span>{owner?<OwnerChip member={owner} full/>:<span>Не назначен</span>}</div>
      <div className="compact-task-due"><span className="compact-mobile-label">Срок</span><span>{node.dueLabel}</span>{late?<StateChip className="overdue" label={group?"Есть просрочка":inheritedLate?"Срок группы прошёл":"Срок прошёл"}/>:null}{inheritedToday?<StateChip className="due-today" label="Срок группы сегодня"/>:null}{sourceGroup?<span className="compact-deadline-source">Группа: <Link href={taskHref(sourceGroup.id,mode)}>{sourceGroup.title}</Link></span>:null}</div>
      <div className="compact-task-progress">{group?<><span>{summary.total?`${summary.done} из ${summary.total} выполнено` :"Пока нет задач"}</span>{summary.total?<ProgressBar percent={progress(summary)} label={node.title}/>:null}{summary.review?<StateChip className="review" label={`${summary.review} на проверке`}/>:null}</>:<TaskStatusChip status={node.status??"todo"}/>}</div>
    </li>;
  })}</ul></div>;
}

function TaskSearch({tree,members,filters,today,layout}:{tree:TaskNode;members:Member[];filters:TaskFilters;today:string;layout:OverviewLayout}) {
  const active=hasTaskFilters(filters),found=active?searchTasks(tree,filters,today):[];
  const advancedCount=[filters.owner,filters.status,filters.late,filters.due].filter(Boolean).length;
  const chips=[filters.q?`Поиск: ${filters.q}`:null,filters.owner?`Ответственный: ${members.find(member=>member.id===filters.owner)?.name??"Участник не найден"}`:null,filters.status?STATUS_NAMES[filters.status as keyof typeof STATUS_NAMES]:null,filters.late?"Просроченные":null,filters.due?"Срок сегодня":null].filter(Boolean);
  return <section className="overview-search" aria-label="Поиск по всем задачам">
    <form action="/" method="get">
      <input type="hidden" name="layout" value={layout}/>
      <div className="overview-search-line"><label htmlFor="task-query" className="sr-only">Поиск по всем задачам</label><input id="task-query" type="search" name="q" defaultValue={filters.q??""} placeholder="Найти задачу, описание или результат"/><button className="secondary" type="submit">Найти</button></div>
      <details className="overview-extra-filters"><summary>Фильтры{advancedCount?` · ${advancedCount}`:""}</summary><div className="overview-filter-fields">
        <label>Ответственный<select name="owner" defaultValue={filters.owner??""}><option value="">Все</option>{filters.owner&&!members.some(member=>member.id===filters.owner)?<option value={filters.owner}>Участник не найден</option>:null}{members.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        <label>Статус<select name="status" defaultValue={filters.status??""}><option value="">Все</option>{Object.entries(STATUS_NAMES).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
        <label className="overview-checkbox"><input type="checkbox" name="late" value="1" defaultChecked={Boolean(filters.late)}/>Просроченные</label><label className="overview-checkbox"><input type="checkbox" name="due" value="today" defaultChecked={Boolean(filters.due)}/>Срок сегодня</label>
        <button className="secondary" type="submit">Применить фильтры</button>
      </div></details>
    </form>
    {active?<><div className="active-task-filters" aria-label="Активные фильтры">{chips.map(chip=><span key={chip}>{chip}</span>)}<a href={viewHref(ROOT_ID,layout)}>Сбросить всё</a></div><section className="task-search-results" id="task-results" aria-labelledby="task-results-title"><h2 id="task-results-title">Найдено: {found.length}</h2>{found.length?<CompactTaskList entries={found} members={members} today={today} mode="view" showPath/>:<p className="empty-copy">Совпадений нет. Измените запрос или сбросьте фильтры.</p>}</section></>:null}
  </section>;
}

type ViewProps={node:TaskNode;path:TaskNode[];mode:ViewMode;members:Member[];today:string;viewer:AccessContext;flash?:string;error?:string;channel?:string;filters?:TaskFilters;layout?:OverviewLayout};
export function GroupView({node,path,mode,members,today,viewer,flash,error,channel,filters:rawFilters={},layout="list"}:ViewProps) {
  const filters=normalizeTaskFilters(rawFilters),isRoot=node.id===ROOT_ID,s=stats(node,today),owner=members.find(m=>m.id===node.ownerId),manager=canManage(viewer),filtered=isRoot&&hasTaskFilters(filters),cards=layout==="cards"||mode==="build",children=node.children.filter(child=>!child.deletedAt);
  const canUnnest=node.kind==="group"&&node.children.length===1&&node.children[0].kind==="leaf"&&node.children[0].splitSourceId===node.id;
  return <main className={`workspace task-overview${mode==="build"?" is-building":""}`}>
    <NavigationRow path={path} mode={mode}/><Toasts flash={flash} error={error}/>
    <div className="page-heading"><div><h1 id="task-title">{node.title}</h1><p>{isRoot?"Задачи и группы команды":"Группа задач"}</p></div>
      <div className="heading-tools">
        {manager?<><Link className="secondary" href="/trash">Корзина</Link><Link className="primary" href={`/new?parent=${node.id}&mode=${mode}`}><Icon name="plus"/>{isRoot?"Новая задача":"Добавить подзадачу"}</Link></>:null}
      </div>
    </div>
    {isRoot?<><AttentionSummary tree={node} today={today} filters={filters}/><TaskSearch tree={node} members={members} filters={filters} today={today} layout={layout}/></>:<><div className="context-strip"><span><span className="label">ОТВЕТСТВЕННЫЙ</span>{owner?<OwnerChip member={owner}/>:null}</span><span><span className="label">СРОК</span>{node.dueLabel}</span><span className="parent-progress">{s.done} из {s.total} выполнено</span>{manager?<Link href={`/t/${node.id}/edit?mode=${mode}`}>Изменить группу</Link>:null}</div>{manager&&canUnnest?<form className="unnest-form" action={unnestTask}><MutationFields node={node} mode={mode}/><SubmitButton className="secondary">Отменить разбиение на подзадачи</SubmitButton></form>:null}</>}
    {!filtered?<><TaskContents/><div className="overview-list-toolbar" id="task-list"><h2>{isRoot?"Задачи и группы":"В этой группе"}<span> · {children.length}</span></h2><nav className="overview-view-switch" aria-label="Представление задач"><Link href={viewHref(node.id)} aria-current={!cards&&mode==="view"?"page":undefined}>Список</Link><Link href={viewHref(node.id,"cards")} aria-current={cards&&mode==="view"?"page":undefined}>Карточки</Link>{manager?<Link href={viewHref(node.id,"cards","build")} aria-current={mode==="build"?"page":undefined}>Изменить структуру</Link>:null}</nav></div>
      {children.length?cards?<><div className="builder-legend"><span><i className="legend-square human"/>Люди</span><span><i className="legend-square bot"/>AI-боты</span><small>Нажмите на счётчик, чтобы увидеть участников</small></div><section className="grid bento-grid" aria-label={isRoot?"Задачи и группы":"Подзадачи"}>{children.map((child,index)=><TaskCard key={child.id} node={child} path={[...path,child]} index={index} siblingCount={children.length} mode={mode} members={members} today={today} viewer={viewer}/>)}</section></>:<CompactTaskList entries={children.map(child=>({node:child,path:[...path,child]}))} members={members} today={today} mode={mode}/>:<div className="empty-state"><h2>Здесь пока нет задач</h2><p>{manager?"Добавьте первый шаг и назначьте ответственного.":"Руководитель добавит задачи в эту группу."}</p>{manager?<Link className="secondary" href={`/new?parent=${node.id}&mode=${mode}`}>Добавить задачу</Link>:null}</div>}
    </>:null}
    {!filtered?<TaskCollaboration node={node} members={members} viewer={viewer} channel={channel} mode={mode}/>:null}
    <WorkspaceFooter hint="Откройте задачу или группу, чтобы продолжить работу"/>
  </main>;
}

export async function DetailView({node,path,mode,members,today,viewer,flash,error,channel}:ViewProps) {
  const owner=members.find(m=>m.id===node.ownerId),parent=path.at(-2)!,status=node.status??"todo",manager=canManage(viewer),people=branchPeople(node,members);
  const canSubmit=manager||(viewer.role==="executor"&&(node.ownerId===viewer.memberId||node.participants.includes(viewer.memberId)));
  return <main className={`workspace${mode==="build"?" is-building":""}`}>
    <NavigationRow path={path} mode={mode}/><Toasts flash={flash} error={error}/>
    <div className="page-heading"><div><h1 id="task-title">{node.title}</h1><p>Задача · {owner?.type==="bot"?"Ответственный — AI-бот":"Ответственный — человек"}</p></div><TaskStatusChip status={status}/></div>
    <TaskContents detail/>
    <div className="leaf-constructor-bar"><ParticipantCounters human={people.counts.human.length} bot={people.counts.bot.length} title={node.title} people={people.list}/><span>Участники задачи</span>{manager?<div><Link className="secondary" href={`/t/${node.id}/edit?mode=${mode}`}>Изменить задачу</Link><form className="inline" action={nestTask}><MutationFields node={node} mode={mode}/><SubmitButton className="secondary">Разбить на подзадачи</SubmitButton></form></div>:null}</div>
    <div className="detail-layout"><article className="detail-card" id="task-details"><h2>Что нужно сделать</h2><p className="prewrap">{node.description||"Описание пока не заполнено."}</p>
      {owner?.type==="bot"?<TaskAiPanel taskId={node.id} version={node.version} data={await loadTaskAi(node,viewer)} manager={manager} clientId={crypto.randomUUID()}/>:null}
      <div className="section-divider"/><div className="result-label"><h2>Результат</h2><span>{status==="review"?"Ожидает решения руководителя":status==="done"?"Проверено":"Появится после выполнения"}</span></div>
      {node.result?<div className="result-content">{node.result}</div>:<div className="result-empty">Результат ещё не добавлен.</div>}
      {status==="review"&&manager?<div className="detail-actions">{([{value:"done",label:"Принять результат"},{value:"doing",label:"На доработку"}] as const).map(action=><form className="inline" action={setStatus} key={action.value}><MutationFields node={node} mode={mode}/><input type="hidden" name="status" value={action.value}/><SubmitButton className={action.value==="done"?"primary":"secondary"}>{action.label}</SubmitButton></form>)}</div>:status==="done"?<div className="detail-actions"><StateChip className="done" label="Результат принят"/>{manager?<form action={setStatus}><MutationFields node={node} mode={mode}/><input type="hidden" name="status" value="doing"/><SubmitButton className="secondary">Вернуть в работу</SubmitButton></form>:null}</div>:canSubmit&&status!=="review"?<ResultForm node={node} mode={mode}/>:null}
    </article><aside className="detail-side"><div className="property"><span className="property-label">ОТВЕТСТВЕННЫЙ</span>{owner?<OwnerChip member={owner} full/>:null}<p className="detail-note">{owner?.role}</p></div><div className="property"><span className="property-label">СРОК</span><span className="property-value">{node.dueLabel}</span>{isOverdue(node,today)?<StateChip className="overdue" label="Срок прошёл"/>:null}</div><div className="property"><span className="property-label">ГРУППА</span><Link href={taskHref(parent.id,mode)}>{parent.title} ↗</Link></div><div className="property"><span className="property-label">ПРОВЕРЯЕТ</span><span>Руководитель команды</span></div></aside></div>
    <TaskCollaboration node={node} members={members} viewer={viewer} channel={channel} mode={mode}/>
    <WorkspaceFooter hint="Путь сверху вернёт вас на любой уровень"/>
  </main>;
}



