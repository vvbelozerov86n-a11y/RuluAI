ALTER TABLE `tasks` ADD `priority` text;
ALTER TABLE `bot_configs` ADD `slug` text;
CREATE UNIQUE INDEX `bot_configs_slug_idx` ON `bot_configs` (`slug`);
CREATE TABLE `bot_webhook_outbox` (
  `id` text PRIMARY KEY NOT NULL,
  `event` text NOT NULL,
  `task_id` text NOT NULL,
  `bot_member_id` text NOT NULL,
  `bot_slug` text NOT NULL,
  `payload` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `attempts` integer NOT NULL DEFAULT 0,
  `last_error` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);
CREATE INDEX `bot_webhook_outbox_task_idx` ON `bot_webhook_outbox` (`task_id`,`created_at`);
CREATE INDEX `bot_webhook_outbox_status_idx` ON `bot_webhook_outbox` (`status`,`created_at`);
CREATE TABLE `bot_api_idempotency` (
  `bot_member_id` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `method` text NOT NULL,
  `path` text NOT NULL,
  `status` integer NOT NULL,
  `body` text NOT NULL,
  `created_at` text NOT NULL,
  PRIMARY KEY (`bot_member_id`,`idempotency_key`)
);
