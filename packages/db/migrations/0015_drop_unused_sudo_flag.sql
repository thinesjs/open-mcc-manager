ALTER TABLE "host" DROP CONSTRAINT IF EXISTS "host_sudo_needs_system_mode";--> statement-breakpoint
ALTER TABLE "host" DROP COLUMN IF EXISTS "useSudo";
