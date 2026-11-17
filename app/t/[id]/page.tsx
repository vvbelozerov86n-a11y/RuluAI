import type {Metadata} from "next";
import {notFound} from "next/navigation";
import {DetailView,GroupView,type ViewMode,type OverviewLayout} from "@/components/ruli/views";
import {getMembers,loadTree} from "@/lib/ruli/data";
import {findPath,todayISO} from "@/lib/ruli/model";
import {requireAccess,canManage} from "@/lib/ruli/access";
import {taskPagePath} from "@/lib/ruli/return-path";
export const dynamic="force-dynamic";
type PageProps={params:Promise<{id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>};
const one=(v:string|string[]|undefined)=>typeof v==="string"?v:undefined;
export async function generateMetadata({params}:PageProps):Promise<Metadata> {
  const {id}=await params;
  await requireAccess(taskPagePath(id));
  const tree=await loadTree(),path=findPath(id,tree);
  return {title:path?.at(-1)?.title??"Задача не найдена"};
}
export default async function TaskPage({params,searchParams}:PageProps) {
  const {id}=await params,query=await searchParams,viewer=await requireAccess(taskPagePath(id,query));
  const [tree,members]=await Promise.all([loadTree(),getMembers()]);
  const path=findPath(id,tree);if(!path)notFound();
  const node=path.at(-1)!,mode:ViewMode=query.mode==="build"&&canManage(viewer)?"build":"view";
  const layout:OverviewLayout=query.layout==="cards"?"cards":"list";
  const common={path,members,mode,layout,today:todayISO(),viewer,flash:one(query.flash),error:one(query.error),channel:one(query.chat)};
  return node.kind==="group"?<GroupView node={node} {...common}/>:<DetailView node={node} {...common}/>;
}

