import type {Metadata} from "next";
import {notFound} from "next/navigation";
import {DetailView,GroupView,type ViewMode,type OverviewLayout} from "@/components/ruli/views";
import {getMembers,loadTree} from "@/lib/ruli/data";
import {findPath,todayISO} from "@/lib/ruli/model";
import {requireAccess,canManage} from "@/lib/ruli/access";
export const dynamic="force-dynamic";
type PageProps={params:Promise<{id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>};
const one=(v:string|string[]|undefined)=>typeof v==="string"?v:undefined;
export async function generateMetadata({params}:PageProps):Promise<Metadata> {
  await requireAccess();
  const {id}=await params,tree=await loadTree(),path=findPath(id,tree);
  return {title:path?.at(-1)?.title??"Задача не найдена"};
}
export default async function TaskPage({params,searchParams}:PageProps) {
  const viewer=await requireAccess(),{id}=await params,query=await searchParams;
  const [tree,members]=await Promise.all([loadTree(),getMembers()]);
  const path=findPath(id,tree);if(!path)notFound();
  const node=path.at(-1)!,mode:ViewMode=query.mode==="build"&&canManage(viewer)?"build":"view";
  const layout:OverviewLayout=query.layout==="cards"?"cards":"list";
  const common={path,members,mode,layout,today:todayISO(),viewer,flash:one(query.flash),error:one(query.error),channel:one(query.chat)};
  return node.kind==="group"?<GroupView node={node} {...common}/>:<DetailView node={node} {...common}/>;
}

