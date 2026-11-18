import { getChatGPTUser } from "@/app/chatgpt-auth";
import { requireAccess } from "@/lib/ruli/access";
import { taskPagePath } from "@/lib/ruli/return-path";
import { loadTree } from "@/lib/ruli/data";
import { findPath } from "@/lib/ruli/model";
import { loadMessagePage, MessagePageError, type ChatAiRun } from "@/lib/ruli/collaboration";
import { loadTaskAi } from "@/lib/ruli/ai";

export const dynamic = "force-dynamic";
const headers = {"Cache-Control":"private, no-store", "Vary":"Cookie"};

function isTeamAccessDeniedRedirect(error:unknown):boolean {
  if(!error||typeof error!=="object"||!("digest" in error)||typeof error.digest!=="string")return false;
  // Recognize only the exact access.ts destination, using the installed
  // Vinext encoded digest and Next's canonical form. All other control flow propagates.
  return /^NEXT_REDIRECT;(?:push|replace)?;%2Faccess-denied(?:;(?:303|307|308))?$/.test(error.digest)
    || /^NEXT_REDIRECT;(?:push|replace);\/access-denied;(?:303|307|308);$/.test(error.digest);
}

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
  if (!await getChatGPTUser()) return Response.json({error:"Войдите в аккаунт"},{status:401,headers});
  const {id}=await params;
  const query=new URL(request.url).searchParams;
  const raw=query.get("channel");
  const channel=raw && raw!=="general"?raw:null;
  try {
    const page=await loadMessagePage(id,channel,query.get("before"));
    const viewer=await requireAccess(taskPagePath(id));
    const node=findPath(id,await loadTree())?.at(-1);
    if (!node) return Response.json({error:"Задача не найдена"},{status:404,headers});
    const ai=await loadTaskAi(node,viewer,channel??undefined);
    const aiPending=ai.chatRuns.filter(run=>run.status==="pending").length;
    const aiRuns:ChatAiRun[]=ai.chatRuns.map(run=>({
      id:run.id,botMemberId:run.botMemberId,channelMemberId:run.channelMemberId,inputMessageId:run.inputMessageId,
      error:run.error,status:run.status,canRetry:run.canRetry,createdAt:run.createdAt,finishedAt:run.finishedAt,
    }));
    return Response.json({...page,aiPending,aiRuns},{headers});
  }
  catch(error) {
    if(error instanceof MessagePageError)return Response.json({error:error.message},{status:error.status,headers});
    if(isTeamAccessDeniedRedirect(error))return Response.json({error:"У вас нет доступа к этой команде."},{status:403,headers});
    throw error;
  }
}
