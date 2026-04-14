ALTER TABLE "ai_node" ADD COLUMN "driver_versions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_node" ADD COLUMN "gpus" jsonb DEFAULT '[]'::jsonb NOT NULL;