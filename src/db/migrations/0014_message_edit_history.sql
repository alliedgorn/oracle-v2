CREATE TABLE IF NOT EXISTS `forum_message_edits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`original_content` text NOT NULL,
	`edited_by` text NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
ALTER TABLE `forum_messages` ADD `edited_at` integer;