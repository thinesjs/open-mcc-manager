ALTER TABLE "host" ADD COLUMN "teardownError" text;--> statement-breakpoint
ALTER TABLE "host" ADD COLUMN "teardownRequestedAt" timestamp with time zone;
