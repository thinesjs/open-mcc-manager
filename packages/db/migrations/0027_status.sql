CREATE TABLE "statusEvent" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"subjectType" text NOT NULL,
	"subjectId" text NOT NULL,
	"subjectLabel" text NOT NULL,
	"hostId" text,
	"instanceId" text,
	"kind" text NOT NULL,
	"occurredAt" timestamp NOT NULL,
	"observedAt" timestamp NOT NULL,
	"lastCorroboratedAt" timestamp NOT NULL,
	"incidentId" text,
	"primarySource" text NOT NULL,
	"sources" text[] DEFAULT '{}' NOT NULL,
	"sourceKey" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "statusEvent_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "statusEvent_subject_type_known" CHECK ("subjectType" IN ('organization','host','instance'))
);--> statement-breakpoint
CREATE TABLE "statusCondition" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"hostId" text,
	"instanceId" text,
	"dimension" text NOT NULL,
	"state" text NOT NULL,
	"startedAt" timestamp NOT NULL,
	"lastObservedAt" timestamp NOT NULL,
	"failureStartedAt" timestamp,
	"activeIncidentId" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "statusCondition_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "statusCondition_one_subject" CHECK (("hostId" IS NULL) <> ("instanceId" IS NULL))
);--> statement-breakpoint
CREATE TABLE "statusInterval" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"hostId" text,
	"instanceId" text,
	"dimension" text NOT NULL,
	"state" text NOT NULL,
	"startedAt" timestamp NOT NULL,
	"endedAt" timestamp,
	"startEventId" text,
	"endEventId" text,
	CONSTRAINT "statusInterval_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "statusInterval_one_subject" CHECK (("hostId" IS NULL) <> ("instanceId" IS NULL)),
	CONSTRAINT "statusInterval_ordered" CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt")
);--> statement-breakpoint
CREATE TABLE "statusDailyRollup" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"hostId" text,
	"instanceId" text,
	"day" date NOT NULL,
	"dimension" text NOT NULL,
	"knownGoodSeconds" integer DEFAULT 0 NOT NULL,
	"knownBadSeconds" integer DEFAULT 0 NOT NULL,
	"degradedSeconds" integer DEFAULT 0 NOT NULL,
	"unknownSeconds" integer DEFAULT 0 NOT NULL,
	"excludedSeconds" integer DEFAULT 0 NOT NULL,
	"incidentCount" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "statusDailyRollup_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "statusDailyRollup_one_subject" CHECK (("hostId" IS NULL) <> ("instanceId" IS NULL))
);--> statement-breakpoint
CREATE TABLE "statusSourceCursor" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"instanceId" text NOT NULL,
	"source" text NOT NULL,
	"generation" text NOT NULL,
	"cursor" text NOT NULL,
	"lastObservedAt" timestamp NOT NULL,
	CONSTRAINT "statusSourceCursor_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "statusSourceCursor_unique_source" UNIQUE("organizationId","instanceId","source")
);--> statement-breakpoint
ALTER TABLE "statusEvent" ADD CONSTRAINT "statusEvent_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statusEvent" ADD CONSTRAINT "statusEvent_host_org_fk" FOREIGN KEY ("organizationId","hostId") REFERENCES "public"."host"("organizationId","id") ON DELETE SET NULL ("hostId") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statusEvent" ADD CONSTRAINT "statusEvent_instance_org_fk" FOREIGN KEY ("organizationId","instanceId") REFERENCES "public"."instance"("organizationId","id") ON DELETE SET NULL ("instanceId") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statusCondition" ADD CONSTRAINT "statusCondition_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statusCondition" ADD CONSTRAINT "statusCondition_host_org_fk" FOREIGN KEY ("organizationId","hostId") REFERENCES "public"."host"("organizationId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statusCondition" ADD CONSTRAINT "statusCondition_instance_org_fk" FOREIGN KEY ("organizationId","instanceId") REFERENCES "public"."instance"("organizationId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statusInterval" ADD CONSTRAINT "statusInterval_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statusInterval" ADD CONSTRAINT "statusInterval_host_org_fk" FOREIGN KEY ("organizationId","hostId") REFERENCES "public"."host"("organizationId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statusInterval" ADD CONSTRAINT "statusInterval_instance_org_fk" FOREIGN KEY ("organizationId","instanceId") REFERENCES "public"."instance"("organizationId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statusDailyRollup" ADD CONSTRAINT "statusDailyRollup_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statusDailyRollup" ADD CONSTRAINT "statusDailyRollup_host_org_fk" FOREIGN KEY ("organizationId","hostId") REFERENCES "public"."host"("organizationId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statusDailyRollup" ADD CONSTRAINT "statusDailyRollup_instance_org_fk" FOREIGN KEY ("organizationId","instanceId") REFERENCES "public"."instance"("organizationId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statusSourceCursor" ADD CONSTRAINT "statusSourceCursor_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statusSourceCursor" ADD CONSTRAINT "statusSourceCursor_instance_org_fk" FOREIGN KEY ("organizationId","instanceId") REFERENCES "public"."instance"("organizationId","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "statusEvent_source_key_unique" ON "statusEvent" ("organizationId","primarySource","sourceKey") WHERE "sourceKey" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "statusEvent_recent" ON "statusEvent" ("organizationId","occurredAt" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX "statusEvent_by_host" ON "statusEvent" ("organizationId","hostId","occurredAt" DESC);--> statement-breakpoint
CREATE INDEX "statusEvent_by_instance" ON "statusEvent" ("organizationId","instanceId","occurredAt" DESC);--> statement-breakpoint
CREATE INDEX "statusEvent_by_incident" ON "statusEvent" ("organizationId","incidentId");--> statement-breakpoint
CREATE UNIQUE INDEX "statusCondition_host_dimension" ON "statusCondition" ("organizationId","hostId","dimension") WHERE "hostId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "statusCondition_instance_dimension" ON "statusCondition" ("organizationId","instanceId","dimension") WHERE "instanceId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "statusInterval_host_open" ON "statusInterval" ("organizationId","hostId","dimension") WHERE "endedAt" IS NULL AND "hostId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "statusInterval_instance_open" ON "statusInterval" ("organizationId","instanceId","dimension") WHERE "endedAt" IS NULL AND "instanceId" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "statusInterval_host_window" ON "statusInterval" ("organizationId","hostId","dimension","startedAt" DESC);--> statement-breakpoint
CREATE INDEX "statusInterval_instance_window" ON "statusInterval" ("organizationId","instanceId","dimension","startedAt" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "statusDailyRollup_host_day" ON "statusDailyRollup" ("organizationId","hostId","dimension","day") WHERE "hostId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "statusDailyRollup_instance_day" ON "statusDailyRollup" ("organizationId","instanceId","dimension","day") WHERE "instanceId" IS NOT NULL;
