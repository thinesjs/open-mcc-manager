ALTER TABLE "instance" ADD COLUMN "liveControlTokenEncrypted" text;--> statement-breakpoint
ALTER TABLE "instance" ADD COLUMN "liveControlTokenKeyId" text;--> statement-breakpoint
ALTER TABLE "instance" ADD CONSTRAINT "instance_live_control_token_pairs" CHECK (("instance"."liveControlTokenEncrypted" IS NULL) = ("instance"."liveControlTokenKeyId" IS NULL));
