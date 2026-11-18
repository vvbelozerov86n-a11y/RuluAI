import showcase from "@/showcase/belozerov.html?raw";
import { chatGPTSignInPath } from "@/app/chatgpt-auth";
import { homeReturnPath } from "@/lib/ruli/return-path";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const signIn = chatGPTSignInPath(homeReturnPath(params));
  const html = showcase.replaceAll('href="/signin-with-chatgpt?return_to=%2F"', `href="${signIn}"`);
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
  } });
}
