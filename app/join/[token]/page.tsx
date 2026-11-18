import Link from "next/link";
import type { Metadata } from "next";
import { chatGPTSignInPath, chatGPTSignOutPath, getChatGPTUser } from "@/app/chatgpt-auth";
import { EmployeeJoinForm } from "@/components/ruli/company-registration";
import { getCompanyInvitation, getExistingInviteMember } from "@/lib/ruli/company-invites";
import "@/components/ruli/company-registration.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Приглашение в команду",
  robots: { index: false, follow: false },
  // Keep the invite URL on this origin and preserve Origin on native same-site form submissions.
  referrer: "same-origin",
};

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const company = await getCompanyInvitation(token);
  if (!company) return <main className="workspace onboarding-page"><div className="editor-page"><div className="editor-panel">
    <h1>Приглашение недействительно</h1>
    <p>Попросите руководителя прислать действующую ссылку для регистрации.</p>
    <Link className="secondary" href="/">На главную</Link>
  </div></div></main>;

  const user = await getChatGPTUser();
  const member = user ? await getExistingInviteMember(user, company.workspaceId) : null;
  return <main className="workspace onboarding-page"><div className="editor-page"><div className="editor-panel">
    <h1>Вас пригласили в «{company.name}»</h1>
    {member?.foreign ? <>
      <p>Аккаунт уже связан с другой компанией. Чтобы принять это приглашение, войдите с другим аккаунтом ChatGPT.</p>
      <a className="primary" href={chatGPTSignOutPath(`/join/${encodeURIComponent(token)}`)}>Сменить аккаунт</a>
    </> : member ? <>
      <p>{member.bound ? "Вы уже в команде" : "Руководитель уже добавил вас в команду"} под именем <strong>{member.displayName}</strong>.</p>
      {member.bound ? <Link className="primary" href="/">Открыть команду</Link>
        : <EmployeeJoinForm token={token} initialName={member.displayName} pendingMember/>}
    </> : user ? <>
      <p>Вы вошли как <strong>{user.email}</strong>. Укажите имя, которое увидят коллеги в задачах и обсуждениях.</p>
      <EmployeeJoinForm token={token} initialName={user.fullName || ""}/>
    </> : <>
      <p>Войдите через ChatGPT и укажите своё имя, чтобы присоединиться к команде.</p>
      <a className="primary" href={chatGPTSignInPath(`/join/${encodeURIComponent(token)}`)}>Войти через ChatGPT</a>
    </>}
  </div></div></main>;
}
