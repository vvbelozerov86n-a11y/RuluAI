import Link from "next/link";
import type {CSSProperties} from "react";
import {nestTask,unnestTask,moveTask,setStatus} from "@/app/actions";
import {canManage,type AccessContext} from "@/lib/ruli/access";
import {BackArrow,Icon} from "./icons";
import {OwnerChip,ParticipantCounters,ProgressBar,SignalChip,StateChip,TaskStatusChip} from "./ui";
import {ResultForm} from "./result-form";
import {SubmitButton} from "./submit-button";
import {TaskCollaboration} from "./collaboration";
import {BLOCK_SIZES,ROOT_ID,STATUS_NAMES,isOverdue,peopleOf,plural,progress,stats,taskHref,type Member,type TaskNode,type ViewMode} from "@/lib/ruli/model";
export {taskHref}; export type {ViewMode};
export type TaskFilters={q?:string;owner?:string;status?:string;late?:string};

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

export function TaskCard({node,index,siblingCount,mode,members,today,viewer}:{node:TaskNode;index:number;siblingCount:number;mode:ViewMode;members:Member[];today:string;viewer:AccessContext}) {
  const nested=node.kind==="group", s=stats(node,today),size=BLOCK_SIZES[node.size],people=branchPeople(node,members),owner=members.find(m=>m.id===node.ownerId);
  const late=nested?s.late>0||(s.total>0&&s.done<s.total&&isOverdue(node,today)):isOverdue(node,today);
  return <article className={`task-block bento-card size-${node.size} theme-${node.theme}`} style={{"--span-w":size.w,"--span-h":size.h} as CSSProperties}>
    <Link className="block-open" href={taskHref(node.id,mode)} aria-label={`${nested?"Открыть подзадачи: ":"Открыть задачу: "}${node.title}`}/>
    <div className="block-top"><span className="block-index">{String(index+1).padStart(2,"0")}</span><SignalChip late={late} review={s.review} nested={nested} status={node.status}/><span className="enter-arrow" aria-hidden="true">↘</span></div>
    <div className="block-title"><h2 title={node.title}>{node.title}</h2><span className="block-subtitle">{nested?plural(node.children.length,"подзадача","подзадачи","подзадач"):"Конкретное поручение"}</span></div>
    <div className="card-owner">{owner?<><span>Ответственный</span><OwnerChip member={owner}/></>:null}</div>
    <div className="block-bottom"><div className="people-line"><ParticipantCounters human={people.counts.human.length} bot={people.counts.bot.length} title={node.title} people={people.list}/><span className="due">{node.dueLabel}</span></div>
      <div className="bento-progress"><span>{nested?`${s.done} / ${s.total} выполнено`:STATUS_NAMES[node.status??"todo"]}</span><span>{nested?`${progress(s)}%`:owner?.type==="bot"?"AI":"Человек"}</span></div><ProgressBar percent={progress(s)} label={node.title}/>
    </div>
    {mode==="build"&&canManage(viewer)?<div className="card-builder-tools">
      <Link href={`/t/${node.id}/edit?mode=${mode}`} aria-label={`Изменить блок: ${node.title}`} title="Изменить блок"><Icon name="edit"/></Link>
      {nested?<Link href={`/new?parent=${node.id}&mode=${mode}`} aria-label={`Добавить подзадачу в: ${node.title}`} title="Добавить подзадачу"><Icon name="plus"/></Link>:<form className="inline" action={nestTask}><MutationFields node={node} mode={mode}/><button type="submit" title="Разбить на подзадачи" aria-label={`Разбить на подзадачи: ${node.title}`}><Icon name="plus"/></button></form>}
      <span className="tools-divider"/>
      {[-1,1].map(delta=><form className="inline" action={moveTask} key={delta}><MutationFields node={node} mode={mode}/><input type="hidden" name="delta" value={delta}/><button type="submit" disabled={delta<0?index===0:index===siblingCount-1} aria-label={`Переместить ${delta<0?"раньше":"позже"}: ${node.title}`}>{delta<0?"←":"→"}</button></form>)}
      <Link className="size-button" href={`/t/${node.id}/edit?mode=${mode}`}>{size.label}</Link>
    </div>:null}
  </article>;
}

