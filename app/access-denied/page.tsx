import Link from "next/link";
export const dynamic = "force-dynamic";
export default function AccessDenied() {
  return <main className="workspace"><div className="editor-panel"><h1>Нужен доступ к команде</h1>
    <p>Попросите руководителя прислать ссылку на регистрацию и откройте её под своим аккаунтом ChatGPT.</p>
    <p>Если вы руководитель новой компании, зарегистрируйте её и пригласите свою команду.</p>
    <div className="entry-actions"><Link className="secondary" href="/">Проверить доступ</Link>
    <Link className="primary" href="/register">Зарегистрировать компанию</Link></div></div></main>;
}
