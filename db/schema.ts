import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Рули — иерархические задачи команды людей и AI-ботов.
 *
 * Дерево задач хранится в одной таблице с self-reference по parent_id
 * (null — корень). Порядок среди соседей задаёт `position`.
 */

export const members = sqliteTable("members", {
  id: text("id").primaryKey(), // 'anna', 'max', 'analyst', 'me', ...
  name: text("name").notNull(),
  shortName: text("short_name").notNull(),
  role: text("role").notNull().default(""),
  initials: text("initials").notNull().default(""),
  color: text("color").notNull().default(""), // rose | sand | blue | violet | bot | ''
  type: text("type").notNull().default("human"), // human | bot
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    parentId: text("parent_id"), // null — корневой узел
    kind: text("kind").notNull().default("leaf"), // group | leaf
    title: text("title").notNull(),
    ownerId: text("owner_id").notNull().default("me"),
    status: text("status"), // todo | doing | review | done — только для leaf
    dueLabel: text("due_label").notNull().default("Без срока"),
    dueDate: text("due_date"), // ISO yyyy-mm-dd, для сортировки и просрочек
    description: text("description").notNull().default(""),
    result: text("result").notNull().default(""),
    size: text("size").notNull().default("small"), // small | wide | tall | large
    theme: text("theme").notNull().default("teal"), // teal | blue | cream | slate | graphite
    position: integer("position").notNull().default(0),
    version: integer("version").notNull().default(1),
    deletedAt: text("deleted_at"),
    deletionBatchId: text("deletion_batch_id"),
    lastMutationId: text("last_mutation_id"),
    splitSourceId: text("split_source_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index("tasks_parent_idx").on(t.parentId)],
);

/** Явные дополнительные участники блока (ответственный учитывается всегда). */
export const taskParticipants = sqliteTable(
  "task_participants",
  {
    taskId: text("task_id").notNull(),
    memberId: text("member_id").notNull(),
  },
  (t) => [index("task_participants_task_idx").on(t.taskId)],
);

export type MemberRow = typeof members.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskParticipantRow = typeof taskParticipants.$inferSelect;

/** One explicitly admitted team per Site. Email is bound to verified identity on sign-in. */
export const teamAccounts = sqliteTable("team_accounts", {
  email: text("email").primaryKey(),
  userId: text("user_id"),
  memberId: text("member_id").notNull(),
  role: text("role").notNull().default("executor"),
}, t => [uniqueIndex("team_account_user_idx").on(t.userId), uniqueIndex("team_account_member_idx").on(t.memberId)]);

export const taskMessages = sqliteTable("task_messages", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  channelMemberId: text("channel_member_id"),
  authorId: text("author_id").notNull(),
  authorUserId: text("author_user_id").notNull(),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  clientId: text("client_id").notNull(),
  createdAt: text("created_at").notNull(),
}, t => [index("task_messages_channel_idx").on(t.taskId, t.channelMemberId, t.createdAt), uniqueIndex("message_retry_idx").on(t.authorUserId, t.clientId)]);

export const schedulePlans = sqliteTable("schedule_plans", {
  taskId: text("task_id").primaryKey(),
  version: integer("version").notNull().default(0),
  lastMutationId: text("last_mutation_id"),
  hoursPerDay: real("hours_per_day").notNull().default(8),
  weekdaysOnly: integer("weekdays_only", {mode:"boolean"}).notNull().default(true),
});

export const scheduleEntries = sqliteTable("schedule_entries", {
  id: text("id").primaryKey(),
  planTaskId: text("plan_task_id").notNull(),
  taskId: text("task_id").notNull(),
  memberId: text("member_id").notNull(),
  title: text("title").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  hours: real("hours").notNull(),
  version: integer("version").notNull().default(1),
}, t => [index("schedule_plan_idx").on(t.planTaskId), index("schedule_member_dates_idx").on(t.memberId,t.startDate,t.endDate)]);

/** Provider secrets live only in the worker environment. */
export const botConfigs = sqliteTable("bot_configs", {
  memberId: text("member_id").primaryKey(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  systemPrompt: text("system_prompt").notNull().default(""),
  enabled: integer("enabled", {mode:"boolean"}).notNull().default(false),
  version: integer("version").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
  lastMutationId: text("last_mutation_id"),
});

/** A logical request is deduplicated across retries. Leases fence old workers. */
export const aiRuns = sqliteTable("ai_runs", {
  id: text("id").primaryKey(),
  requestKey: text("request_key").notNull(),
  activeKey: text("active_key"),
  leaseToken: text("lease_token").notNull(),
  leaseExpiresAt: text("lease_expires_at").notNull(),
  kind: text("kind").notNull(),
  taskId: text("task_id").notNull(),
  channelMemberId: text("channel_member_id"),
  botMemberId: text("bot_member_id").notNull(),
  requesterUserId: text("requester_user_id").notNull(),
  requesterMemberId: text("requester_member_id").notNull(),
  inputMessageId: text("input_message_id"),
  taskVersion: integer("task_version").notNull(),
  configVersion: integer("config_version").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull().default("pending"),
  output: text("output"),
  error: text("error"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  createdAt: text("created_at").notNull(),
  finishedAt: text("finished_at"),
}, t => [
  uniqueIndex("ai_run_request_idx").on(t.requestKey),
  uniqueIndex("ai_run_active_idx").on(t.activeKey),
  index("ai_run_channel_idx").on(t.taskId,t.channelMemberId,t.createdAt),
  index("ai_run_requester_idx").on(t.requesterUserId,t.status,t.leaseExpiresAt),
]);
