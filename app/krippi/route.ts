import promo from "@/showcase/krippi.html?raw";

export function GET(): Response {
  return new Response(promo, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
