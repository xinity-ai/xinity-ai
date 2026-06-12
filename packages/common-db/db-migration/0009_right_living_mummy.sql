ALTER TABLE "call_data"."usage_event" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "call_data"."usage_event" ADD COLUMN "success" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_node" ADD COLUMN "machine_name" text;--> statement-breakpoint
ALTER TABLE "call_data"."usage_event" ADD CONSTRAINT "usage_event_node_id_ai_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."ai_node"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_event_node_id_created_at_idx" ON "call_data"."usage_event" USING btree ("node_id","created_at");