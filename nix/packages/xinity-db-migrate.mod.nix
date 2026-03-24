{
  perSystem = { pkgs, ... }:
    let
      migrationDir = ../../packages/common-db/db-migration;

      migrateScript = pkgs.writeShellScriptBin "xinity-db-migrate" ''
        set -euo pipefail

        DB_URL="''${DB_CONNECTION_URL:?DB_CONNECTION_URL must be set}"
        MIGRATION_DIR="${migrationDir}"

        # Ensure drizzle migration tracking table exists
        ${pkgs.postgresql_17}/bin/psql "$DB_URL" <<'SQL'
        CREATE SCHEMA IF NOT EXISTS "drizzle";
        CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
          id SERIAL PRIMARY KEY,
          hash TEXT NOT NULL,
          created_at BIGINT NOT NULL
        );
        SQL

        # Read migration tags in order from the drizzle journal
        TAGS=$(${pkgs.jq}/bin/jq -r '.entries[].tag' "$MIGRATION_DIR/meta/_journal.json")

        for TAG in $TAGS; do
          HASH=$(${pkgs.coreutils}/bin/sha256sum "$MIGRATION_DIR/$TAG.sql" | cut -d' ' -f1)

          APPLIED=$(${pkgs.postgresql_17}/bin/psql "$DB_URL" -tAc \
            "SELECT COUNT(*) FROM \"drizzle\".\"__drizzle_migrations\" WHERE hash = '$HASH';")

          if [ "$APPLIED" -gt 0 ]; then
            echo "  skip: $TAG (already applied)"
            continue
          fi

          echo "  apply: $TAG"
          # Strip drizzle breakpoint markers and execute
          ${pkgs.gnused}/bin/sed 's/--> statement-breakpoint//' \
            "$MIGRATION_DIR/$TAG.sql" \
            | ${pkgs.postgresql_17}/bin/psql "$DB_URL"

          TIMESTAMP=$(date +%s%3N)
          ${pkgs.postgresql_17}/bin/psql "$DB_URL" -c \
            "INSERT INTO \"drizzle\".\"__drizzle_migrations\" (hash, created_at) VALUES ('$HASH', $TIMESTAMP);"

          echo "  done: $TAG"
        done

        echo "All migrations up to date."
      '';
    in {
      packages.xinity-db-migrate = migrateScript;
    };
}
