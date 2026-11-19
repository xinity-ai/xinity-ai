{
  perSystem = { pkgs, ... }:
    let
      migrationDir = ../packages/common-db/db-migration;

      migrateScript = pkgs.writeShellScriptBin "xinity-db-migrate" ''
        set -euo pipefail

        DB_URL="''${DB_CONNECTION_URL:?DB_CONNECTION_URL must be set}"
        MIGRATION_DIR="${migrationDir}"

        # Ensure drizzle migration tracking table exists
        ${pkgs.postgresql_17}/bin/psql -v ON_ERROR_STOP=1 "$DB_URL" <<'SQL'
        CREATE SCHEMA IF NOT EXISTS "drizzle";
        CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
          id SERIAL PRIMARY KEY,
          hash TEXT NOT NULL,
          created_at BIGINT NOT NULL
        );
        SQL

        # Drizzle's own migrator records the journal's "when" and skips every migration older than
        # the newest recorded one, so rows must carry that value and never the time of applying
        ENTRIES=$(${pkgs.jq}/bin/jq -r '.entries[] | "\(.tag) \(.when)"' "$MIGRATION_DIR/meta/_journal.json")

        while read -r TAG WHEN; do
          HASH=$(${pkgs.coreutils}/bin/sha256sum "$MIGRATION_DIR/$TAG.sql" | cut -d' ' -f1)

          APPLIED=$(${pkgs.postgresql_17}/bin/psql "$DB_URL" -tAc \
            "SELECT COUNT(*) FROM \"drizzle\".\"__drizzle_migrations\" WHERE hash = '$HASH';")

          if [ "$APPLIED" -gt 0 ]; then
            # Rows written by earlier versions of this script hold the apply time
            ${pkgs.postgresql_17}/bin/psql -v ON_ERROR_STOP=1 -q "$DB_URL" -c \
              "UPDATE \"drizzle\".\"__drizzle_migrations\" SET created_at = $WHEN WHERE hash = '$HASH' AND created_at IS DISTINCT FROM $WHEN;"
            echo "  skip: $TAG (already applied)"
            continue
          fi

          echo "  apply: $TAG"
          # The migration and its tracking row commit together, so a failed migration is never recorded as applied
          {
            ${pkgs.gnused}/bin/sed 's/--> statement-breakpoint//' "$MIGRATION_DIR/$TAG.sql"
            echo
            echo "INSERT INTO \"drizzle\".\"__drizzle_migrations\" (hash, created_at) VALUES ('$HASH', $WHEN);"
          } | ${pkgs.postgresql_17}/bin/psql -v ON_ERROR_STOP=1 --single-transaction "$DB_URL"

          echo "  done: $TAG"
        done <<< "$ENTRIES"

        echo "All migrations up to date."
      '';
    in {
      packages.xinity-db-migrate = migrateScript;
    };
}
