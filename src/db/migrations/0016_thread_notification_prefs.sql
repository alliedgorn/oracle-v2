CREATE TABLE IF NOT EXISTS `forum_notification_prefs` (
	`beast_name` text NOT NULL,
	`thread_id` integer NOT NULL,
	`muted` integer NOT NULL DEFAULT 0,
	`updated_at` integer NOT NULL,
	PRIMARY KEY (`beast_name`, `thread_id`)
);