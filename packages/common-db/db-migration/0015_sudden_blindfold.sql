CREATE TABLE "dynamic_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"value_digest" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_node" ADD COLUMN "public_key" text;