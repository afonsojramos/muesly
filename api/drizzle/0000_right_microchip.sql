CREATE TABLE `bar_usage` (
	`bar_id` text PRIMARY KEY NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_bar_usage_uses` ON `bar_usage` (`uses`);