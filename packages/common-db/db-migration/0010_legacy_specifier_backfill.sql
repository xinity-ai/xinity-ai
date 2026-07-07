-- Legacy provider-model identity retirement, data pass.
-- Deployments that predate the canonical specifier adopt their legacy value;
-- installations inherit the canonical specifier from the deployment that
-- provisioned them, so existing rows keep their ids and running models are
-- untouched. The column drops and NOT NULL constraints follow in the
-- schema-generated migration.
UPDATE "model_deployment" SET "specifier" = "model_specifier" WHERE "specifier" IS NULL;--> statement-breakpoint
UPDATE "model_deployment" SET "early_specifier" = "early_model_specifier"
  WHERE "early_specifier" IS NULL AND "early_model_specifier" IS NOT NULL;--> statement-breakpoint
UPDATE "model_installation" mi SET "specifier" = (
  SELECT md."specifier" FROM "model_deployment" md
  WHERE md."deleted_at" IS NULL
    AND mi."model" IN (md."specifier", md."model_specifier", md."early_specifier", md."early_model_specifier")
  ORDER BY md."enabled" DESC, md."created_at" DESC
  LIMIT 1
) WHERE mi."specifier" IS NULL;--> statement-breakpoint
DELETE FROM "model_installation" WHERE "specifier" IS NULL;
