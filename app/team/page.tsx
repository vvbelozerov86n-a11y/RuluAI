import Link from "next/link";
import {getMembers} from "@/lib/ruli/data";
import {requireAccess,canManage,listAccessAccounts} from "@/lib/ruli/access";
import {chatGPTSignInPath} from "@/app/chatgpt-auth";
import {Avatar} from "@/components/ruli/ui";
import {Toasts} from "@/components/ruli/views";
import {PendingEmailCorrection,TeamMemberRemoval,TeamRegistration,TeamSignInLink} from "@/components/ruli/team-registration";
import {AiSettings} from "@/components/ruli/ai-settings";
import {loadBotSettings} from "@/lib/ruli/ai";
import {getCurrentCompanyName,getManagerCompanyProfile} from "@/lib/ruli/company-profile";
import {CompanyInviteLink} from "@/components/ruli/company-registration";
import "@/components/ruli/team-management.css";
import "@/components/ruli/company-registration.css";
export const dynamic="force-dynamic";
export const metadata={title:"Команда"};
export default async function TeamPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const viewer=await requireAccess("/team"),params=await searchParams,members=await getMembers(),manager=canManage(viewer),accounts=manager?await listAccessAccounts():[];
  const company=manager?await getManagerCompanyProfile():null;
  const companyName=manager?company?.name:await getCurrentCompanyName();
  const linkedMembers=new Set(accounts.map(account=>account.memberId));
  const protectedMembers=new Set(["me",viewer.memberId,...accounts.filter(account=>account.role==="manager").map(account=>account.memberId)]);
  const removalNotice=manager&&params.result==="removed";
  const inviteNotice=manager&&params.result==="invite";
  const flash=typeof params.flash==="string"?params.flash:undefined;
  const humans=members.filter(member=>member.type==="human");
  const availableMembers=humans.filter(member=>member.id!=="me"&&!linkedMembers.has(member.id)).map(({id,name})=>({id,name}));
  return <main className="workspace team-management"><div className="editor-page"><div className="editor-topline"><Link className="editor-back" href="/">← Ко всем задачам</Link><span className="editor-eyebrow">ЛЮДИ И AI-БОТЫ</span></div><div className="editor-panel">
    <h1 className="company-name">{companyName?`Команда «${companyName}»`:"Команда"}</h1><p>Ответственные и участники назначаются на каждую задачу.</p><Toasts flash={removalNotice||inviteNotice?undefined:flash} error={typeof params.error==="string"?params.error:undefined}/>
    {manager?<>
      <nav className="team-section-nav" aria-label="Управление командой">
        <a href="#company-invite"><strong>Пригласить сотрудников</strong><span>{company?"Отправить ссылку для регистрации":"Зарегистрировать компанию и получить ссылку"}</span></a>
        <a href="#team-people"><strong>Люди в команде</strong><span>Посмотреть список и удалить сотрудника</span></a>
        <a href="#ai-settings-title"><strong>AI-боты</strong><span>Настроить модели и внешних агентов</span></a>
        <a href="#create-bot"><strong>Создать бота</strong><span>Добавить AI-исполнителя в команду</span></a>
      </nav>
      <section className="team-access" id="company-invite" aria-labelledby="company-invite-title">
        <h2 id="company-invite-title">Пригласить сотрудников</h2>
        {inviteNotice?<Toasts flash={flash}/>:null}
        {company ? <>
          <p>Отправьте ссылку своим сотрудникам. По ней они смогут зарегистрироваться в вашей компании с ролью исполнителя.</p>
          <CompanyInviteLink key={company.inviteToken} token={company.inviteToken} companyName={company.name}/>
        </> : <>
          <p>Зарегистрируйте компанию, чтобы получить общую ссылку для сотрудников.</p>
          <Link href="/register" className="primary">Зарегистрировать компанию</Link>
        </>}
        <p className="team-access-site-note">На закрытом сайте сотрудникам также понадобится доступ в настройках Sites.</p>
      </section>
      <section className="team-access" aria-label="Регистрация по почте и аккаунты">
        <details className="company-manual"><summary>Добавить сотрудника по почте</summary>
        <div id="register-employee">
        <p>Укажите почту сотрудника, чтобы заранее назначить ему права или связать аккаунт с существующими задачами.</p>
        <TeamRegistration availableMembers={availableMembers}/>
        <aside className="team-access-help" aria-labelledby="team-signin-title">
          <h3 id="team-signin-title">Вход после добавления по почте</h3>
          {company ? <p>Отправьте сотруднику <a href="#company-invite" className="company-help-link">ссылку для регистрации в вашей компании</a>. Для привязки к существующим задачам он должен войти через ChatGPT с указанной почтой.</p> : <>
            <p>Передайте сотруднику ссылку для входа. Он должен войти через ChatGPT с почтой, которую вы указали.</p>
            <TeamSignInLink signInPath={chatGPTSignInPath("/")}/>
          </>}
        </aside>
        </div></details>
        {accounts.length?<details className="team-accounts"><summary>Зарегистрированные аккаунты · {accounts.length}</summary><ul className="account-list">{accounts.map(account=><li key={account.email}><strong>{account.name}</strong><span>{account.email}</span><small>{account.role==="manager"?"Руководитель":account.role==="executor"?"Исполнитель":"Наблюдатель"} · {account.userId?"Вход выполнен":"Ожидается первый вход"}</small>{!account.userId&&account.memberId!=="me"&&["executor","viewer"].includes(account.role)?<PendingEmailCorrection memberId={account.memberId} email={account.email}/>:null}</li>)}</ul></details>:null}
      </section>
    </>:<p className="detail-note">Ссылку для регистрации новых сотрудников можно получить у руководителя команды.</p>}
    <section id="team-people" className="team-people" tabIndex={-1} aria-labelledby="team-people-title">
      <h2 id="team-people-title">Люди в команде</h2>
      {removalNotice?<Toasts flash={flash}/>:null}
      {humans.map(member=><div className="member-row team-person" key={member.id}>
        <Avatar member={member}/><div className="team-person-name">{member.name}<small>{member.role}</small></div>
        {manager&&!protectedMembers.has(member.id)?<TeamMemberRemoval memberId={member.id} name={member.name}/>:null}
      </div>)}
    </section>
    {manager?<AiSettings data={await loadBotSettings()}/>:<section className="team-people" aria-labelledby="team-bots-title"><h2 id="team-bots-title">AI-боты</h2><p>Подключённый бот может выполнять поручения и отвечать в обсуждениях.</p>{members.filter(member=>member.type==="bot").map(member=><div className="member-row" key={member.id}><Avatar member={member}/><div>{member.name}<small>{member.role}</small></div></div>)}</section>}
  </div></div></main>;
}

