CREATE TABLE `workspace_accounts` (
	`email` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_accounts_user_id_idx` ON `workspace_accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`invite_token` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_invite_token_idx` ON `workspaces` (`invite_token`);
--> statement-breakpoint
INSERT INTO workspaces(id,name,invite_token) SELECT 'legacy',p.name,p.invite_token FROM (SELECT 1) LEFT JOIN company_profile p ON p.id='workspace';
--> statement-breakpoint
INSERT INTO workspace_accounts(email,user_id,workspace_id) SELECT lower(trim(email)),user_id,'legacy' FROM team_accounts;
--> statement-breakpoint
CREATE TRIGGER directory_account_insert AFTER INSERT ON team_accounts BEGIN
      SELECT RAISE(ABORT,'account already belongs to another workspace')
    WHERE EXISTS (SELECT 1 FROM workspace_accounts WHERE workspace_id<>'legacy'
      AND (email=lower(trim(NEW.email)) OR user_id=NEW.user_id));
      INSERT INTO workspace_accounts(email,user_id,workspace_id) VALUES (lower(trim(NEW.email)),NEW.user_id,'legacy'); END;
--> statement-breakpoint
CREATE TRIGGER directory_account_update AFTER UPDATE OF email,user_id ON team_accounts BEGIN
      SELECT RAISE(ABORT,'account already belongs to another workspace')
    WHERE EXISTS (SELECT 1 FROM workspace_accounts WHERE workspace_id<>'legacy'
      AND (email=lower(trim(NEW.email)) OR user_id=NEW.user_id));
      UPDATE workspace_accounts SET email=lower(trim(NEW.email)),user_id=NEW.user_id
        WHERE workspace_id='legacy' AND email=lower(trim(OLD.email)); END;
--> statement-breakpoint
CREATE TRIGGER directory_account_delete AFTER DELETE ON team_accounts BEGIN
      DELETE FROM workspace_accounts WHERE workspace_id='legacy' AND email=lower(trim(OLD.email)); END;
--> statement-breakpoint
CREATE TRIGGER directory_profile_insert AFTER INSERT ON company_profile BEGIN SELECT RAISE(ABORT,'invitation already exists') WHERE EXISTS
    (SELECT 1 FROM workspaces WHERE id<>'legacy' AND invite_token=NEW.invite_token);
    UPDATE workspaces SET name=NEW.name,invite_token=NEW.invite_token WHERE id='legacy'; END;
--> statement-breakpoint
CREATE TRIGGER directory_profile_update AFTER UPDATE OF name,invite_token ON company_profile BEGIN SELECT RAISE(ABORT,'invitation already exists') WHERE EXISTS
    (SELECT 1 FROM workspaces WHERE id<>'legacy' AND invite_token=NEW.invite_token);
    UPDATE workspaces SET name=NEW.name,invite_token=NEW.invite_token WHERE id='legacy'; END;
--> statement-breakpoint
CREATE TRIGGER directory_profile_delete AFTER DELETE ON company_profile BEGIN
      UPDATE workspaces SET name=NULL,invite_token=NULL WHERE id='legacy'; END;
