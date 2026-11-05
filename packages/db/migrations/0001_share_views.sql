CREATE TABLE `share_views` (
	`share_id` text NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`requests` integer NOT NULL,
	PRIMARY KEY(`share_id`, `user_id`),
	FOREIGN KEY (`share_id`) REFERENCES `shares`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `share_views_org_idx` ON `share_views` (`org_id`);