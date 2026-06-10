CREATE TABLE "node_metric" (
	"node_id" uuid NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"gpu_utilization_avg" real DEFAULT 0 NOT NULL,
	"gpu_utilization_max" real DEFAULT 0 NOT NULL,
	"memory_used_mb" integer DEFAULT 0 NOT NULL,
	"power_watts_avg" real,
	"energy_wh" real DEFAULT 0 NOT NULL,
	CONSTRAINT "node_metric_node_id_bucket_start_pk" PRIMARY KEY("node_id","bucket_start")
);
--> statement-breakpoint
ALTER TABLE "call_data"."usage_event" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "call_data"."usage_event" ADD COLUMN "success" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_node" ADD COLUMN "machine_name" text;--> statement-breakpoint
ALTER TABLE "ai_node" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_node" ADD COLUMN "total_energy_wh" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "node_metric" ADD CONSTRAINT "node_metric_node_id_ai_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."ai_node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_metric_bucket_start_idx" ON "node_metric" USING btree ("bucket_start");--> statement-breakpoint
ALTER TABLE "call_data"."usage_event" ADD CONSTRAINT "usage_event_node_id_ai_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."ai_node"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_event_node_id_created_at_idx" ON "call_data"."usage_event" USING btree ("node_id","created_at");