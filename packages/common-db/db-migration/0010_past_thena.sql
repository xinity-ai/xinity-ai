CREATE TABLE "runner_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hashed_secret" text NOT NULL,
	"secret_preview" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_by_user_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runner_token" ADD CONSTRAINT "runner_token_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_token" ADD CONSTRAINT "runner_token_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runner_token_organization_id_idx" ON "runner_token" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_token_org_name_idx" ON "runner_token" USING btree ("organization_id","name") WHERE "runner_token"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "runner_token_prefix_idx" ON "runner_token" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "runner_token_deleted_at_idx" ON "runner_token" USING btree ("deleted_at");