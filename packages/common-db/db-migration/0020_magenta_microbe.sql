CREATE TYPE "public"."deployment_type" AS ENUM('legacy', 'managed', 'canary');--> statement-breakpoint
CREATE TABLE "deployment_canary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"replicas" integer DEFAULT 1 NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"advance" jsonb DEFAULT '{"type":"manual","version":1}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_canary_members_check" CHECK ("deployment_canary"."from_id" <> "deployment_canary"."to_id")
);
--> statement-breakpoint
CREATE TABLE "deployment_managed" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"specifier" text NOT NULL,
	"replicas" integer DEFAULT 1 NOT NULL,
	"kv_cache_size" real,
	"preferred_driver" "inference_driver",
	"settings" jsonb DEFAULT '{"version":1}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"public_specifier" text NOT NULL,
	"type" "deployment_type" NOT NULL,
	"legacy_id" uuid,
	"managed_id" uuid,
	"canary_id" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_type_row_check" CHECK (num_nonnulls("deployment"."legacy_id", "deployment"."managed_id", "deployment"."canary_id") = 1 AND CASE "deployment"."type"
    WHEN 'legacy' THEN "deployment"."legacy_id" IS NOT NULL
    WHEN 'managed' THEN "deployment"."managed_id" IS NOT NULL
    WHEN 'canary' THEN "deployment"."canary_id" IS NOT NULL
    ELSE false
  END)
);
--> statement-breakpoint
ALTER TABLE "model_deployment" RENAME TO "deployment_legacy";--> statement-breakpoint
ALTER TABLE "model_installation" RENAME COLUMN "deployment_id" TO "legacy_id";--> statement-breakpoint
-- Written by hand, keep it when regenerating: every existing deployment becomes an entry under its old id before the legacy row loses its shared columns.
INSERT INTO "deployment" ("id", "organization_id", "name", "description", "enabled", "public_specifier", "type", "legacy_id", "deleted_at", "created_at", "updated_at")
SELECT "id", "organization_id", "name", "description", "enabled", "public_specifier", 'legacy', "id", "deleted_at", "created_at", "updated_at" FROM "deployment_legacy";--> statement-breakpoint
ALTER TABLE "deployment_legacy" DROP CONSTRAINT "model_deployment_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "model_installation" DROP CONSTRAINT "model_installation_deployment_id_model_deployment_id_fk";
--> statement-breakpoint
DROP INDEX "model_deployment_public_specifier_organization_id_idx";--> statement-breakpoint
DROP INDEX "model_deployment_deleted_at_idx";--> statement-breakpoint
DROP INDEX "model_installation_deployment_id_idx";--> statement-breakpoint
ALTER TABLE "model_installation" ADD COLUMN "managed_id" uuid;--> statement-breakpoint
ALTER TABLE "deployment_canary" ADD CONSTRAINT "deployment_canary_from_id_deployment_managed_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."deployment_managed"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_canary" ADD CONSTRAINT "deployment_canary_to_id_deployment_managed_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."deployment_managed"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_legacy_id_deployment_legacy_id_fk" FOREIGN KEY ("legacy_id") REFERENCES "public"."deployment_legacy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_managed_id_deployment_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."deployment_managed"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_canary_id_deployment_canary_id_fk" FOREIGN KEY ("canary_id") REFERENCES "public"."deployment_canary"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_canary_from_id_idx" ON "deployment_canary" USING btree ("from_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_canary_to_id_idx" ON "deployment_canary" USING btree ("to_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_public_specifier_organization_id_idx" ON "deployment" USING btree ("public_specifier","organization_id") WHERE "deployment"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_legacy_id_idx" ON "deployment" USING btree ("legacy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_managed_id_idx" ON "deployment" USING btree ("managed_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_canary_id_idx" ON "deployment" USING btree ("canary_id");--> statement-breakpoint
ALTER TABLE "model_installation" ADD CONSTRAINT "model_installation_legacy_id_deployment_legacy_id_fk" FOREIGN KEY ("legacy_id") REFERENCES "public"."deployment_legacy"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_installation" ADD CONSTRAINT "model_installation_managed_id_deployment_managed_id_fk" FOREIGN KEY ("managed_id") REFERENCES "public"."deployment_managed"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_installation_legacy_id_idx" ON "model_installation" USING btree ("legacy_id");--> statement-breakpoint
CREATE INDEX "model_installation_managed_id_idx" ON "model_installation" USING btree ("managed_id");--> statement-breakpoint
ALTER TABLE "deployment_legacy" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "deployment_legacy" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "deployment_legacy" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "deployment_legacy" DROP COLUMN "enabled";--> statement-breakpoint
ALTER TABLE "deployment_legacy" DROP COLUMN "public_specifier";--> statement-breakpoint
ALTER TABLE "deployment_legacy" DROP COLUMN "deleted_at";--> statement-breakpoint
ALTER TABLE "model_installation" ADD CONSTRAINT "model_installation_owner_check" CHECK (num_nonnulls("model_installation"."legacy_id", "model_installation"."managed_id") = 1);