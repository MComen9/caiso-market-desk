CREATE TABLE `research_record_parts` (
	`record_id` text NOT NULL,
	`part` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`record_id`, `part`),
	FOREIGN KEY (`record_id`) REFERENCES `research_records`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `research_records` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`digest` text NOT NULL,
	`summary_json` text NOT NULL,
	`part_count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_records_kind_created` ON `research_records` (`kind`,`created_at`);