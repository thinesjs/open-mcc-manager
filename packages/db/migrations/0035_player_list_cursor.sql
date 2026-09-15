ALTER TABLE "instance" ADD COLUMN "playerListOffset" bigint NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "instance" ADD CONSTRAINT "instance_player_list_offset_not_negative" CHECK ("instance"."playerListOffset" >= 0);--> statement-breakpoint
ALTER TABLE "instance" ADD COLUMN "playerListFingerprint" text DEFAULT 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';--> statement-breakpoint
UPDATE "instance" SET "playerListFingerprint" = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' WHERE "playerListFingerprint" IS NULL;--> statement-breakpoint
ALTER TABLE "instance" ALTER COLUMN "playerListFingerprint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "instance" ADD COLUMN "playerListCursorVersion" bigint NOT NULL DEFAULT 0;
