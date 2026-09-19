ALTER TABLE "auditEvent" ADD COLUMN "actorLabel" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "host" ADD COLUMN "hostKeyTrustedByLabel" text DEFAULT 'unknown' NOT NULL;