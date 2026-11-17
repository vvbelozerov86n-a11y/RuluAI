import type { Metadata } from "next";
import Link from "next/link";
import { getChatGPTUser } from "./chatgpt-auth";
import "./globals.css";
import "./ruli.css";

export const metadata: Metadata = {
  title: {
    default: "Рули — задачи по уровням",
    template: "%s — Рули",
  },
  description: "Задачи команды: от крупных целей до поручений людям и AI.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part.slice(0, 1).toUpperCase()).join("") || "ВЫ";
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await getChatGPTUser();

  return (
    <html lang="ru">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* App Router: шрифт из корневого layout применяется ко всем страницам. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;550;600;650&display=swap"
        />
      </head>
      <body className="bento antialiased">
        <header className="topbar">
          <Link href="/" className="brand" aria-label="Рули — все задачи">
            <span className="brand-mark">
              <i />
              <i />
              <i />
            </span>
            рули<span className="brand-dot">.</span>
          </Link>
          <span className="workspace-label">Моя команда</span>
          <div className="topbar-right">
            <span className="prototype-label">Рабочая версия</span>
            <Link className="team-button" href="/team" aria-label="Открыть команду">
              <span className="team-button-label">Команда и AI</span>
              {user ? (
                <span className="avatar small" title={user.email}>
                  {initialsOf(user.fullName || user.displayName)}
                </span>
              ) : (
                <span className="avatar small" title="Команда">
                  ВЫ
                </span>
              )}
            </Link>
            {user ? (
              <a className="auth-link" href={`/signout-with-chatgpt?return_to=/`}>
                Выйти
              </a>
            ) : (
              <a className="auth-link" href={`/signin-with-chatgpt?return_to=/`}>
                Войти
              </a>
            )}
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
