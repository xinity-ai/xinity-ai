ALTER TABLE "ai_node" ADD COLUMN "interconnect" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "model_installation" ADD COLUMN "deployment_id" uuid;--> statement-breakpoint
ALTER TABLE "model_installation" ADD COLUMN "gpu_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "model_installation" ADD CONSTRAINT "model_installation_deployment_id_model_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."model_deployment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_installation_deployment_id_idx" ON "model_installation" USING btree ("deployment_id");