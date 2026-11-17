"use client";
import {useFormStatus} from "react-dom";
import type {ReactNode} from "react";
export function SubmitButton({children,className="primary",pendingLabel="Сохраняем…",disabled=false}:{children:ReactNode;className?:string;pendingLabel?:string;disabled?:boolean}) {
  const {pending}=useFormStatus();
  return <button type="submit" className={className} disabled={pending||disabled} aria-disabled={pending||disabled}>{pending?pendingLabel:children}</button>;
}
