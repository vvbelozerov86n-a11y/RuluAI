CREATE TABLE `company_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`invite_token` text NOT NULL,
	CONSTRAINT "company_profile_workspace" CHECK("company_profile"."id" = 'workspace')
);
--> statement-breakpoint
CREATE TABLE `removed_team_accounts` (
	`member_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`user_id` text
);
--> statement-breakpoint
CREATE INDEX `removed_team_account_email_idx` ON `removed_team_accounts` (`email`);--> statement-breakpoint
CREATE INDEX `removed_team_account_user_idx` ON `removed_team_accounts` (`user_id`);