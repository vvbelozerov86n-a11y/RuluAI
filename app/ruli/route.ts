import landing from "@/showcase/ruli.html?raw";

export function GET(): Response {
  return new Response(landing, { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=0, must-revalidate",
  } });
}
