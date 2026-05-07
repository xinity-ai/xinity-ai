ALTER TABLE "model_deployment" ADD COLUMN "specifier" text;--> statement-breakpoint
ALTER TABLE "model_deployment" ADD COLUMN "early_specifier" text;--> statement-breakpoint
ALTER TABLE "model_installation" ADD COLUMN "specifier" text;--> statement-breakpoint
CREATE INDEX "model_installation_specifier_idx" ON "model_installation" USING btree ("specifier");