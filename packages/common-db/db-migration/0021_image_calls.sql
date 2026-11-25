CREATE TYPE "public"."model_type" AS ENUM('embedding', 'chat', 'rerank', 'transcription', 'image');--> statement-breakpoint
ALTER TYPE "call_data"."inference_endpoint" ADD VALUE 'images_generations';--> statement-breakpoint
ALTER TYPE "call_data"."inference_endpoint" ADD VALUE 'images_edits';--> statement-breakpoint
CREATE TABLE "call_data"."inference_call_image" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"request_params" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_data"."inference_call_media" (
	"call_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"media_object_id" uuid NOT NULL,
	CONSTRAINT "inference_call_media_call_id_seq_pk" PRIMARY KEY("call_id","seq")
);
--> statement-breakpoint
ALTER TABLE "call_data"."usage_event" ADD COLUMN "model_type" "model_type";--> statement-breakpoint
ALTER TABLE "call_data"."usage_summary" ADD COLUMN "model_type" "model_type";--> statement-breakpoint
ALTER TABLE "call_data"."inference_call_image" ADD CONSTRAINT "inference_call_image_call_id_inference_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "call_data"."inference_call"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."inference_call_media" ADD CONSTRAINT "inference_call_media_call_id_inference_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "call_data"."inference_call"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."inference_call_media" ADD CONSTRAINT "inference_call_media_media_object_id_media_object_id_fk" FOREIGN KEY ("media_object_id") REFERENCES "call_data"."media_object"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inference_call_media_media_object_id_idx" ON "call_data"."inference_call_media" USING btree ("media_object_id");--> statement-breakpoint
-- Written by hand, keep when regenerating. 0020 renamed the NOT NULL deployment_id to legacy_id without relaxing it,
-- while its snapshot records the column nullable, so generate cannot produce this. Installations of managed deployments leave it empty.
ALTER TABLE "model_installation" ALTER COLUMN "legacy_id" DROP NOT NULL;--> statement-breakpoint
