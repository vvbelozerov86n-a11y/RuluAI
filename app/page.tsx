import {GroupView,type ViewMode} from "@/components/ruli/views";
import {getMembers,loadTree} from "@/lib/ruli/data";
import {todayISO} from "@/lib/ruli/model";
import {requireAccess,canManage} from "@/lib/ruli/access";
import {returnPath} from "@/lib/ruli/return-path";
import {listTaskDeliveries} from "@/lib/ruli/agent-runtime";
import {deliverySummaries} from "@/components/ruli/bot-delivery";
import {getD1} from "@/db";
export const dynamic="force-dynamic";
const one=(v:string|string[]|undefined)=>typeof v==="string"?v:undefined;
export default async function Home({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const params=await searchParams,viewer=await requireAccess(returnPath("/",params,["q","owner","status","late","due","mode","layout","chat"]));
  const [tree,members]=await Promise.all([loadTree(),getMembers()]);
  const mode:ViewMode=params.mode==="build"&&canManage(viewer)?"build":"view";
  const deliveries=canManage(viewer)?deliverySummaries(await listTaskDeliveries(getD1(),tree.id)):[];
  return <GroupView node={tree} path={[tree]} members={members} mode={mode} layout={params.layout==="list"?"list":"cards"} today={todayISO()} viewer={viewer} flash={one(params.flash)} error={one(params.error)} channel={one(params.chat)} filters={{q:one(params.q),owner:one(params.owner),status:one(params.status),late:params.late==="1"?"1":undefined,due:params.due==="today"?"today":undefined}} deliveries={deliveries}/>;
}

