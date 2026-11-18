import { getD1 } from "../../db";
import { requireAccess, canManage, canReadChannel, type AccessContext } from "./access";
import { taskPagePath } from "./return-path";
import { getMembers, loadTree } from "./data";
import { findPath, isISODate, peopleOf, type TaskNode, type Member } from "./model";
import type { ScheduleEntry } from "./scheduling";
import type { AiRunSummary } from "./ai";

export type ChatMessage = {
  id:string; taskId:string; channelMemberId:string|null; authorId:string;
  authorName:string; body:string; createdAt:string;
};
export type MessagePageInfo = { hasMore:boolean; beforeCursor:string|null };
export type MessagePage = MessagePageInfo & { messages:ChatMessage[] };
export type ChatAiRun = Pick<AiRunSummary,
  "id"|"botMemberId"|"channelMemberId"|"inputMessageId"|"error"|"status"|"canRetry"|"createdAt"|"finishedAt"|"output">;

export class MessagePageError extends Error {
  readonly status:400|403|404;
  constructor(message:string,status:400|403|404) { super(message); this.status=status; }
}

const MESSAGE_PAGE_SIZE=100;
type MessageCursor = { createdAt:string; id:string };

function selectedChannel(value?:string|null):string|null {
  return value && value!=="general" ? value : null;
}

function parseMessageCursor(value:string|undefined|null,taskId:string,channel:string|null):MessageCursor|null {
  if(value===undefined||value===null)return null;
  try {
    if(value.length>1024)throw new Error("cursor-length");
    const parsed:unknown=JSON.parse(value);
    if(!Array.isArray(parsed)||parsed.length!==5||parsed[0]!==1||parsed[1]!==taskId||parsed[2]!==channel)throw new Error("cursor-scope");
    const createdAt:unknown=parsed[3],id:unknown=parsed[4];
    if(typeof createdAt!=="string"||createdAt.length>40||!isISODate(createdAt.slice(0,10))
      ||!/^\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(createdAt)
      ||!Number.isFinite(Date.parse(createdAt)))throw new Error("cursor-time");
    if(typeof id!=="string"||!/^[a-zA-Z0-9_-]{1,150}$/.test(id))throw new Error("cursor-id");
    return {createdAt,id};
  } catch {
    throw new MessagePageError("Не удалось прочитать позицию в переписке. Обновите диалог.",400);
  }
}

async function messageAccess(taskId:string) {
  const viewer=await requireAccess(taskPagePath(taskId));
  const node=findPath(taskId,await loadTree())?.at(-1);
  if(!node)throw new MessagePageError("Задача не найдена.",404);
  const channels=taskChannelMembers(node,await getMembers(),viewer);
  return {viewer,node,channels};
}

function permittedChannel(access:Awaited<ReturnType<typeof messageAccess>>,channel:string|null):boolean {
  return canReadChannel(access.viewer,channel)&&(!channel||access.channels.some(member=>member.id===channel));
}

async function readMessagePage(taskId:string,channel:string|null,before?:string|null):Promise<MessagePage> {
  const cursor=parseMessageCursor(before,taskId,channel);
  const rows=await getD1().prepare(`SELECT id,task_id AS taskId,channel_member_id AS channelMemberId,
    author_id AS authorId,author_name AS authorName,body,created_at AS createdAt FROM task_messages
    WHERE task_id=? AND channel_member_id IS ?
      ${cursor?"AND (created_at<? OR (created_at=? AND id<?))":""}
    ORDER BY created_at DESC,id DESC LIMIT ${MESSAGE_PAGE_SIZE+1}`)
    .bind(taskId,channel,...(cursor?[cursor.createdAt,cursor.createdAt,cursor.id]:[])).all<ChatMessage>();
  const hasMore=rows.results.length>MESSAGE_PAGE_SIZE;
  const messages=rows.results.slice(0,MESSAGE_PAGE_SIZE).reverse();
  const first=messages[0];
  return {messages,hasMore,beforeCursor:hasMore&&first?JSON.stringify([1,taskId,channel,first.createdAt,first.id]):null};
}

/** Rechecks trusted identity and current channel membership for every history request. */
export async function loadMessagePage(taskId:string,channelMemberId?:string|null,before?:string|null):Promise<MessagePage> {
  const access=await messageAccess(taskId);
  const channel=selectedChannel(channelMemberId);
  if(!permittedChannel(access,channel))throw new MessagePageError("Диалог недоступен.",403);
  return readMessagePage(taskId,channel,before);
}
export type ScheduleRow = ScheduleEntry & {id:string; planTaskId:string; version:number};
export type ScheduleWorkloadRow = ScheduleRow & {hoursPerDay:number};

export function taskChannelMembers(node:TaskNode,members:Member[],viewer:AccessContext):Member[] {
  const people=peopleOf(node,new Map(members.map(m=>[m.id,m])));
  const assigned=new Set([...people.human,...people.bot]);
  return members.filter(m=>assigned.has(m.id) &&
    (canManage(viewer) ? m.id!==viewer.memberId : canReadChannel(viewer,m.id)));
}

export const scheduleSelect = `SELECT s.id,s.plan_task_id AS planTaskId,s.task_id AS taskId,
  s.member_id AS memberId,t.title,s.start_date AS startDate,s.end_date AS endDate,s.hours,s.version
  FROM schedule_entries s JOIN tasks t ON t.id=s.task_id JOIN tasks p ON p.id=s.plan_task_id
  WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL`;

/** Keep done entries in display history, but never reserve capacity for them. */
export const workloadSelect = `SELECT s.id,s.plan_task_id AS planTaskId,s.task_id AS taskId,
  s.member_id AS memberId,t.title,s.start_date AS startDate,s.end_date AS endDate,s.hours,s.version,
  sp.hours_per_day AS hoursPerDay
  FROM schedule_entries s JOIN tasks t ON t.id=s.task_id JOIN tasks p ON p.id=s.plan_task_id
  JOIN schedule_plans sp ON sp.task_id=s.plan_task_id
  WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL AND t.kind='leaf' AND t.status<>'done'`;

export async function loadTaskCollaboration(node:TaskNode,_viewer:AccessContext,channelMemberId?:string) {
  const access=await messageAccess(node.id);
  const {channels}=access;
  const selected=selectedChannel(channelMemberId);
  const page=permittedChannel(access,selected)?await readMessagePage(node.id,selected):{messages:[] as ChatMessage[],hasMore:false,beforeCursor:null};
  const db=getD1();
  const entries=await db.prepare(`${scheduleSelect} AND s.plan_task_id=? ORDER BY s.start_date,s.member_id,s.id`).bind(node.id).all<ScheduleRow>();
  const plan=await db.prepare("SELECT version FROM schedule_plans WHERE task_id=?").bind(node.id).first<{version:number}>();
  return {channels,messages:page.messages,messagePage:{hasMore:page.hasMore,beforeCursor:page.beforeCursor},entries:entries.results,scheduleVersion:plan?.version??0};
}
