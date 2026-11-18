"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { homeReturnPath, safeRelativeReturnPath } from "@/lib/ruli/return-path";

export function HeaderAuth({ signedIn }: { signedIn: boolean }) {
  const pathname = usePathname() || "/";
  const params = useSearchParams();
  const onboarding = pathname === "/register" || pathname.startsWith("/join/");
  const returnTo = !signedIn && pathname === "/" && params
    ? homeReturnPath(Object.fromEntries(params.entries()))
    : safeRelativeReturnPath(onboarding ? pathname : "/");
  const action = signedIn ? "signout-with-chatgpt" : "signin-with-chatgpt";
  return <>
    {!signedIn && !onboarding && <Link className="auth-link" href="/register">Регистрация</Link>}
    <a className="auth-link" href={`/${action}?return_to=${encodeURIComponent(returnTo)}`}>
      {signedIn ? "Выйти" : "Войти"}
    </a>
  </>;
}
