/**
 * Безопасный путь возврата после входа: только относительные адреса
 * с одним ведущим «/», без открытого редиректа на другой origin.
 */
const AUTH_PATHS = new Set(["/signin-with-chatgpt", "/signout-with-chatgpt", "/callback"]);

export type SearchParamRecord = Record<string, string | string[] | undefined>;

export function safeRelativeReturnPath(value: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (/[\0\r\n\\]/.test(value)) return "/";
  let url: URL;
  try {
    url = new URL(value, "https://app.local");
  } catch {
    return "/";
  }
  if (url.origin !== "https://app.local" || url.protocol !== "https:" || url.username || url.password) return "/";
  if (AUTH_PATHS.has(url.pathname)) return "/";
  if (!url.pathname.startsWith("/") || url.pathname.startsWith("//")) return "/";
  const result = `${url.pathname}${url.search}${url.hash}`;
  if (!result.startsWith("/") || result.startsWith("//") || /[\0\r\n\\]|%0[da]/i.test(result)) return "/";
  return result;
}

/** Собирает путь страницы и оставляет только явно разрешённые query-параметры. */
export function returnPath(pathname: string, searchParams?: SearchParamRecord, allowedKeys: readonly string[] = []): string {
  if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.startsWith("//")) return "/";
  const query = new URLSearchParams();
  if (searchParams) {
    for (const key of allowedKeys) {
      const value = searchParams[key];
      if (typeof value === "string" && value) query.set(key, value);
    }
  }
  const qs = query.toString();
  return safeRelativeReturnPath(qs ? `${pathname}?${qs}` : pathname);
}

export function homeReturnPath(params: SearchParamRecord): string {
  return returnPath("/",params,["q","owner","status","late","due","mode","layout","chat"]);
}

/** Путь карточки или формы изменения; id кодируется как один сегмент. */
export function taskPagePath(id: string, searchParams?: SearchParamRecord, suffix: "" | "/edit" = ""): string {
  if (typeof id !== "string" || !id) return "/";
  const pathname = id === "root" && suffix === "" ? "/" : `/t/${encodeURIComponent(id)}${suffix}`;
  const keys = suffix === "/edit" ? ["mode"] as const : ["mode", "layout", "chat"] as const;
  return returnPath(pathname, searchParams, keys);
}
