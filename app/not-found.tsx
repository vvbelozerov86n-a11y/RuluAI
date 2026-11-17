import Link from "next/link";

export const metadata = { title: "Задача не найдена" };

export default function NotFound() {
  return (
    <main className="workspace">
      <div className="editor-page">
        <div className="editor-panel">
          <span className="editor-eyebrow">404</span>
          <h1>Задача не найдена</h1>
          <p>Задача могла быть удалена или перемещена. Вернитесь ко всем задачам и откройте её заново.</p>
          <div className="dialog-actions">
            <Link className="primary" href="/">
              Ко всем задачам
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
