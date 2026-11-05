CREATE TABLE `device_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`last_polled_at` integer,
	`polling_interval` integer,
	`client_id` text,
	`scope` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deviceCodes_deviceCode_uidx` ON `device_codes` (`device_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `deviceCodes_userCode_uidx` ON `device_codes` (`user_code`);