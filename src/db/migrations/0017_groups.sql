CREATE TABLE IF NOT EXISTS `forum_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL UNIQUE,
	`description` text,
	`created_by` text,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `forum_group_members` (
	`group_id` integer NOT NULL,
	`beast_name` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY (`group_id`, `beast_name`)
);