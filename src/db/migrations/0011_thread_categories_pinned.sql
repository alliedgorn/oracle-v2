ALTER TABLE `forum_threads` ADD `category` text DEFAULT 'discussion';--> statement-breakpoint
ALTER TABLE `forum_threads` ADD `pinned` integer DEFAULT 0;