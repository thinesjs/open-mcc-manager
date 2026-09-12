CREATE TABLE "instanceArtifact" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"instanceId" text NOT NULL,
	"kind" text NOT NULL,
	"collectedAt" timestamp DEFAULT now() NOT NULL,
	"byteSize" integer NOT NULL,
	"digest" text NOT NULL,
	"content" bytea NOT NULL,
	CONSTRAINT "instanceArtifact_org_id_unique" UNIQUE("organizationId","id"),
	CONSTRAINT "instanceArtifact_digest_unique" UNIQUE("organizationId","instanceId","kind","digest"),
	CONSTRAINT "instanceArtifact_kind_known" CHECK ("kind" IN ('playerList','replay')),
	CONSTRAINT "instanceArtifact_size_positive" CHECK ("byteSize" > 0)
);--> statement-breakpoint
ALTER TABLE "instanceArtifact" ADD CONSTRAINT "instanceArtifact_organization_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "instanceArtifact" ADD CONSTRAINT "instanceArtifact_instance_org_fk" FOREIGN KEY ("organizationId","instanceId") REFERENCES "public"."instance"("organizationId","id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "instanceArtifact_sweep_idx" ON "instanceArtifact" ("organizationId","instanceId","kind","collectedAt");
