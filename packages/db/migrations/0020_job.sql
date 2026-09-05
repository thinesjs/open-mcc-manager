CREATE TABLE "job" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runAfter" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"maxAttempts" integer DEFAULT 8 NOT NULL,
	"claimId" text,
	"claimedAt" timestamp with time zone,
	"lastError" text,
	"completedAt" timestamp with time zone,
	"failedAt" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_attempts_within_max" CHECK ("job"."attempts" >= 0 AND "job"."attempts" <= "job"."maxAttempts");--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_claim_is_paired" CHECK (("job"."claimId" IS NULL) = ("job"."claimedAt" IS NULL));--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_ends_once" CHECK ("job"."completedAt" IS NULL OR "job"."failedAt" IS NULL);--> statement-breakpoint
CREATE INDEX "job_ready" ON "job" ("kind", "runAfter") WHERE "completedAt" IS NULL AND "failedAt" IS NULL;
