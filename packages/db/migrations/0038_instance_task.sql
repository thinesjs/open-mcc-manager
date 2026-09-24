CREATE TABLE "instanceTask" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"instanceId" text NOT NULL,
	"name" text NOT NULL,
	"stepDelaySeconds" integer DEFAULT 3 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"timezone" text NOT NULL,
	"onFirstLogin" boolean DEFAULT false NOT NULL,
	"onLogin" boolean DEFAULT false NOT NULL,
	"onRespawn" boolean DEFAULT false NOT NULL,
	"intervalMinSeconds" integer,
	"intervalMaxSeconds" integer,
	"intervalNextRunAt" timestamp,
	"intervalObservedAt" timestamp,
	"lastRunAt" timestamp,
	"lastRunError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "instanceTask_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "instanceTask_org_instance_name_unique" UNIQUE("organizationId","instanceId","name"),
	CONSTRAINT "instanceTask_step_delay_within_bounds" CHECK ("instanceTask"."stepDelaySeconds" >= 0 AND "instanceTask"."stepDelaySeconds" <= 60),
	CONSTRAINT "instanceTask_interval_both_or_neither" CHECK (("instanceTask"."intervalMinSeconds" IS NULL) = ("instanceTask"."intervalMaxSeconds" IS NULL)),
	CONSTRAINT "instanceTask_interval_ordered" CHECK ("instanceTask"."intervalMinSeconds" IS NULL OR ("instanceTask"."intervalMinSeconds" >= 5 AND "instanceTask"."intervalMinSeconds" <= "instanceTask"."intervalMaxSeconds")),
	CONSTRAINT "instanceTask_interval_arm_needs_interval" CHECK ("instanceTask"."intervalNextRunAt" IS NULL OR "instanceTask"."intervalMinSeconds" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "instanceTask" ADD CONSTRAINT "instanceTask_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "instanceTask" ADD CONSTRAINT "instanceTask_instance_org_fk" FOREIGN KEY ("organizationId","instanceId") REFERENCES "public"."instance"("organizationId","id") ON DELETE cascade;--> statement-breakpoint
CREATE TABLE "instanceTaskStep" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"taskId" text NOT NULL,
	"position" integer NOT NULL,
	"command" text NOT NULL,
	CONSTRAINT "instanceTaskStep_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "instanceTaskStep_task_position_unique" UNIQUE("organizationId","taskId","position"),
	CONSTRAINT "instanceTaskStep_position_not_negative" CHECK ("instanceTaskStep"."position" >= 0),
	CONSTRAINT "instanceTaskStep_command_not_empty" CHECK (length("instanceTaskStep"."command") > 0),
	CONSTRAINT "instanceTaskStep_command_single_line" CHECK ("instanceTaskStep"."command" !~ '[\n\r]')
);--> statement-breakpoint
ALTER TABLE "instanceTaskStep" ADD CONSTRAINT "instanceTaskStep_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "instanceTaskStep" ADD CONSTRAINT "instanceTaskStep_task_org_fk" FOREIGN KEY ("organizationId","taskId") REFERENCES "public"."instanceTask"("organizationId","id") ON DELETE cascade;--> statement-breakpoint
CREATE TABLE "instanceTaskTime" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"taskId" text NOT NULL,
	"daysOfWeek" text NOT NULL,
	"minuteOfDay" integer NOT NULL,
	CONSTRAINT "instanceTaskTime_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "instanceTaskTime_task_time_unique" UNIQUE("organizationId","taskId","daysOfWeek","minuteOfDay"),
	CONSTRAINT "instanceTaskTime_minute_within_day" CHECK ("instanceTaskTime"."minuteOfDay" >= 0 AND "instanceTaskTime"."minuteOfDay" < 1440),
	CONSTRAINT "instanceTaskTime_days_not_empty" CHECK (length("instanceTaskTime"."daysOfWeek") > 0)
);--> statement-breakpoint
ALTER TABLE "instanceTaskTime" ADD CONSTRAINT "instanceTaskTime_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "instanceTaskTime" ADD CONSTRAINT "instanceTaskTime_task_org_fk" FOREIGN KEY ("organizationId","taskId") REFERENCES "public"."instanceTask"("organizationId","id") ON DELETE cascade;--> statement-breakpoint
CREATE TABLE "instanceTaskRun" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"taskId" text NOT NULL,
	"trigger" text NOT NULL,
	"claimKey" text NOT NULL,
	"outcome" text DEFAULT 'running' NOT NULL,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"finishedAt" timestamp,
	"stepsSent" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "instanceTaskRun_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "instanceTaskRun_claim_unique" UNIQUE("organizationId","taskId","claimKey"),
	CONSTRAINT "instanceTaskRun_trigger_known" CHECK ("trigger" IN ('firstLogin','login','respawn','time','interval')),
	CONSTRAINT "instanceTaskRun_outcome_known" CHECK ("outcome" IN ('running','sent','failed','abandoned')),
	CONSTRAINT "instanceTaskRun_steps_not_negative" CHECK ("instanceTaskRun"."stepsSent" >= 0)
);--> statement-breakpoint
ALTER TABLE "instanceTaskRun" ADD CONSTRAINT "instanceTaskRun_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "instanceTaskRun" ADD CONSTRAINT "instanceTaskRun_task_org_fk" FOREIGN KEY ("organizationId","taskId") REFERENCES "public"."instanceTask"("organizationId","id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "instanceTaskRun_recent" ON "instanceTaskRun" ("organizationId","taskId","startedAt" DESC);--> statement-breakpoint
CREATE TABLE "instanceSignal" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"instanceId" text NOT NULL,
	"kind" text NOT NULL,
	"identity" text NOT NULL,
	"process" text,
	"firstForProcess" boolean DEFAULT false NOT NULL,
	"occurredAt" timestamp NOT NULL,
	"observedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "instanceSignal_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "instanceSignal_identity_unique" UNIQUE("organizationId","instanceId","kind","identity"),
	CONSTRAINT "instanceSignal_kind_known" CHECK ("kind" IN ('login','respawn'))
);--> statement-breakpoint
ALTER TABLE "instanceSignal" ADD CONSTRAINT "instanceSignal_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "instanceSignal" ADD CONSTRAINT "instanceSignal_instance_org_fk" FOREIGN KEY ("organizationId","instanceId") REFERENCES "public"."instance"("organizationId","id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "instanceSignal_recent" ON "instanceSignal" ("organizationId","instanceId","kind","occurredAt" DESC);--> statement-breakpoint
CREATE TABLE "instanceSignalCursor" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"instanceId" text NOT NULL,
	"source" text NOT NULL,
	"cursor" text NOT NULL,
	"lastObservedAt" timestamp NOT NULL,
	CONSTRAINT "instanceSignalCursor_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "instanceSignalCursor_source_unique" UNIQUE("organizationId","instanceId","source"),
	CONSTRAINT "instanceSignalCursor_source_known" CHECK ("source" IN ('journal','liveEvents'))
);--> statement-breakpoint
ALTER TABLE "instanceSignalCursor" ADD CONSTRAINT "instanceSignalCursor_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "instanceSignalCursor" ADD CONSTRAINT "instanceSignalCursor_instance_org_fk" FOREIGN KEY ("organizationId","instanceId") REFERENCES "public"."instance"("organizationId","id") ON DELETE cascade;
