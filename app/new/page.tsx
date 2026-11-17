import {notFound,redirect} from "next/navigation";
import {TaskForm} from "@/components/ruli/task-form";
import {getMembers,loadTree} from "@/lib/ruli/data";
import {findPath,ROOT_ID,type ViewMode} from "@/lib/ruli/model";
import {requireAccess,canManage} from "@/lib/ruli/access";
export const dynamic="force-dynamic";
export const metadata={title:"Новая задача"};
export default async function NewTaskPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const viewer=await requireAccess();if(!canManage(viewer))redirect("/");
  const params=await searchParams,parentId=typeof params.parent==="string"?params.parent:ROOT_ID,mode:ViewMode=params.mode==="build"?"build":"view";
  const [tree,members]=await Promise.all([loadTree(),getMembers()]),path=findPath(parentId,tree);if(!path)notFound();
  const parent=path.at(-1)!;if(parent.kind!=="group")notFound();
  return <main className="workspace"><TaskForm kind="create" parentId={parent.id} parentTitle={parent.title} parentVersion={parent.version} members={members} mode={mode}/></main>;
}

