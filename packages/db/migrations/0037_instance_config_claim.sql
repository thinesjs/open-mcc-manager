ALTER TABLE "instance" ADD COLUMN "configClaimId" text;--> statement-breakpoint
ALTER TABLE "instance" ADD COLUMN "configClaimedAt" timestamp;--> statement-breakpoint
ALTER TABLE "instance" ADD CONSTRAINT "instance_config_requires_lease" CHECK ("instance"."configClaimId" IS NULL OR "instance"."configClaimedAt" IS NOT NULL);
