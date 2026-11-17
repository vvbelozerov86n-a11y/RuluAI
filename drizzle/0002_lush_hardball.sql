CREATE TABLE `ai_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_key` text NOT NULL,
	`active_key` text,
	`lease_token` text NOT NULL,
	`lease_expires_at` text NOT NULL,
	`kind` text NOT NULL,
	`task_id` text NOT NULL,
	`channel_member_id` text,
	`bot_member_id` text NOT NULL,
	`requester_user_id` text NOT NULL,
	`requester_member_id` text NOT NULL,
	`input_message_id` text,
	`task_version` integer NOT NULL,
	`config_version` integer NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`output` text,
	`error` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_run_request_idx` ON `ai_runs` (`request_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_run_active_idx` ON `ai_runs` (`active_key`);--> statement-breakpoint
CREATE INDEX `ai_run_channel_idx` ON `ai_runs` (`task_id`,`channel_member_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_run_requester_idx` ON `ai_runs` (`requester_user_id`,`status`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `bot_configs` (
	`member_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`system_prompt` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL
);
