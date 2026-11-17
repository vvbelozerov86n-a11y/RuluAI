CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`short_name` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`initials` text DEFAULT '' NOT NULL,
	`color` text DEFAULT '' NOT NULL,
	`type` text DEFAULT 'human' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_participants` (
	`task_id` text NOT NULL,
	`member_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_participants_task_idx` ON `task_participants` (`task_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`kind` text DEFAULT 'leaf' NOT NULL,
	`title` text NOT NULL,
	`owner_id` text DEFAULT 'me' NOT NULL,
	`status` text,
	`due_label` text DEFAULT 'Без срока' NOT NULL,
	`due_date` text,
	`description` text DEFAULT '' NOT NULL,
	`result` text DEFAULT '' NOT NULL,
	`size` text DEFAULT 'small' NOT NULL,
	`theme` text DEFAULT 'teal' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_parent_idx` ON `tasks` (`parent_id`);