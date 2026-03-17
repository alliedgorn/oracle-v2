CREATE TABLE IF NOT EXISTS `forum_reactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`beast_name` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	UNIQUE(`message_id`, `beast_name`, `emoji`)
);