ALTER TABLE "instance" ADD COLUMN "liveControlPort" integer;--> statement-breakpoint
UPDATE "instance" AS i
SET "liveControlPort" = 33332 + ranked.position
FROM (
	SELECT
		id,
		row_number() OVER (PARTITION BY "organizationId", "hostId" ORDER BY "createdAt", id) AS position
	FROM "instance"
) AS ranked
WHERE ranked.id = i.id;--> statement-breakpoint
ALTER TABLE "instance" ALTER COLUMN "liveControlPort" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "instance" ADD CONSTRAINT "instance_live_control_port_range" CHECK ("instance"."liveControlPort" BETWEEN 1024 AND 65535);--> statement-breakpoint
ALTER TABLE "instance" ADD CONSTRAINT "instance_live_control_port_unique" UNIQUE("organizationId","hostId","liveControlPort");
