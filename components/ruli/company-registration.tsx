"use client";

import { useActionState, useId, useRef, useState, useSyncExternalStore } from "react";
import { registerCompanyState } from "@/app/company-actions";
import { acceptCompanyInviteState, rotateCompanyInviteState } from "@/app/invite-actions";
import type { ActionState } from "@/lib/ruli/action-state";
import { SubmitButton } from "./submit-button";

export function CompanyRegistrationForm({ initialName }: { initialName: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(registerCompanyState, {});
  const formId = useId();
  const companyError = state.fieldErrors?.companyName;
  const managerError = state.fieldErrors?.managerName;
  const [companyName, setCompanyName] = useState(() => typeof state.values?.companyName === "string" ? state.values.companyName : "");
  const [managerName, setManagerName] = useState(() => typeof state.values?.managerName === "string" ? state.values.managerName : initialName);
  return <form className="company-form" action={action} aria-busy={pending}>
    <label>Название компании
      <input name="companyName" autoComplete="organization" value={companyName} onChange={event => setCompanyName(event.target.value)}
        maxLength={120} required readOnly={pending} aria-invalid={companyError ? true : undefined}
        aria-describedby={companyError ? `${formId}-company` : undefined}/>
    </label>
    {companyError && <p className="company-field-error" id={`${formId}-company`}>{companyError}</p>}
    <label>Ваше имя и фамилия
      <input name="managerName" autoComplete="name" value={managerName} onChange={event => setManagerName(event.target.value)}
        maxLength={120} required readOnly={pending} aria-invalid={managerError ? true : undefined}
        aria-describedby={managerError ? `${formId}-manager` : undefined}/>
    </label>
    {managerError && <p className="company-field-error" id={`${formId}-manager`}>{managerError}</p>}
    {state.error && <p className="form-error" role="alert">{state.error}</p>}
    <SubmitButton disabled={pending} pendingLabel="Регистрируем…">Зарегистрировать компанию</SubmitButton>
  </form>;
}

export function EmployeeJoinForm({ token, initialName, pendingMember = false }: { token: string; initialName: string; pendingMember?: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(acceptCompanyInviteState, {});
  const errorId = useId();
  const nameError = state.fieldErrors?.name;
  const [name, setName] = useState(() => typeof state.values?.name === "string" ? state.values.name : initialName);
  return <form className="company-form" action={action} aria-busy={pending}>
    <input type="hidden" name="token" value={token}/>
    {pendingMember ? <input type="hidden" name="name" value={initialName}/> : <label>Ваше имя и фамилия
      <input name="name" autoComplete="name" value={name} onChange={event => setName(event.target.value)}
        maxLength={120} required readOnly={pending} aria-invalid={nameError ? true : undefined}
        aria-describedby={nameError ? errorId : undefined}/>
    </label>}
    {nameError && <p className="company-field-error" id={errorId} role="alert">{nameError}</p>}
    {state.error && state.error !== nameError && <p className="form-error" role="alert">{state.error}</p>}
    <SubmitButton disabled={pending} pendingLabel="Присоединяем…">{pendingMember ? "Войти в команду" : "Присоединиться к команде"}</SubmitButton>
  </form>;
}

const subscribe = () => () => {};

export function CompanyInviteLink({ token, companyName }: { token: string; companyName: string }) {
  const [state, rotate, pending] = useActionState<ActionState, FormData>(rotateCompanyInviteState, {});
  const [notice, setNotice] = useState("");
  const linkInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const relativeLink = `/join/${encodeURIComponent(token)}`;
  const origin = useSyncExternalStore(subscribe, () => window.location.origin, () => "");
  const canShare = useSyncExternalStore(subscribe, () => typeof navigator.share === "function", () => false);
  const link = origin + relativeLink;

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setNotice("Ссылка скопирована. Отправьте её сотрудникам.");
    } catch {
      linkInput.current?.focus();
      linkInput.current?.select();
      setNotice("Ссылка выделена. Скопируйте её через меню устройства или клавишами Ctrl+C.");
    }
  }
  async function share() {
    try {
      await navigator.share({ title: `Приглашение в «${companyName}»`, url: link });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setNotice("Не удалось открыть меню отправки. Скопируйте ссылку.");
      }
    }
  }

  return <div className="company-invitation">
    <label htmlFor={id}>Ссылка для регистрации сотрудников</label>
    <input id={id} ref={linkInput} type="text" value={link} readOnly spellCheck={false} onFocus={event => event.currentTarget.select()}/>
    <div className="company-link-actions">
      <button className="primary" type="button" onClick={copy}>Скопировать ссылку</button>
      {canShare && <button className="secondary" type="button" onClick={share}>Поделиться</button>}
    </div>
    {notice && <p role="status">{notice}</p>}
    {origin && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname) &&
      <p className="team-field-help">Эта ссылка откроется только на этом компьютере. Чтобы пригласить сотрудников, скопируйте ссылку в разделе команды на опубликованном сайте.</p>}
    <details className="company-rotate">
      <summary>Заменить ссылку</summary>
      <p>Старая ссылка перестанет работать. Уже зарегистрированные сотрудники сохранят доступ.</p>
      <form action={rotate} aria-busy={pending}>
        <input name="expectedToken" type="hidden" value={token}/>
        {state.error && <p className="form-error" role="alert">{state.error}</p>}
        <SubmitButton className="secondary" disabled={pending} pendingLabel="Создаём ссылку…">Создать новую ссылку</SubmitButton>
      </form>
    </details>
  </div>;
}
