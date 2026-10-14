CREATE TYPE "public"."group_stage" AS ENUM('preparing', 'admitted', 'running', 'failed');--> statement-breakpoint
ALTER TABLE "model_installation" ALTER COLUMN "deployment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_node" ADD COLUMN "host_memory_gb" real;--> statement-breakpoint
ALTER TABLE "model_installation_state" ADD COLUMN "group_stage" "group_stage";--> statement-breakpoint
ALTER TABLE "model_installation_state" ADD COLUMN "group_generation" integer;--> statement-breakpoint
ALTER TABLE "model_installation" ADD COLUMN "host_capacity" real;--> statement-breakpoint
ALTER TABLE "model_installation" ADD COLUMN "max_num_seqs" integer;--> statement-breakpoint
ALTER TABLE "model_installation" ADD COLUMN "group" jsonb;