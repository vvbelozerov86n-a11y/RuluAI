/**
 * Чистая модель «Рули»: узлы дерева, агрегаты и правила валидации.
 * Файл не зависит от окружения Workers — используется и на сервере,
 * и в тестах (node --test).
 */

export type MemberType = "human" | "bot";
export type TaskStatus = "todo" | "doing" | "review" | "done";
export type TaskKind = "group" | "leaf";
export type BlockSize = "small" | "wide" | "tall" | "large";
export type BlockTheme = "teal" | "blue" | "cream" | "slate" | "graphite";

export const STATUS_NAMES: Record<TaskStatus, string> = {
  todo: "В очереди",
  doing: "В работе",
  review: "На проверке",
  done: "Готово",
};

export const BLOCK_SIZES: Record<BlockSize, { label: string; w: 1 | 2; h: 1 | 2 }> = {
  small: { label: "Квадрат", w: 1, h: 1 },
  wide: { label: "Широкий", w: 2, h: 1 },
  tall: { label: "Высокий", w: 1, h: 2 },
  large: { label: "Крупный", w: 2, h: 2 },
};

export const BLOCK_THEMES: Record<BlockTheme, string> = {
  teal: "Тёмная бирюза",
  blue: "Голубой",
  cream: "Светлый",
  slate: "Серо-синий",
  graphite: "Графит",
};

export const ROOT_ID = "root";
export type ViewMode = "view" | "build";

/** Ссылка на страницу задачи (корень живёт на «/»). */
export function taskHref(id: string, mode?: ViewMode): string {
  const base = id === ROOT_ID ? "/" : `/t/${id}`;
  return mode ? `${base}${base.includes("?") ? "&" : "?"}mode=${mode}` : base;
}
export const MAX_NODES = 500;
export const MAX_DEPTH = 20;
export const DEFAULT_TIME_ZONE = "Asia/Barnaul";

export type Member = {
  id: string;
  name: string;
  shortName: string;
  role: string;
  initials: string;
  color: string;
  type: MemberType;
};

export type TaskNode = {
  id: string;
  parentId: string | null;
  kind: TaskKind;
  title: string;
  ownerId: string;
  status: TaskStatus | null;
  dueLabel: string;
  dueDate: string | null;
  description: string;
  result: string;
  size: BlockSize;
  theme: BlockTheme;
  position: number;
  children: TaskNode[];
  participants: string[];
  version: number;
  deletedAt: string | null;
  splitSourceId: string | null;
  deletionBatchId?: string | null;
};

export type TreeStats = { total: number; done: number; review: number; late: number };

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "todo" || value === "doing" || value === "review" || value === "done";
}

export function isBlockSize(value: unknown): value is BlockSize {
  return typeof value === "string" && Object.hasOwn(BLOCK_SIZES, value);
}

export function isBlockTheme(value: unknown): value is BlockTheme {
  return typeof value === "string" && Object.hasOwn(BLOCK_THEMES, value);
}

export function isTaskKind(value: unknown): value is TaskKind {
  return value === "group" || value === "leaf";
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m = n % 100;
  return `${n} ${m >= 11 && m <= 14 ? many : n % 10 === 1 ? one : n % 10 >= 2 && n % 10 <= 4 ? few : many}`;
}

export function findPath(id: string, node: TaskNode, path: TaskNode[] = []): TaskNode[] | null {
  const next = [...path, node];
  if (node.id === id) return next;
  for (const child of node.children) {
    const found = findPath(id, child, next);
    if (found) return found;
  }
  return null;
}

export function visitTree(node: TaskNode, fn: (n: TaskNode) => void): void {
  fn(node);
  for (const child of node.children) visitTree(child, fn);
}

export function countNodes(node: TaskNode): number {
  let count = 0;
  visitTree(node, () => count++);
  return count;
}

/** Просрочено: срок уже прошёл, а задача не завершена. */
export function isOverdue(node: TaskNode, todayISO: string): boolean {
  if (node.deletedAt || !isISODate(node.dueDate) || !isISODate(todayISO) || node.dueDate >= todayISO) return false;
  if (node.kind === "group") return leaves(node).some((leaf) => leaf.status !== "done");
  return node.status !== "done";
}

