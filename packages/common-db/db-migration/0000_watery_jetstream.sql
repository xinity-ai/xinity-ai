CREATE SCHEMA "call_data";
--> statement-breakpoint
CREATE TYPE "public"."inference_driver" AS ENUM('ollama', 'vllm');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_state" AS ENUM('downloading', 'installing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invitation_status" AS ENUM('pending', 'accepted', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "ai_api_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"specifier" text NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"collect_data" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"organization_id" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"start" text,
	"prefix" text,
	"key" text NOT NULL,
	"user_id" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_time_window" integer,
	"rate_limit_max" integer,
	"request_count" integer,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"permissions" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp,
	"ip_address" text,
	"user_agent" text,
	"active_organization_id" text,
	"impersonated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"domain" text NOT NULL,
	"oidc_config" text,
	"saml_config" text,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"organization_id" text,
	"domain_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean,
	"image" text,
	"notification_settings" jsonb NOT NULL,
	"display_settings" jsonb NOT NULL,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"ban_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_data"."api_call_response" (
	"user_id" text NOT NULL,
	"api_call_id" uuid NOT NULL,
	"response" boolean,
	"output_edit" text,
	"highlights" jsonb,
	"excluded_messages" jsonb,
	"input_exclusions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_call_response_user_id_api_call_id_pk" PRIMARY KEY("user_id","api_call_id")
);
--> statement-breakpoint
CREATE TABLE "call_data"."api_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid,
	"application_id" uuid,
	"organization_id" text NOT NULL,
	"model" text NOT NULL,
	"specified_model" text NOT NULL,
	"user" text,
	"duration" integer NOT NULL,
	"input_messages" jsonb NOT NULL,
	"output_message" jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_data"."media_object" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sha256" text NOT NULL,
	"mime_type" text NOT NULL,
	"original_url" text,
	"s3_bucket" text NOT NULL,
	"s3_key" text NOT NULL,
	"organization_id" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_data"."usage_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" uuid,
	"api_key_id" uuid,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"duration" integer,
	"logged" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_data"."usage_summary" (
	"date" date NOT NULL,
	"organization_id" text NOT NULL,
	"application_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000' NOT NULL,
	"api_key_id" uuid NOT NULL,
	"model" text NOT NULL,
	"total_calls" integer DEFAULT 0 NOT NULL,
	"logged_calls" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"total_duration" bigint DEFAULT 0,
	CONSTRAINT "usage_summary_date_organization_id_application_id_api_key_id_model_pk" PRIMARY KEY("date","organization_id","application_id","api_key_id","model")
);
--> statement-breakpoint
CREATE TABLE "ai_node" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"est_capacity" real NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"drivers" text[] DEFAULT '{"ollama"}' NOT NULL,
	"gpu_count" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_deployment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"public_specifier" text NOT NULL,
	"model_specifier" text NOT NULL,
	"early_model_specifier" text,
	"replicas" integer DEFAULT 1 NOT NULL,
	"canary_progress_until" timestamp with time zone,
	"canary_progress_from" timestamp with time zone,
	"canary_progress_with_feedback" boolean DEFAULT false NOT NULL,
	"progress" integer DEFAULT 100 NOT NULL,
	"kv_cache_size" real,
	"early_kv_cache_size" real,
	"preferred_driver" "inference_driver",
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_installation_state" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lifecycle_state" "lifecycle_state" NOT NULL,
	"progress" real,
	"error_message" text,
	"status_message" text,
	"failure_logs" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_installation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"model" text NOT NULL,
	"est_capacity" real NOT NULL,
	"kv_cache_capacity" real DEFAULT 0 NOT NULL,
	"port" integer NOT NULL,
	"driver" "inference_driver" NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text,
	"type" text NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"subject" text NOT NULL,
	"metadata" jsonb,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"inviter_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"role" text NOT NULL,
	"status" "invitation_status" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"team_id" text
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"sso_self_manage" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "ai_api_key" ADD CONSTRAINT "ai_api_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_api_key" ADD CONSTRAINT "ai_api_key_application_id_ai_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."ai_application"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_api_key" ADD CONSTRAINT "ai_api_key_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_application" ADD CONSTRAINT "ai_application_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_api_key" ADD CONSTRAINT "dashboard_api_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_active_organization_id_organization_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."api_call_response" ADD CONSTRAINT "api_call_response_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."api_call_response" ADD CONSTRAINT "api_call_response_api_call_id_api_call_id_fk" FOREIGN KEY ("api_call_id") REFERENCES "call_data"."api_call"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."api_call" ADD CONSTRAINT "api_call_api_key_id_ai_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."ai_api_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."api_call" ADD CONSTRAINT "api_call_application_id_ai_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."ai_application"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."api_call" ADD CONSTRAINT "api_call_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."media_object" ADD CONSTRAINT "media_object_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."usage_event" ADD CONSTRAINT "usage_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."usage_event" ADD CONSTRAINT "usage_event_application_id_ai_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."ai_application"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."usage_event" ADD CONSTRAINT "usage_event_api_key_id_ai_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."ai_api_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_deployment" ADD CONSTRAINT "model_deployment_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_installation_state" ADD CONSTRAINT "model_installation_state_id_model_installation_id_fk" FOREIGN KEY ("id") REFERENCES "public"."model_installation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_installation" ADD CONSTRAINT "model_installation_node_id_ai_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."ai_node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_api_key_organization_id_idx" ON "ai_api_key" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_api_key_specifier_idx" ON "ai_api_key" USING btree ("specifier");--> statement-breakpoint
CREATE INDEX "ai_api_key_application_id_idx" ON "ai_api_key" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "ai_api_key_deleted_at_idx" ON "ai_api_key" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "ai_application_organization_id_idx" ON "ai_application" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ai_application_deleted_at_idx" ON "ai_application" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_application_name_organization_id_unique" ON "ai_application" USING btree ("name","organization_id") WHERE "ai_application"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "account_account_id_provider_id_idx" ON "account" USING btree ("account_id","provider_id");--> statement-breakpoint
CREATE INDEX "dashboard_api_key_user_id_idx" ON "dashboard_api_key" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "dashboard_api_key_prefix_idx" ON "dashboard_api_key" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "passkey_user_id_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_token_idx" ON "session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "two_factor_user_id_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "api_call_api_key_id_idx" ON "call_data"."api_call" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "api_call_application_id_idx" ON "call_data"."api_call" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "api_call_organization_id_idx" ON "call_data"."api_call" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "api_call_organization_id_created_at_idx" ON "call_data"."api_call" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "api_call_model_idx" ON "call_data"."api_call" USING btree ("model");--> statement-breakpoint
CREATE UNIQUE INDEX "media_object_organization_id_sha256_idx" ON "call_data"."media_object" USING btree ("organization_id","sha256");--> statement-breakpoint
CREATE INDEX "media_object_organization_id_idx" ON "call_data"."media_object" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "usage_event_organization_id_created_at_idx" ON "call_data"."usage_event" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_event_created_at_idx" ON "call_data"."usage_event" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "usage_event_api_key_id_idx" ON "call_data"."usage_event" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "usage_summary_organization_id_idx" ON "call_data"."usage_summary" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "usage_summary_organization_id_date_idx" ON "call_data"."usage_summary" USING btree ("organization_id","date");--> statement-breakpoint
CREATE INDEX "ai_node_deleted_at_idx" ON "ai_node" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_node_host_port_idx" ON "ai_node" USING btree ("host","port") WHERE "ai_node"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "model_deployment_public_specifier_organization_id_idx" ON "model_deployment" USING btree ("public_specifier","organization_id") WHERE "model_deployment"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "model_deployment_deleted_at_idx" ON "model_deployment" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "model_installation_node_id_idx" ON "model_installation" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "model_installation_model_idx" ON "model_installation" USING btree ("model");--> statement-breakpoint
CREATE INDEX "model_installation_deleted_at_idx" ON "model_installation" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "notification_user_id_idx" ON "notification" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_organization_id_idx" ON "notification" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "notification_type_idx" ON "notification" USING btree ("type");--> statement-breakpoint
CREATE INDEX "notification_deleted_at_idx" ON "notification" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "invitation_organization_id_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_user_id_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "member_organization_id_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_user_id_organization_id_idx" ON "member" USING btree ("user_id","organization_id");