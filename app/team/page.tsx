import Link from "next/link";
import {getMembers} from "@/lib/ruli/data";
import {requireAccess,canManage,listAccessAccounts} from "@/lib/ruli/access";
import {chatGPTSignInPath} from "@/app/chatgpt-auth";
import {Avatar} from "@/components/ruli/ui";
import {Toasts} from "@/components/ruli/views";
import {TeamRegistration,TeamSignInLink} from "@/components/ruli/team-registration";
import {AiSettings} from "@/components/ruli/ai-settings";
import {loadBotSettings} from "@/lib/ruli/ai";
import "@/components/ruli/team-management.css";
export const dynamic="force-dynamic";
export const metadata={title:"Команда"};
export default async function TeamPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const viewer=await requireAccess("/team"),params=await searchParams,members=await getMembers(),manager=canManage(viewer),accounts=manager?await listAccessAccounts():[];
  const linkedMembers=new Set(accounts.map(account=>account.memberId));
  const humans=members.filter(member=>member.type==="human");
  const availableMembers=humans.filter(member=>member.id!=="me"&&!linkedMembers.has(member.id)).map(({id,name})=>({id,name}));
  return <main className="workspace team-management"><div className="editor-page"><div className="editor-topline"><Link className="editor-back" href="/">← Ко всем задачам</Link><span className="editor-eyebrow">ЛЮДИ И AI-БОТЫ</span></div><div className="editor-panel">
    <h1>Команда</h1><p>Ответственные и участники назначаются на каждую задачу.</p><Toasts flash={typeof params.flash==="string"?params.flash:undefined} error={typeof params.error==="string"?params.error:undefined}/>
    {manager?<>
      <nav className="team-section-nav" aria-label="Управление командой">
        <a href="#register-employee"><strong>Регистрация сотрудников</strong><span>Добавить человека и настроить его права</span></a>
        <a href="#ai-settings-title"><strong>AI-боты</strong><span>Настроить модели и внешних агентов</span></a>
        <a href="#create-bot"><strong>Создать бота</strong><span>Добавить AI-исполнителя в команду</span></a>
      </nav>
      <section className="team-access" id="register-employee" aria-labelledby="register-employee-title">
        <h2 id="register-employee-title">Регистрация сотрудников</h2>
        <p>Зарегистрируйте сотрудника по почте, с которой он будет входить в Рули через ChatGPT. Письмо-приглашение не отправляется.</p>
        <TeamRegistration availableMembers={availableMembers}/>
        <aside className="team-access-help" aria-labelledby="team-signin-title">
          <h3 id="team-signin-title">Как сотруднику войти</h3>
          <ol><li>Зарегистрируйте сотрудника в форме выше.</li><li>Владелец сайта отдельно разрешает сотруднику доступ к сайту в настройках Sites. Регистрация в Рули не меняет доступ к самому сайту.</li><li>Передайте ссылку для входа. Сотрудник должен войти через ChatGPT с указанной при регистрации почтой.</li></ol>
          <TeamSignInLink signInPath={chatGPTSignInPath("/")}/>
        </aside>
        {accounts.length?<details className="team-accounts"><summary>Зарегистрированные аккаунты · {accounts.length}</summary><ul className="account-list">{accounts.map(account=><li key={account.email}><strong>{account.name}</strong><span>{account.email}</span><small>{account.role==="manager"?"Руководитель":account.role==="executor"?"Исполнитель":"Наблюдатель"} · {account.userId?"Вход выполнен":"Ожидается первый вход"}</small></li>)}</ul></details>:null}
      </section>
    </>:<p className="detail-note">Сотрудников регистрирует и настраивает AI-ботов руководитель команды.</p>}
    <section className="team-people" aria-labelledby="team-people-title"><h2 id="team-people-title">Люди в команде</h2>{humans.map(member=><div className="member-row" key={member.id}><Avatar member={member}/><div>{member.name}<small>{member.role}</small></div></div>)}</section>
    {manager?<AiSettings data={await loadBotSettings()}/>:<section className="team-people" aria-labelledby="team-bots-title"><h2 id="team-bots-title">AI-боты</h2><p>Подключённый бот может выполнять поручения и отвечать в обсуждениях.</p>{members.filter(member=>member.type==="bot").map(member=><div className="member-row" key={member.id}><Avatar member={member}/><div>{member.name}<small>{member.role}</small></div></div>)}</section>}
  </div></div></main>;
}

