ALTER TABLE "host" ADD COLUMN "provisioningStep" text;--> statement-breakpoint
ALTER TABLE "host" ADD COLUMN "provisioningStepIndex" integer;--> statement-breakpoint
ALTER TABLE "host" ADD COLUMN "provisioningStepTotal" integer;--> statement-breakpoint
ALTER TABLE "host" ADD CONSTRAINT "host_progress_within_total" CHECK ("host"."provisioningStepIndex" IS NULL OR "host"."provisioningStepTotal" IS NULL OR ("host"."provisioningStepIndex" >= 0 AND "host"."provisioningStepIndex" <= "host"."provisioningStepTotal"));
