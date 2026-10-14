-- Installations used to be shared by specifier and now belong to exactly one deployment.
-- Each existing installation joins the oldest live deployment serving its model on either side of
-- a canary. Removed installations, and running ones whose deployments are all gone, fall back to
-- a deleted deployment, so the scheduler removes the running ones the usual way. Deployments left
-- without an installation get their own from the scheduler. An installation no deployment ever
-- served is removed. The NOT NULL constraint follows in the schema-generated migration.
UPDATE "model_installation" mi SET "deployment_id" = (
  SELECT md."id" FROM "model_deployment" md
  WHERE mi."specifier" IN (md."specifier", md."early_specifier")
  ORDER BY md."deleted_at" IS NOT NULL, md."created_at"
  LIMIT 1
) WHERE mi."deployment_id" IS NULL;--> statement-breakpoint
DELETE FROM "model_installation" WHERE "deployment_id" IS NULL;