function TaskSearch({tree,members,filters,today,mode}:{tree:TaskNode;members:Member[];filters:TaskFilters;today:string;mode:ViewMode}) {
  const active=Boolean(filters.q||filters.owner||filters.status||filters.late);
  const found:{node:TaskNode;path:TaskNode[]}[]=[];
  function walk(n:TaskNode,path:TaskNode[]) {
    const next=[...path,n],s=stats(n,today);
    const matchesText=!filters.q||[n.title,n.description,n.result].join(" ").toLocaleLowerCase("ru").includes(filters.q.trim().toLocaleLowerCase("ru"));
    const matchesStatus=!filters.status||(n.kind==="leaf"?n.status===filters.status:filters.status==="review"?s.review>0:filters.status==="done"?s.total>0&&s.done===s.total:false);
    if(n.id!==ROOT_ID&&matchesText&&matchesStatus&&(!filters.owner||n.ownerId===filters.owner)&&(!filters.late||s.late>0||isOverdue(n,today)))found.push({node:n,path:next});
    n.children.forEach(c=>walk(c,next));
  }
  if(active)walk(tree,[]);
  return <section className="task-search" aria-label="Поиск по всем задачам">
    <form action="/" method="get" className="search-form">
      <input type="hidden" name="mode" value={mode}/>
      <label className="search-query">Поиск по всем задачам<input type="search" name="q" defaultValue={filters.q??""} placeholder="Название, описание или результат"/></label>
      <label>Ответственный<select name="owner" defaultValue={filters.owner??""}><option value="">Все</option>{members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <label>Статус<select name="status" defaultValue={filters.status??""}><option value="">Все</option>{Object.entries(STATUS_NAMES).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
      <label className="check-label"><input type="checkbox" name="late" value="1" defaultChecked={Boolean(filters.late)}/>Просроченные</label>
      <button className="secondary" type="submit">Найти</button>{active?<Link href={taskHref(ROOT_ID,mode)}>Сбросить</Link>:null}
    </form>
    {active?<div className="search-results"><h2>Найдено: {found.length}</h2>{found.length?<ol>{found.map(({node:n,path})=><li key={n.id}><div><Link className="search-result-title" href={taskHref(n.id,mode)}>{n.title}</Link><nav aria-label={`Путь: ${n.title}`}>{path.slice(0,-1).map((p,i)=><span key={p.id}>{i?" / ":""}<Link href={taskHref(p.id,mode)}>{p.title}</Link></span>)}</nav></div><div className="search-result-meta"><span>{members.find(m=>m.id===n.ownerId)?.name}</span><span>{n.dueLabel}</span>{n.status?<TaskStatusChip status={n.status}/>:<span>Группа задач</span>}</div></li>)}</ol>:<p className="empty-copy">Задачи не найдены. Измените запрос или сбросьте фильтры.</p>}</div>:null}
  </section>;
}

type ViewProps={node:TaskNode;path:TaskNode[];mode:ViewMode;members:Member[];today:string;viewer:AccessContext;flash?:string;error?:string;channel?:string;filters?:TaskFilters};
export function GroupView({node,path,mode,members,today,viewer,flash,error,channel,filters={}}:ViewProps) {
  const isRoot=node.id===ROOT_ID,s=stats(node,today),owner=members.find(m=>m.id===node.ownerId),manager=canManage(viewer),filtered=isRoot&&Boolean(filters.q||filters.owner||filters.status||filters.late);
  const canUnnest=node.kind==="group"&&node.children.length===1&&node.children[0].kind==="leaf"&&node.children[0].splitSourceId===node.id;
  return <main className={`workspace${mode==="build"?" is-building":""}`}>
    <NavigationRow path={path} mode={mode}/><Toasts flash={flash} error={error}/>
    <div className="page-heading"><div><h1>{node.title}</h1><p>{isRoot?"Крупные задачи команды":"От общей цели — к конкретным поручениям"}<span className="sep">·</span>{plural(node.children.length,"блок","блока","блоков")}</p></div>
      <div className="heading-tools"><div className="mode-switch" aria-label="Режим"><Link href={taskHref(node.id,"view")} aria-current={mode==="view"?"page":undefined} aria-pressed={mode==="view"}>Обзор</Link>{manager?<Link href={taskHref(node.id,"build")} aria-current={mode==="build"?"page":undefined} aria-pressed={mode==="build"}>Конструктор</Link>:null}</div>
        {manager?<><Link className="secondary" href="/trash">Корзина</Link><Link className="primary" href={`/new?parent=${node.id}&mode=${mode}`}><Icon name="plus"/>{isRoot?"Новая задача":"Добавить подзадачу"}</Link></>:null}
      </div>
    </div>
    {!filtered?<nav className="task-jumps" aria-label="Перейти к разделу"><a href="#discussion">Обсуждение</a><a href="#schedule">График выполнения</a></nav>:null}
    {!isRoot?<><div className="context-strip"><span><span className="label">ОТВЕТСТВЕННЫЙ</span>{owner?<OwnerChip member={owner}/>:null}</span><span><span className="label">СРОК</span>{node.dueLabel}</span><span className="parent-progress">{s.done} из {s.total} выполнено</span>{manager?<Link href={`/t/${node.id}/edit?mode=${mode}`}>Настроить блок</Link>:null}</div>{manager&&canUnnest?<form className="unnest-form" action={unnestTask}><MutationFields node={node} mode={mode}/><SubmitButton className="secondary">Отменить разбиение на подзадачи</SubmitButton></form>:null}</>:<TaskSearch tree={node} members={members} filters={filters} today={today} mode={mode}/>}
    {!filtered?<><div className="overview-line"><span>{isRoot?"ВЕРХНИЙ УРОВЕНЬ":"ПОДЗАДАЧИ"} / {String(node.children.length).padStart(2,"0")}</span><span>От общего к конкретному</span></div><div className="builder-legend"><span><i className="legend-square human"/>Люди</span><span><i className="legend-square bot"/>AI-боты</span><small>Нажмите на счётчик, чтобы увидеть участников</small></div>
      <section className="grid bento-grid" aria-label={isRoot?"Крупные задачи":"Подзадачи"}>{node.children.map((child,index)=><TaskCard key={child.id} node={child} index={index} siblingCount={node.children.length} mode={mode} members={members} today={today} viewer={viewer}/>)}{!node.children.length?<div className="empty-state"><h2>В этой группе пока нет поручений</h2><p>{manager?"Добавьте первый шаг и назначьте ответственного.":"Руководитель добавит задачи в эту группу."}</p>{manager?<Link className="secondary" href={`/new?parent=${node.id}&mode=${mode}`}>Добавить подзадачу</Link>:null}</div>:null}</section></>:null}
    {!filtered?<TaskCollaboration node={node} members={members} viewer={viewer} channel={channel} mode={mode}/>:null}
    <WorkspaceFooter hint="Нажмите на блок, чтобы перейти на следующий уровень"/>
  </main>;
}

export function DetailView({node,path,mode,members,today,viewer,flash,error,channel}:ViewProps) {
  const owner=members.find(m=>m.id===node.ownerId),parent=path.at(-2)!,status=node.status??"todo",manager=canManage(viewer),people=branchPeople(node,members);
  const canSubmit=manager||(viewer.role==="executor"&&(node.ownerId===viewer.memberId||node.participants.includes(viewer.memberId)));
  return <main className={`workspace${mode==="build"?" is-building":""}`}>
    <NavigationRow path={path} mode={mode}/><Toasts flash={flash} error={error}/>
    <div className="page-heading"><div><h1>{node.title}</h1><p>Конкретное поручение · {owner?.type==="bot"?"Выполняет AI-бот":"Выполняет человек"}</p></div><TaskStatusChip status={status}/></div>
    <nav className="task-jumps" aria-label="Перейти к разделу"><a href="#discussion">Обсуждение</a><a href="#schedule">График выполнения</a></nav>
    <div className="leaf-constructor-bar"><ParticipantCounters human={people.counts.human.length} bot={people.counts.bot.length} title={node.title} people={people.list}/><span>Участники задачи</span>{manager?<div><Link className="secondary" href={`/t/${node.id}/edit?mode=${mode}`}>Изменить блок</Link><form className="inline" action={nestTask}><MutationFields node={node} mode={mode}/><SubmitButton className="secondary">Разбить на подзадачи</SubmitButton></form></div>:null}</div>
    <div className="detail-layout"><article className="detail-card"><h2>Что нужно сделать</h2><p className="prewrap">{node.description||"Описание пока не заполнено."}</p><div className="section-divider"/><div className="result-label"><h2>Результат</h2><span>{status==="review"?"Ожидает решения руководителя":status==="done"?"Проверено":"Появится после выполнения"}</span></div>
      {node.result?<div className="result-content">{node.result}</div>:<div className="result-empty">Результат ещё не добавлен.</div>}
      {status==="review"&&manager?<div className="detail-actions">{([{value:"done",label:"Принять результат"},{value:"doing",label:"На доработку"}] as const).map(action=><form className="inline" action={setStatus} key={action.value}><MutationFields node={node} mode={mode}/><input type="hidden" name="status" value={action.value}/><SubmitButton className={action.value==="done"?"primary":"secondary"}>{action.label}</SubmitButton></form>)}</div>:status==="done"?<div className="detail-actions"><StateChip className="done" label="Результат принят"/>{manager?<form action={setStatus}><MutationFields node={node} mode={mode}/><input type="hidden" name="status" value="doing"/><SubmitButton className="secondary">Вернуть в работу</SubmitButton></form>:null}</div>:canSubmit&&status!=="review"?<ResultForm node={node} mode={mode}/>:null}
      {owner?.type==="bot"?<p className="detail-note">AI-бот ещё не подключён. Результат можно добавить вручную; автоматического выполнения сейчас нет.</p>:null}
    </article><aside className="detail-side"><div className="property"><span className="property-label">ИСПОЛНИТЕЛЬ</span>{owner?<OwnerChip member={owner} full/>:null}<p className="detail-note">{owner?.role}</p></div><div className="property"><span className="property-label">СРОК</span><span className="property-value">{node.dueLabel}</span>{isOverdue(node,today)?<StateChip className="overdue" label="Срок прошёл"/>:null}</div><div className="property"><span className="property-label">ЧАСТЬ ЗАДАЧИ</span><Link href={taskHref(parent.id,mode)}>{parent.title} ↗</Link></div><div className="property"><span className="property-label">ПРОВЕРЯЕТ</span><span>Руководитель команды</span></div></aside></div>
    <TaskCollaboration node={node} members={members} viewer={viewer} channel={channel} mode={mode}/>
    <WorkspaceFooter hint="Путь сверху вернёт вас на любой уровень"/>
  </main>;
}



