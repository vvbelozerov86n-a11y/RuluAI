CREATE TABLE `schedule_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_task_id` text NOT NULL,
	`task_id` text NOT NULL,
	`member_id` text NOT NULL,
	`title` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`hours` real NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `schedule_plan_idx` ON `schedule_entries` (`plan_task_id`);--> statement-breakpoint
CREATE INDEX `schedule_member_dates_idx` ON `schedule_entries` (`member_id`,`start_date`,`end_date`);--> statement-breakpoint
CREATE TABLE `schedule_plans` (
	`task_id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`last_mutation_id` text,
	`hours_per_day` real DEFAULT 8 NOT NULL,
	`weekdays_only` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`channel_member_id` text,
	`author_id` text NOT NULL,
	`author_user_id` text NOT NULL,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`client_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_messages_channel_idx` ON `task_messages` (`task_id`,`channel_member_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_retry_idx` ON `task_messages` (`author_user_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `team_accounts` (
	`email` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`member_id` text NOT NULL,
	`role` text DEFAULT 'executor' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_account_user_idx` ON `team_accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_account_member_idx` ON `team_accounts` (`member_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `deleted_at` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `deletion_batch_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `last_mutation_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `split_source_id` text;