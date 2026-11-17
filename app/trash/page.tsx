import Link from "next/link";
import {redirect} from "next/navigation";
import {listDeletedTasks,restoreTask} from "@/app/actions";
import {requireAccess,canManage} from "@/lib/ruli/access";
import {Toasts} from "@/components/ruli/views";
import {SubmitButton} from "@/components/ruli/submit-button";
export const dynamic="force-dynamic";
export const metadata={title:"Корзина"};
export default async function TrashPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const viewer=await requireAccess();if(!canManage(viewer))redirect("/");
  const params=await searchParams,deleted=await listDeletedTasks();
  return <main className="workspace trash-page"><Link className="editor-back" href="/">← Ко всем задачам</Link><h1>Корзина</h1><p>Удалённые блоки можно восстановить вместе с вложенными задачами и результатами.</p><Toasts flash={typeof params.flash==="string"?params.flash:undefined} error={typeof params.error==="string"?params.error:undefined}/>
    {deleted.length?<ul className="trash-list">{deleted.map(node=><li key={node.id}><div><h2>{node.title}</h2><p>{node.deletedAt?"Удалено "+new Intl.DateTimeFormat("ru-RU",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Barnaul"}).format(new Date(node.deletedAt)):"Удалённый блок"}</p></div><form action={restoreTask}><input type="hidden" name="id" value={node.id}/><input type="hidden" name="version" value={node.version}/><input type="hidden" name="batchId" value={node.deletionBatchId??""}/><SubmitButton>Восстановить</SubmitButton></form></li>)}</ul>:<div className="empty-state"><h2>Корзина пуста</h2><p>Здесь появятся блоки, перемещённые в корзину.</p><Link className="secondary" href="/">К задачам</Link></div>}
  </main>;
}

