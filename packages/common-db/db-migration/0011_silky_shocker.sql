CREATE TYPE "public"."audit_actor_type" AS ENUM('user', 'api_key', 'system', 'instance_admin');--> statement-breakpoint
CREATE TYPE "public"."audit_result" AS ENUM('success', 'failure');--> statement-breakpoint
CREATE TABLE "call_data"."audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"action" text NOT NULL,
	"resource" text NOT NULL,
	"resource_id" text,
	"result" "audit_result" NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "model_installation_model_idx";--> statement-breakpoint
ALTER TABLE "model_deployment" ALTER COLUMN "specifier" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "model_installation" ALTER COLUMN "specifier" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN "verified" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN "failed_verification_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN "locked_until" timestamp;--> statement-breakpoint
ALTER TABLE "ai_node" ADD COLUMN "driver_features" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "model_deployment" ADD COLUMN "settings" jsonb DEFAULT '{"version":1}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "model_installation" ADD COLUMN "settings" jsonb DEFAULT '{"version":1}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "call_data"."audit_event" ADD CONSTRAINT "audit_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_organization_id_created_at_idx" ON "call_data"."audit_event" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_event_organization_id_actor_id_created_at_idx" ON "call_data"."audit_event" USING btree ("organization_id","actor_id","created_at");--> statement-breakpoint
ALTER TABLE "ai_node" DROP COLUMN "drivers";--> statement-breakpoint
ALTER TABLE "model_deployment" DROP COLUMN "model_specifier";--> statement-breakpoint
ALTER TABLE "model_deployment" DROP COLUMN "early_model_specifier";--> statement-breakpoint
ALTER TABLE "model_installation" DROP COLUMN "model";