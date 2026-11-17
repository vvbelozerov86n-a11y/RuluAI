import { cache } from "react";
import { getD1 } from "../../db";
import { DEMO_MEMBERS, demoSeedTasks, dueLabelFromISO } from "./model";

/** Schema is migration-owned. A batch prevents a half-initialized demo tree. */
export const initRuli = cache(async (): Promise<void> => {
  const db = getD1();
  const present = await db.prepare("SELECT id FROM tasks WHERE id='root'").first();
  if (present) return;
  const statements: D1PreparedStatement[] = DEMO_MEMBERS.map(member => db.prepare(
    "INSERT INTO members (id,name,short_name,role,initials,color,type) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING"
  ).bind(member.id,member.name,member.shortName,member.role,member.initials,member.color,member.type));
  for (const row of demoSeedTasks()) {
    statements.push(db.prepare(`INSERT INTO tasks
      (id,parent_id,kind,title,owner_id,status,due_label,due_date,description,result,size,theme,position)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(
      row.id,row.parentId,row.kind,row.title,row.ownerId,row.status,
      row.dueDate ? dueLabelFromISO(row.dueDate) : "Без срока",row.dueDate,
      row.description,row.result,row.size,row.theme,row.position));
  }
  await db.batch(statements);
});
