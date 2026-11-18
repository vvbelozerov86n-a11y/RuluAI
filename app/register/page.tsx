import Link from "next/link";
import { redirect } from "next/navigation";
import { chatGPTSignInPath, getChatGPTUser } from "@/app/chatgpt-auth";
import { CompanyRegistrationForm } from "@/components/ruli/company-registration";
import { getCompanyRegistrationAccess } from "@/lib/ruli/company-profile";
import "@/components/ruli/company-registration.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Регистрация компании" };

export default async function RegisterPage() {
  const user = await getChatGPTUser();
  const access = user ? await getCompanyRegistrationAccess() : null;
  if (access?.kind === "manager" && access.registered) redirect("/team#company-invite");
  const initialName = user?.fullName || (access?.kind === "manager" && access.displayName !== "Руководитель" ? access.displayName : "");
  return <main className="workspace onboarding-page"><div className="editor-page">
    <div className="editor-panel">
      <h1>Регистрация компании</h1>
      {access?.kind === "member" ? <>
        <p>Ваш аккаунт уже входит в команду. Для регистрации другой компании нужен отдельный аккаунт.</p>
        <Link className="primary" href="/team">Открыть свою команду</Link>
      </> : user ? <>
        <p>Укажите название компании и своё имя. Вы станете руководителем и получите ссылку для приглашения сотрудников.</p>
        <CompanyRegistrationForm initialName={initialName}/>
      </> : <>
        <p>Войдите через ChatGPT, чтобы создать свою компанию и пригласить сотрудников по ссылке.</p>
        <a className="primary" href={chatGPTSignInPath("/register")} target="_top">Войти через ChatGPT</a>
      </>}
    </div>
    <Link className="editor-back onboarding-back" href="/">← На главную</Link>
  </div></main>;
}