export function leaves(node: TaskNode): TaskNode[] {
  if (node.deletedAt) return [];
  return node.kind === "group" ? node.children.flatMap(leaves) : [node];
}

export function stats(node: TaskNode, todayISO: string): TreeStats {
  const all = leaves(node);
  return {
    total: all.length,
    done: all.filter((x) => x.status === "done").length,
    review: all.filter((x) => x.status === "review").length,
    late: all.filter((x) => isOverdue(x, todayISO)).length,
  };
}

export function progress(s: TreeStats): number {
  return s.total ? Math.round((s.done / s.total) * 100) : 0;
}

/** Участники задачи и всех подзадач: ответственные + явные участники, без повторов. */
export function peopleOf(node: TaskNode, members: Map<string, Member>): { human: string[]; bot: string[] } {
  const ids = new Set<string>();
  visitTree(node, (n) => {
    if (n.ownerId) ids.add(n.ownerId);
    for (const id of n.participants) ids.add(id);
  });
  const result: { human: string[]; bot: string[] } = { human: [], bot: [] };
  for (const id of ids) {
    const member = members.get(id);
    if (!member) continue;
    if (member.type === "bot") result.bot.push(id);
    else result.human.push(id);
  }
  return result;
}

/** Calendar dates are independent of the execution host's local timezone. */
export function isISODate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= monthDays[month - 1];
}

export function addDaysISO(iso: string, days: number): string {
  if (!isISODate(iso) || !Number.isSafeInteger(days)) throw new RangeError("Некорректная дата или число дней");
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  if (Number.isNaN(date.getTime())) throw new RangeError("Дата выходит за поддерживаемый диапазон");
  const result = date.toISOString().slice(0, 10);
  if (!isISODate(result)) throw new RangeError("Дата выходит за диапазон 0001–9999");
  return result;
}

export function todayISO(now = new Date(), timeZone = DEFAULT_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (name: string) => parts.find((item) => item.type === name)!.value;
  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

/** Короткая подпись срока по ISO-дате: «Сегодня», «Вчера» или «24 нояб.» */
export function dueLabelFromISO(iso: string, now = new Date(), timeZone = DEFAULT_TIME_ZONE): string {
  if (!isISODate(iso)) return "Некорректная дата";
  const today = todayISO(now, timeZone);
  const yesterday = addDaysISO(today, -1);
  if (iso === today) return "Сегодня";
  if (iso === yesterday) return "Вчера";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC", day: "numeric", month: "short", ...(iso.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" as const } : {}),
  }).format(
    new Date(`${iso}T12:00:00Z`),
  );
}

