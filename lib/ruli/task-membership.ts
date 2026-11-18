import type {TaskNode} from "./model";

export type MembershipSource = {id:string;title:string};
/** Direct assignments remain editable separately from active descendant access. */
export function inheritedMembership(node:TaskNode):Map<string,MembershipSource[]> {
  const result=new Map<string,MembershipSource[]>();
  function visit(child:TaskNode) {
    if(child.deletedAt)return;
    for(const id of new Set([child.ownerId,...child.participants].filter(Boolean))) {
      const sources=result.get(id)??[];
      sources.push({id:child.id,title:child.title});result.set(id,sources);
    }
    if(child.kind==="group")child.children.forEach(visit);
  }
  if(node.kind==="group")node.children.forEach(visit);
  return result;
}
