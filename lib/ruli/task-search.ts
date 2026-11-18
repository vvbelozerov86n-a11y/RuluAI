import {ROOT_ID,isISODate,isTaskStatus,type TaskNode} from "./model.ts";

export type TaskFilters={q?:string;owner?:string;status?:string;late?:string;due?:string};
export type TaskEntry={node:TaskNode;path:TaskNode[]};

export function normalizeTaskFilters(filters:TaskFilters):TaskFilters {
  return {
    q:filters.q?.trim()||undefined,
    owner:filters.owner?.trim()||undefined,
    status:isTaskStatus(filters.status)?filters.status:undefined,
    late:filters.late==="1"?"1":undefined,
    due:filters.due==="today"?"today":undefined,
  };
}

export function hasTaskFilters(filters:TaskFilters):boolean {
  return Object.values(normalizeTaskFilters(filters)).some(Boolean);
}

/** A deleted branch contributes neither its group nor any descendants. */
export function taskEntries(tree:TaskNode):TaskEntry[] {
  const entries:TaskEntry[]=[];
  function walk(node:TaskNode,path:TaskNode[]) {
    if(node.deletedAt)return;
    const next=[...path,node];
    if(node.id!==ROOT_ID)entries.push({node,path:next});
    for(const child of node.children)walk(child,next);
  }
  walk(tree,[]);
  return entries;
}

function isUnfinishedEntry({node,path}:TaskEntry):boolean {
  if(node.deletedAt||node.status==="done"||path.some(ancestor=>ancestor.deletedAt))return false;
  return node.kind!=="group"||taskEntries(node).some(entry=>entry.node.kind==="leaf"&&entry.node.status!=="done");
}

/** Own/nearest expired date wins; otherwise use the earliest upcoming deadline. */
export function taskDeadlineSource(entry:TaskEntry,today:string):TaskNode|null {
  if(!isISODate(today)||!isUnfinishedEntry(entry))return null;
  const ancestors=entry.path.slice(0,-1).reverse().filter(node=>node.kind==="group");
  let upcoming:TaskNode|null=null;
  for(const candidate of [entry.node,...ancestors]){
    const date=candidate.dueDate;
    if(!isISODate(date))continue;
    if(date<today)return candidate;
    if(!upcoming?.dueDate||date<upcoming.dueDate)upcoming=candidate;
  }
  return upcoming;
}

export function overdueSource(entry:TaskEntry,today:string):TaskNode|null {
  const source=taskDeadlineSource(entry,today);
  return source?.dueDate&&source.dueDate<today?source:null;
}

/** Earlier expired deadlines take precedence over a task or group deadline today. */
export function dueTodaySource(entry:TaskEntry,today:string):TaskNode|null {
  const source=taskDeadlineSource(entry,today);
  return source?.dueDate===today?source:null;
}

function matches(entry:TaskEntry,filters:TaskFilters,today:string):boolean {
  const {node}=entry;
  // Lifecycle and deadline filters identify actionable tasks, not their ancestors.
  if((filters.status||filters.late||filters.due)&&node.kind!=="leaf")return false;
  if(filters.status&&node.status!==filters.status)return false;
  if(filters.late||filters.due){
    const deadline=taskDeadlineSource(entry,today)?.dueDate;
    if(!deadline)return false;
    const matchesDeadline=(filters.late&&deadline<today)||(filters.due&&deadline===today);
    if(!matchesDeadline)return false;
  }
  if(filters.owner&&node.ownerId!==filters.owner)return false;
  return !filters.q||[node.title,node.description,node.result].join(" ").toLocaleLowerCase("ru").includes(filters.q.toLocaleLowerCase("ru"));
}

export function searchTasks(tree:TaskNode,filters:TaskFilters,today:string):TaskEntry[] {
  const normalized=normalizeTaskFilters(filters);
  return taskEntries(tree).filter(entry=>matches(entry,normalized,today));
}

/** The same predicates power the summary and its destination filters. */
export function taskAttentionSummary(tree:TaskNode,today:string):{review:number;late:number;today:number} {
  const entries=taskEntries(tree);
  return {
    review:entries.filter(entry=>matches(entry,{status:"review"},today)).length,
    late:entries.filter(entry=>matches(entry,{late:"1"},today)).length,
    today:entries.filter(entry=>matches(entry,{due:"today"},today)).length,
  };
}
