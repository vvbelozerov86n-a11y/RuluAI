import Link from "next/link";
export const dynamic = "force-dynamic";
export default function AccessDenied() {
  return <main className="workspace"><div className="editor-panel"><h1>Нужен доступ к команде</h1>
    <p>Вход выполнен, но этот аккаунт пока не добавлен в команду. Попросите руководителя указать вашу почту на странице команды.</p>
    <Link href="/">Проверить доступ</Link></div></main>;
}