/** ISO-дата из ввода формы (ГГГГ-ММ-ДД, ДД.ММ.ГГГГ или «24 ноября») или null. */
export function dueDateFromInput(value: string, now = new Date(), timeZone = DEFAULT_TIME_ZONE): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "без срока") return null;
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoMatch) {
    return isISODate(trimmed) ? trimmed : null;
  }
  const ruMatch = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(trimmed);
  if (ruMatch) {
    const [, d, m, y] = ruMatch;
    const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    return isISODate(iso) ? iso : null;
  }
  const shortMatch = /^(\d{1,2})\s+([а-яё]+)\.?(?:\s+(\d{4})(?:\s*г\.?)?)?$/i.exec(trimmed);
  if (shortMatch) {
    const months = [
      ["янв", "январь", "января"], ["фев", "февраль", "февраля"], ["мар", "март", "марта"],
      ["апр", "апрель", "апреля"], ["май", "мая"], ["июн", "июнь", "июня"],
      ["июл", "июль", "июля"], ["авг", "август", "августа"], ["сен", "сент", "сентябрь", "сентября"],
      ["окт", "октябрь", "октября"], ["ноя", "нояб", "ноябрь", "ноября"], ["дек", "декабрь", "декабря"],
    ];
    const monthIndex = months.findIndex((names) => names.includes(shortMatch[2].toLowerCase()));
    if (monthIndex >= 0) {
      const year = shortMatch[3] || todayISO(now, timeZone).slice(0, 4);
      const iso = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${shortMatch[1].padStart(2, "0")}`;
      return isISODate(iso) ? iso : null;
    }
  }
  return null;
}

export type DueDateValidation = { valid: true; date: string | null } | { valid: false; error: string };

/** Unlike the legacy nullable parser, distinguishes an empty deadline from invalid input. */
export function validateDueDateInput(value: string, now = new Date(), timeZone = DEFAULT_TIME_ZONE): DueDateValidation {
  if (!value.trim() || value.trim().toLowerCase() === "без срока") return { valid: true, date: null };
  const date = dueDateFromInput(value, now, timeZone);
  return date ? { valid: true, date } : { valid: false, error: "Введите существующую дату: ГГГГ-ММ-ДД, ДД.ММ.ГГГГ или 24 ноября 2026" };
}

/* ------------------------------------------------------------------ */
/* Демо-данные прототипа (designs/hierarchy.js + builder.js)           */
/* ------------------------------------------------------------------ */

export const DEMO_MEMBERS: Member[] = [
  { id: "anna", name: "Анна Смирнова", shortName: "Анна", role: "Маркетинг", initials: "АС", color: "rose", type: "human" },
  { id: "max", name: "Максим Волков", shortName: "Максим", role: "Продукт", initials: "МВ", color: "sand", type: "human" },
  { id: "maria", name: "Мария Орлова", shortName: "Мария", role: "Продажи", initials: "МО", color: "violet", type: "human" },
  { id: "ilya", name: "Илья Петров", shortName: "Илья", role: "Дизайн", initials: "ИП", color: "blue", type: "human" },
  { id: "analyst", name: "Grok · Аналитик", shortName: "Grok · Аналитик", role: "Анализ и исследования", initials: "✳", color: "bot", type: "bot" },
  { id: "writer", name: "Grok · Редактор", shortName: "Grok · Редактор", role: "Тексты и коммуникации", initials: "✳", color: "bot", type: "bot" },
  { id: "me", name: "Руководитель", shortName: "Вы", role: "Решения и согласование", initials: "ВЫ", color: "", type: "human" },
];

type SeedLeaf = {
  kind: "leaf";
  id: string;
  title: string;
  owner: string;
  status: TaskStatus;
  due: string; // ISO-дата
  description?: string;
  result?: string;
};

type SeedGroup = {
  kind: "group";
  id: string;
  title: string;
  owner: string;
  due: string;
  children: SeedNode[];
};

type SeedNode = SeedLeaf | SeedGroup;

/** Дата относительно «сегодня» — как в прототипе: «Сегодня», «Вчера» и т.д. */
const D = (offset: number, base = new Date()): string => {
  return addDaysISO(todayISO(base), offset);
};

export const DEMO_SEED_DAY = D(0);

const seed: SeedGroup[] = [
  {
    kind: "group", id: "launch", title: "Запустить продукт", owner: "anna", due: D(7),
    children: [
      {
        kind: "group", id: "research", title: "Исследовать рынок", owner: "max", due: D(2),
        children: [
          {
            kind: "leaf", id: "competitors", title: "Сравнить конкурентов", owner: "analyst", status: "review", due: D(0),
            description: "Сравнить способы управления командой людей и AI. Подготовить три вывода для руководителя.",
            result: "1. Единая очередь задач помогает видеть работу людей и ботов в одном месте.\n\n2. Результат AI стоит передавать человеку на проверку до завершения задачи.\n\n3. На верхнем уровне нужны общий прогресс и исключения: просрочки, блокировки, вопросы.\n\nСледующий шаг: выбрать три сервиса и собрать подтверждённые данные по каждому.",
          },
          {
            kind: "leaf", id: "interviews", title: "Провести интервью", owner: "anna", status: "done", due: D(-1),
            description: "Собрать обратную связь от трёх руководителей.",
            result: "Интервью проведены. Основной запрос: видеть приоритеты, ответственных и результат без лишних экранов.",
          },
          {
            kind: "leaf", id: "conclusions", title: "Утвердить выводы", owner: "me", status: "todo", due: D(2),
            description: "Проверить обзор конкурентов и результаты интервью, выбрать направление.",
          },
        ],
      },
      {
        kind: "group", id: "materials", title: "Подготовить материалы", owner: "ilya", due: D(4),
        children: [
          { kind: "leaf", id: "presentation", title: "Собрать презентацию", owner: "ilya", status: "doing", due: D(3) },
          {
            kind: "leaf", id: "letter", title: "Написать письмо о продукте", owner: "writer", status: "todo", due: D(4),
            description: "Написать короткое письмо руководителям: единые задачи для людей и Grok-ботов, простая иерархия, проверка результатов.",
          },
          {
            kind: "leaf", id: "brief", title: "Утвердить бриф", owner: "anna", status: "done", due: D(-1),
            description: "Утвердить структуру материалов.",
            result: "Бриф согласован. Главная идея: руководитель видит только необходимый уровень детализации.",
          },
        ],
      },
      {
        kind: "group", id: "release", title: "Организовать запуск", owner: "anna", due: D(7),
        children: [
          {
            kind: "leaf", id: "checklist", title: "Подготовить чек-лист запуска", owner: "analyst", status: "done", due: D(0),
            description: "Составить список проверок перед запуском.",
            result: "Проверить ключевые сценарии, права доступа, обработку ошибок и понятность интерфейса.",
          },
          { kind: "leaf", id: "announce", title: "Согласовать дату запуска", owner: "me", status: "todo", due: D(7) },
        ],
      },
    ],
  },
  {
    kind: "group", id: "sales", title: "Увеличить продажи", owner: "maria", due: D(11),
    children: [
      {
        kind: "group", id: "offers", title: "Обновить предложения", owner: "maria", due: D(4),
        children: [
          { kind: "leaf", id: "segments", title: "Определить сегменты клиентов", owner: "analyst", status: "done", due: D(-1) },
          { kind: "leaf", id: "proposal", title: "Подготовить предложение", owner: "writer", status: "doing", due: D(3) },
          { kind: "leaf", id: "approve-offer", title: "Согласовать условия", owner: "maria", status: "todo", due: D(4) },
        ],
      },
      {
        kind: "group", id: "pipeline", title: "Разобрать входящие заявки", owner: "maria", due: D(11),
        children: [
          { kind: "leaf", id: "leads", title: "Приоритизировать заявки", owner: "maria", status: "doing", due: D(3) },
          { kind: "leaf", id: "followup", title: "Подготовить ответы клиентам", owner: "writer", status: "todo", due: D(5) },
        ],
      },
    ],
  },
  {
    kind: "group", id: "service", title: "Улучшить сервис", owner: "max", due: D(5),
    children: [
      {
        kind: "group", id: "feedback", title: "Собрать обратную связь", owner: "max", due: D(1),
        children: [
          { kind: "leaf", id: "customer-feedback", title: "Разобрать отзывы клиентов", owner: "max", status: "doing", due: D(-1) },
          { kind: "leaf", id: "feedback-summary", title: "Собрать сводку замечаний", owner: "analyst", status: "todo", due: D(1) },
        ],
      },
      {
        kind: "group", id: "support", title: "Обновить базу знаний", owner: "anna", due: D(5),
        children: [
          { kind: "leaf", id: "faq", title: "Написать ответы на частые вопросы", owner: "writer", status: "done", due: D(-1) },
          { kind: "leaf", id: "help-review", title: "Проверить инструкции", owner: "anna", status: "todo", due: D(5) },
        ],
      },
    ],
  },
  {
    kind: "group", id: "content", title: "Развивать контент", owner: "anna", due: D(13),
    children: [
      {
        kind: "group", id: "content-plan", title: "Подготовить план публикаций", owner: "anna", due: D(4),
        children: [
          { kind: "leaf", id: "topics", title: "Собрать темы для публикаций", owner: "analyst", status: "done", due: D(-1) },
          { kind: "leaf", id: "calendar", title: "Согласовать календарь", owner: "anna", status: "done", due: D(0) },
        ],
      },
      {
        kind: "group", id: "articles", title: "Подготовить материалы", owner: "writer", due: D(13),
        children: [
          { kind: "leaf", id: "first-article", title: "Написать статью о делегировании", owner: "writer", status: "doing", due: D(7) },
          { kind: "leaf", id: "article-visuals", title: "Подготовить иллюстрации", owner: "ilya", status: "todo", due: D(9) },
          { kind: "leaf", id: "article-review", title: "Проверить материалы", owner: "anna", status: "todo", due: D(13) },
        ],
      },
    ],
  },
  {
    kind: "group", id: "processes", title: "Настроить процессы", owner: "me", due: D(8),
    children: [
      {
        kind: "group", id: "delegation", title: "Распределить ответственность", owner: "me", due: D(3),
        children: [
          { kind: "leaf", id: "roles", title: "Описать роли команды", owner: "me", status: "done", due: D(0) },
          { kind: "leaf", id: "bot-roles", title: "Сформулировать инструкции ботам", owner: "me", status: "done", due: D(0) },
        ],
      },
      {
        kind: "group", id: "reviews", title: "Ввести проверку результатов", owner: "max", due: D(8),
        children: [
          {
            kind: "leaf", id: "criteria", title: "Подготовить критерии качества", owner: "max", status: "review", due: D(0),
            description: "Определить, как руководитель принимает результат задачи.",
            result: "Результат соответствует описанию, содержит проверяемые данные и готов к использованию. Если данных не хватает, исполнитель явно перечисляет вопросы.",
          },
          { kind: "leaf", id: "approve-process", title: "Согласовать процесс проверки", owner: "me", status: "todo", due: D(8) },
        ],
      },
    ],
  },
  {
    kind: "group", id: "reporting", title: "Подвести итоги месяца", owner: "me", due: D(13),
    children: [
      {
        kind: "group", id: "data", title: "Собрать результаты", owner: "maria", due: D(11),
        children: [
          { kind: "leaf", id: "sales-data", title: "Подготовить данные по продажам", owner: "maria", status: "todo", due: D(10) },
          { kind: "leaf", id: "team-data", title: "Собрать результаты команды", owner: "max", status: "todo", due: D(11) },
        ],
      },
      {
        kind: "group", id: "month-report", title: "Подготовить отчёт", owner: "analyst", due: D(13),
        children: [
          { kind: "leaf", id: "report-draft", title: "Собрать черновик отчёта", owner: "analyst", status: "todo", due: D(12) },
          { kind: "leaf", id: "report-approve", title: "Утвердить итоги", owner: "me", status: "todo", due: D(13) },
        ],
      },
    ],
  },
];

/** Размеры и цвета корневых блоков — как в прототипе (builder.js). */
const ROOT_SIZES: BlockSize[] = ["wide", "tall", "small", "small", "small", "small"];
const ROOT_THEMES: BlockTheme[] = ["teal", "cream", "teal", "blue", "teal", "slate"];

const DEFAULT_LEAF_DESCRIPTION = "Подготовить результат и передать руководителю на проверку.";

export type SeedTask = {
  id: string;
  parentId: string | null;
  kind: TaskKind;
  title: string;
  ownerId: string;
  status: TaskStatus | null;
  dueDate: string | null;
  description: string;
  result: string;
  size: BlockSize;
  theme: BlockTheme;
  position: number;
  participants: string[];
};

/** Плоский список задач из демо-дерева — готов к вставке в D1. */
export function demoSeedTasks(): SeedTask[] {
  const rows: SeedTask[] = [];
  let rootPosition = 0;
  seed.forEach((group, index) => {
    const collect = (node: SeedGroup | SeedLeaf, parentId: string, position: number, size?: BlockSize, theme?: BlockTheme) => {
      rows.push({
        id: node.id,
        parentId,
        kind: node.kind,
        title: node.title,
        ownerId: node.owner,
        status: node.kind === "leaf" ? node.status : null,
        dueDate: node.due,
        description: node.kind === "leaf" ? node.description || (node.result ? "" : DEFAULT_LEAF_DESCRIPTION) : "",
        result: node.kind === "leaf" ? node.result || "" : "",
        size: size || "small",
        theme: theme || "teal",
        position,
        participants: [],
      });
      if (node.kind === "group") {
        node.children.forEach((child, childIndex) => collect(child, node.id, childIndex));
      }
    };
    collect(group, ROOT_ID, rootPosition++, ROOT_SIZES[index], ROOT_THEMES[index]);
  });
  rows.unshift({
    id: ROOT_ID,
    parentId: null,
    kind: "group",
    title: "Все задачи",
    ownerId: "me",
    status: null,
    dueDate: null,
    description: "",
    result: "",
    size: "small",
    theme: "teal",
    position: 0,
    participants: [],
  });
  return rows;
}
