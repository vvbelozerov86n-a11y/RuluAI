import { getChatGPTUser } from "@/app/chatgpt-auth";
import { requireAccess, canReadChannel } from "@/lib/ruli/access";
import { loadTree, getMembers } from "@/lib/ruli/data";
import { findPath } from "@/lib/ruli/model";
import { loadTaskCollaboration, taskChannelMembers } from "@/lib/ruli/collaboration";

export const dynamic = "force-dynamic";
const headers = {"Cache-Control":"private, no-store", "Vary":"Cookie"};

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
  if (!await getChatGPTUser()) return Response.json({error:"Войдите в аккаунт"},{status:401,headers});
  const viewer=await requireAccess();
  const {id}=await params;
  const node=findPath(id,await loadTree())?.at(-1);
  if (!node) return Response.json({error:"Задача не найдена"},{status:404,headers});
  const raw=new URL(request.url).searchParams.get("channel");
  const channel=raw && raw!=="general"?raw:null;
  if (!canReadChannel(viewer,channel) || (channel && !taskChannelMembers(node,await getMembers(),viewer).some(m=>m.id===channel))) {
    return Response.json({error:"Диалог недоступен"},{status:403,headers});
  }
  const {messages}=await loadTaskCollaboration(node,viewer,channel??undefined);
  return Response.json({messages},{headers});
}
