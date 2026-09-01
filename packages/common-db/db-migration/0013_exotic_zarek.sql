CREATE TYPE "call_data"."api_response_status" AS ENUM('in_progress', 'completed', 'failed', 'incomplete', 'cancelled');--> statement-breakpoint
CREATE TYPE "call_data"."inference_endpoint" AS ENUM('chat_completions', 'completions', 'embeddings', 'audio_transcriptions', 'rerank', 'responses');--> statement-breakpoint
CREATE TYPE "call_data"."message_direction" AS ENUM('input', 'output');--> statement-breakpoint
CREATE TABLE "call_data"."api_response_item" (
	"response_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"item_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "api_response_item_response_id_seq_pk" PRIMARY KEY("response_id","seq")
);
--> statement-breakpoint
CREATE TABLE "call_data"."api_response_message" (
	"response_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"message_id" uuid NOT NULL,
	"direction" "call_data"."message_direction" NOT NULL,
	CONSTRAINT "api_response_message_response_id_seq_pk" PRIMARY KEY("response_id","seq")
);
--> statement-breakpoint
CREATE TABLE "call_data"."api_response" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"api_key_id" uuid,
	"application_id" uuid,
	"model" text NOT NULL,
	"status" "call_data"."api_response_status" NOT NULL,
	"previous_response_id" uuid,
	"request_params" jsonb NOT NULL,
	"error" jsonb,
	"incomplete_details" jsonb,
	"usage" jsonb,
	"completed_at" timestamp with time zone,
	"inference_call_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_data"."chat_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"sha256" "bytea" NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_data"."inference_call_message" (
	"call_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"message_id" uuid NOT NULL,
	"direction" "call_data"."message_direction" NOT NULL,
	CONSTRAINT "inference_call_message_call_id_seq_pk" PRIMARY KEY("call_id","seq")
);
--> statement-breakpoint
CREATE TABLE "call_data"."inference_call_rating" (
	"user_id" text NOT NULL,
	"call_id" uuid NOT NULL,
	"verdict" boolean,
	"output_edit" text,
	"highlights" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"excluded_messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_call_rating_user_id_call_id_pk" PRIMARY KEY("user_id","call_id")
);
--> statement-breakpoint
CREATE TABLE "call_data"."inference_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"api_key_id" uuid,
	"application_id" uuid,
	"endpoint" "call_data"."inference_endpoint" NOT NULL,
	"served_model" text NOT NULL,
	"public_specifier" text NOT NULL,
	"user" text,
	"duration_ms" integer NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_data"."media_object" ALTER COLUMN "s3_bucket" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "call_data"."media_object" ALTER COLUMN "s3_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "call_data"."media_object" ADD COLUMN "bytes" "bytea";--> statement-breakpoint
ALTER TABLE "call_data"."api_response_item" ADD CONSTRAINT "api_response_item_response_id_api_response_id_fk" FOREIGN KEY ("response_id") REFERENCES "call_data"."api_response"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."api_response_message" ADD CONSTRAINT "api_response_message_response_id_api_response_id_fk" FOREIGN KEY ("response_id") REFERENCES "call_data"."api_response"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."api_response_message" ADD CONSTRAINT "api_response_message_message_id_chat_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "call_data"."chat_message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."api_response" ADD CONSTRAINT "api_response_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."api_response" ADD CONSTRAINT "api_response_api_key_id_ai_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."ai_api_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."api_response" ADD CONSTRAINT "api_response_application_id_ai_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."ai_application"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."chat_message" ADD CONSTRAINT "chat_message_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."inference_call_message" ADD CONSTRAINT "inference_call_message_call_id_inference_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "call_data"."inference_call"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."inference_call_message" ADD CONSTRAINT "inference_call_message_message_id_chat_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "call_data"."chat_message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."inference_call_rating" ADD CONSTRAINT "inference_call_rating_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."inference_call_rating" ADD CONSTRAINT "inference_call_rating_call_id_inference_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "call_data"."inference_call"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."inference_call" ADD CONSTRAINT "inference_call_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."inference_call" ADD CONSTRAINT "inference_call_api_key_id_ai_api_key_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."ai_api_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_data"."inference_call" ADD CONSTRAINT "inference_call_application_id_ai_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."ai_application"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_response_message_message_id_idx" ON "call_data"."api_response_message" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "api_response_organization_id_created_at_idx" ON "call_data"."api_response" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "api_response_api_key_id_idx" ON "call_data"."api_response" USING btree ("api_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_organization_id_sha256_idx" ON "call_data"."chat_message" USING btree ("organization_id","sha256");--> statement-breakpoint
CREATE INDEX "inference_call_message_message_id_idx" ON "call_data"."inference_call_message" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "inference_call_rating_call_id_idx" ON "call_data"."inference_call_rating" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "inference_call_api_key_id_idx" ON "call_data"."inference_call" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "inference_call_application_id_idx" ON "call_data"."inference_call" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "inference_call_organization_id_idx" ON "call_data"."inference_call" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "inference_call_organization_id_created_at_idx" ON "call_data"."inference_call" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "inference_call_served_model_idx" ON "call_data"."inference_call" USING btree ("served_model");--> statement-breakpoint
CREATE INDEX "inference_call_org_endpoint_created_at_idx" ON "call_data"."inference_call" USING btree ("organization_id","endpoint","created_at");