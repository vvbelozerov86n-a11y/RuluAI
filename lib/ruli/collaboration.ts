import { getD1 } from "../../db";
import { requireAccess, canManage, canReadChannel, type AccessContext } from "./access";
import { getMembers } from "./data";
import { peopleOf, type TaskNode, type Member } from "./model";
import type { ScheduleEntry } from "./scheduling";

export type ChatMessage = {
  id:string; taskId:string; channelMemberId:string|null; authorId:string;
  authorName:string; body:string; createdAt:string;
};
export type ScheduleRow = ScheduleEntry & {id:string; planTaskId:string; version:number};

export function taskChannelMembers(node:TaskNode,members:Member[],viewer:AccessContext):Member[] {
  const people=peopleOf(node,new Map(members.map(m=>[m.id,m])));
  const assigned=new Set([...people.human,...people.bot]);
  return members.filter(m=>assigned.has(m.id) &&
    (canManage(viewer) ? m.id!==viewer.memberId : viewer.role==="executor" && m.id===viewer.memberId));
}

export const scheduleSelect = `SELECT s.id,s.plan_task_id AS planTaskId,s.task_id AS taskId,
  s.member_id AS memberId,t.title,s.start_date AS startDate,s.end_date AS endDate,s.hours,s.version
  FROM schedule_entries s JOIN tasks t ON t.id=s.task_id JOIN tasks p ON p.id=s.plan_task_id
  WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL`;

export async function loadTaskCollaboration(node:TaskNode,_viewer:AccessContext,channelMemberId?:string) {
  const viewer=await requireAccess();
  const members=await getMembers();
  const channels=taskChannelMembers(node,members,viewer);
  const selected=channelMemberId && channelMemberId!=="general" ? channelMemberId : null;
  const permitted=!selected || (channels.some(m=>m.id===selected) && canReadChannel(viewer,selected));
  const db=getD1();
  const messages=permitted ? await db.prepare(`SELECT id,task_id AS taskId,channel_member_id AS channelMemberId,
    author_id AS authorId,author_name AS authorName,body,created_at AS createdAt FROM task_messages
    WHERE task_id=? AND channel_member_id IS ? ORDER BY created_at DESC,id DESC LIMIT 100`)
    .bind(node.id,selected).all<ChatMessage>() : {results:[] as ChatMessage[]};
  const entries=await db.prepare(`${scheduleSelect} AND s.plan_task_id=? ORDER BY s.start_date,s.member_id,s.id`).bind(node.id).all<ScheduleRow>();
  const plan=await db.prepare("SELECT version FROM schedule_plans WHERE task_id=?").bind(node.id).first<{version:number}>();
  return {channels,messages:messages.results.reverse(),entries:entries.results,scheduleVersion:plan?.version??0};
}
