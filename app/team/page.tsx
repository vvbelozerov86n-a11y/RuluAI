import Link from "next/link";
import {getMembers} from "@/lib/ruli/data";
import {requireAccess,canManage,listAccessAccounts} from "@/lib/ruli/access";
import {addTeamMember} from "@/app/team-actions";
import {Avatar} from "@/components/ruli/ui";
import {Toasts} from "@/components/ruli/views";
import {SubmitButton} from "@/components/ruli/submit-button";
import {AiSettings} from "@/components/ruli/ai-settings";
import {loadBotSettings} from "@/lib/ruli/ai";
export const dynamic="force-dynamic";
export const metadata={title:"Команда"};
export default async function TeamPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const viewer=await requireAccess(),params=await searchParams,members=await getMembers(),manager=canManage(viewer),accounts=manager?await listAccessAccounts():[];
  return <main className="workspace"><div className="editor-page"><div className="editor-topline"><Link className="editor-back" href="/">← Ко всем задачам</Link><span className="editor-eyebrow">ЛЮДИ И AI-БОТЫ</span></div><div className="editor-panel">
    <h1>Команда</h1><p>Ответственные и участники назначаются на каждую задачу.</p><Toasts flash={typeof params.flash==="string"?params.flash:undefined} error={typeof params.error==="string"?params.error:undefined}/>
    {members.map(member=><div className="member-row" key={member.id}><Avatar member={member}/><div>{member.name}<small>{member.role} · {member.type==="bot"?"AI-бот":"Человек"}</small></div></div>)}
    {manager?<AiSettings data={await loadBotSettings()}/>:<p className="detail-note">AI-ботов настраивает руководитель. Подключённый бот может выполнять поручения и отвечать в обсуждениях.</p>}
    {manager?<section className="team-access"><h2>Доступ участников</h2><p>Участник входит под указанной почтой. Исполнитель может работать со своими задачами и обсуждениями, наблюдатель — только просматривать.</p>
      {accounts.length?<ul className="account-list">{accounts.map(account=><li key={account.email}><strong>{account.name}</strong><span>{account.email}</span><small>{account.role==="manager"?"Руководитель":account.role==="executor"?"Исполнитель":"Наблюдатель"} · {account.userId?"Вход выполнен":"Ожидается первый вход"}</small></li>)}</ul>:null}
      <form action={addTeamMember}><h3>Добавить участника</h3><label>Имя<input name="name" required maxLength={120} placeholder="Имя и фамилия"/></label><label>Почта для входа<input name="email" type="email" required maxLength={254} placeholder="name@example.com"/></label><div className="form-pair"><label>Права<select name="role" defaultValue="executor"><option value="executor">Исполнитель</option><option value="viewer">Наблюдатель</option></select></label><label>Связать с участником<select name="memberId" defaultValue=""><option value="">Создать нового</option>{members.filter(m=>m.type==="human").map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label></div><SubmitButton>Добавить доступ</SubmitButton></form>
    </section>:null}
  </div></div></main>;
}

