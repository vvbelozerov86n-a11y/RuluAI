import type { SVGProps } from "react";

const PATHS = {
  plus: "M12 5v14M5 12h14",
  spark: "m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8Z",
  check: "m5 12 4 4L19 6",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  layers: "m12 3 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5",
  edit: "m16 3 5 5-12 12H4v-5L16 3zM14 5l5 5",
  back: "m14 6-6 6 6 6",
  person: "M12 5v14M5 12h14",
} as const;

const PERSON_ICON =
  '<circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>';
const BOT_ICON =
  '<rect x="4" y="7" width="16" height="14" rx="3"/><path d="M12 3v4M9 12v2M15 12v2M9 17h6M2 12h2M20 12h2"/>';

export function Icon({ name, ...props }: { name: keyof typeof PATHS } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d={PATHS[name]} />
    </svg>
  );
}

export function PersonIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <g dangerouslySetInnerHTML={{ __html: PERSON_ICON }} />
    </svg>
  );
}

export function BotIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <g dangerouslySetInnerHTML={{ __html: BOT_ICON }} />
    </svg>
  );
}

export function BackArrow(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path d={PATHS.back} />
    </svg>
  );
}
