ALTER TABLE "ai_node" ADD COLUMN "auth_token" text;--> statement-breakpoint
ALTER TABLE "ai_node" ADD COLUMN "tls" boolean DEFAULT false NOT NULL;