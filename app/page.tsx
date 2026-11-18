import {GroupView,type ViewMode} from "@/components/ruli/views";
import {getMembers,loadTree} from "@/lib/ruli/data";
import {todayISO} from "@/lib/ruli/model";
import {requireAccess,canManage} from "@/lib/ruli/access";
import {homeReturnPath} from "@/lib/ruli/return-path";
import {getChatGPTUser} from "@/app/chatgpt-auth";
import {getManagerCompanyProfile} from "@/lib/ruli/company-profile";
import {getCurrentWorkspaceId} from "@/db";
import {redirect} from "next/navigation";
export const dynamic="force-dynamic";
const one=(v:string|string[]|undefined)=>typeof v==="string"?v:undefined;
export default async function Home({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const params=await searchParams;
  const destination=homeReturnPath(params);
  if (!await getChatGPTUser()) {
    redirect("/vitrina" + destination.slice(1));
  }
  if (!await getCurrentWorkspaceId()) redirect("/register");
  const viewer=await requireAccess(destination);
  const [tree,members,profile]=await Promise.all([loadTree(),getMembers(),canManage(viewer)?getManagerCompanyProfile():null]);
  const mode:ViewMode=params.mode==="build"&&canManage(viewer)?"build":"view";
  return <GroupView node={tree} path={[tree]} members={members} mode={mode} layout="cards" today={todayISO()} viewer={viewer} needsCompanyRegistration={canManage(viewer)&&!profile} flash={one(params.flash)} error={one(params.error)} filters={{q:one(params.q),owner:one(params.owner),status:one(params.status),late:params.late==="1"?"1":undefined,due:params.due==="today"?"today":undefined}}/>;
}

