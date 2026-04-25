CREATE TABLE "deployment_config" (
	"singleton" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"instance_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_config_singleton_check" CHECK ("deployment_config"."singleton" = 1)
);
