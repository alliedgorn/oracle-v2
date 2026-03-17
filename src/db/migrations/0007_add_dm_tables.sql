CREATE TABLE `dm_conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`participant1` text NOT NULL,
	`participant2` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_dm_conv_p1` ON `dm_conversations` (`participant1`);--> statement-breakpoint
CREATE INDEX `idx_dm_conv_p2` ON `dm_conversations` (`participant2`);--> statement-breakpoint
CREATE INDEX `idx_dm_conv_updated` ON `dm_conversations` (`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_dm_conv_pair` ON `dm_conversations` (`participant1`, `participant2`);--> statement-breakpoint
CREATE TABLE `dm_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL REFERENCES `dm_conversations`(`id`),
	`sender` text NOT NULL,
	`content` text NOT NULL,
	`read_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_dm_msg_conv` ON `dm_messages` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_dm_msg_sender` ON `dm_messages` (`sender`);--> statement-breakpoint
CREATE INDEX `idx_dm_msg_created` ON `dm_messages` (`created_at`);
