import {notFound,redirect} from "next/navigation";
import {TaskForm} from "@/components/ruli/task-form";
import {getMembers,loadTree} from "@/lib/ruli/data";
import {findPath,ROOT_ID,type ViewMode} from "@/lib/ruli/model";
import {requireAccess,canManage} from "@/lib/ruli/access";
import {taskPagePath} from "@/lib/ruli/return-path";
export const dynamic="force-dynamic";
export const metadata={title:"Изменение задачи"};
export default async function EditTaskPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const {id}=await params,query=await searchParams,viewer=await requireAccess(taskPagePath(id,query,"/edit"));if(!canManage(viewer))redirect("/");
  const mode:ViewMode=query.mode==="build"?"build":"view";
  const [tree,members]=await Promise.all([loadTree(),getMembers()]),path=findPath(id,tree);if(!path)notFound();
  const node=path.at(-1)!;if(node.id===ROOT_ID)redirect("/");
  return <main className="workspace"><TaskForm kind="edit" node={node} members={members} mode={mode}/></main>;
}

