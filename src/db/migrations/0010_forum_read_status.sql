CREATE TABLE IF NOT EXISTS `forum_read_status` (
	`beast_name` text NOT NULL,
	`thread_id` integer NOT NULL,
	`last_read_message_id` integer NOT NULL DEFAULT 0,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`beast_name`, `thread_id`)
);