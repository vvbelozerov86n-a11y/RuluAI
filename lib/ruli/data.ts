import { cache } from "react";
import { sql, isNull } from "drizzle-orm";
import { getDb } from "../../db";
import { members, tasks, taskParticipants } from "../../db/schema";
import { requireAccess } from "./access";
import { DEMO_MEMBERS, dueLabelFromISO, ROOT_ID, type Member, type TaskNode } from "./model";
export { initRuli } from "./bootstrap";

export const getMembers = cache(async (): Promise<Member[]> => {
  await requireAccess();
  const rows = await getDb().select().from(members);
  const order = DEMO_MEMBERS.map(m => m.id);
  return rows.map(row => ({...row,type:row.type === "bot" ? "bot" as const : "human" as const}))
    .sort((a,b) => order.indexOf(a.id)-order.indexOf(b.id) || a.name.localeCompare(b.name,"ru"));
});

export const loadTree = cache(async (): Promise<TaskNode> => {
  await requireAccess();
  const db = getDb();
  const [taskRows, participantRows] = await Promise.all([
    db.select().from(tasks).where(isNull(tasks.deletedAt)),
    db.select().from(taskParticipants),
  ]);
  const byId = new Map<string,TaskNode>();
  for (const row of taskRows) {
    byId.set(row.id, {
      id:row.id,parentId:row.parentId,kind:row.kind === "group" ? "group" : "leaf",
      title:row.title,ownerId:row.ownerId,status:row.status as TaskNode["status"],
      priority:(row.priority==="high"||row.priority==="medium"||row.priority==="low"?row.priority:null),
      dueLabel:row.dueDate ? dueLabelFromISO(row.dueDate) : "Без срока",dueDate:row.dueDate,
      description:row.description,result:row.result,size:row.size as TaskNode["size"],theme:row.theme as TaskNode["theme"],
      position:row.position,version:row.version,deletedAt:row.deletedAt,splitSourceId:row.splitSourceId,
      deletionBatchId:row.deletionBatchId,children:[],participants:[],
    });
  }
  for (const link of participantRows) {
    const node = byId.get(link.taskId);
    if (node && !node.participants.includes(link.memberId)) node.participants.push(link.memberId);
  }
  for (const node of byId.values()) {
    if (node.parentId) byId.get(node.parentId)?.children.push(node);
  }
  for (const node of byId.values()) node.children.sort((a,b)=>a.position-b.position || a.id.localeCompare(b.id));
  const root = byId.get(ROOT_ID);
  if (!root) throw new Error("Не найден корень задач. Проверьте миграции базы.");
  return root;
});

export async function nextPosition(parentId: string): Promise<number> {
  const row = await getDb().get<{max:number|null}>(sql`SELECT MAX(position) AS max FROM tasks WHERE parent_id=${parentId}`);
  return (row?.max ?? -1)+1;
}
