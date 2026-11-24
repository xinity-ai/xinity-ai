{ lib, ... }:
{
  perSystem = { pkgs, ... }:
    let
      releaseInfo = lib.importJSON ./release.json;

      releaseUrl = path:
        "https://github.com/xinity-ai/xinity-ai/releases/download/${releaseInfo.tag}/${path}";

      mkReleaseBundle = { pname }:
        let
          hash = releaseInfo.bundles.${pname}
            or (throw "packages.mod.nix: no bundle hash for ${pname} in nix/release.json");
        in
        pkgs.runCommand "${pname}-${releaseInfo.version}"
          {
            src = pkgs.fetchurl {
              url = releaseUrl "${pname}.js";
              inherit hash;
            };
            nativeBuildInputs = [ pkgs.makeWrapper ];
            passthru.bundle = pname;
            meta.mainProgram = pname;
          } ''
            install -Dm644 $src $out/share/${pname}/${pname}.js
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/${pname} \
              --add-flags "run $out/share/${pname}/${pname}.js"
          '';

      mkReleaseBinary = { pname, binaryName ? pname }:
        let
          archByNixSystem = {
            "x86_64-linux" = "linux-x64";
            "aarch64-linux" = "linux-arm64";
          };
          system = pkgs.stdenv.hostPlatform.system;
          arch = archByNixSystem.${system}
            or (throw "packages.mod.nix: ${pname} not published for ${system}");
          hash = releaseInfo.binaries.${pname}.${system}
            or (throw "packages.mod.nix: no binary hash for ${pname} on ${system} in nix/release.json");
        in
        pkgs.stdenv.mkDerivation {
          inherit pname;
          version = releaseInfo.version;
          src = pkgs.fetchurl {
            url = releaseUrl "${pname}-${arch}.tar.gz";
            inherit hash;
          };
          sourceRoot = ".";
          nativeBuildInputs = [ pkgs.autoPatchelfHook ];
          buildInputs = [ pkgs.stdenv.cc.cc.lib ];
          dontConfigure = true;
          dontBuild = true;
          dontStrip = true;
          installPhase = ''
            runHook preInstall
            install -Dm755 ${binaryName} $out/bin/${binaryName}
            runHook postInstall
          '';
          meta = {
            mainProgram = binaryName;
            platforms = builtins.attrNames archByNixSystem;
          };
        };
      releaseMigrations = pkgs.runCommand "xinity-db-migrations-${releaseInfo.version}"
        {
          src = pkgs.fetchurl {
            url = releaseUrl "db-migrations.tar.gz";
            hash = releaseInfo.migrations
              or (throw "packages.mod.nix: no migrations hash in nix/release.json");
          };
        } ''
          mkdir -p $out
          tar xzf $src -C $out
        '';

      migrateScript = pkgs.writeShellScriptBin "xinity-db-migrate" ''
        set -euo pipefail

        DB_URL="''${DB_CONNECTION_URL:?DB_CONNECTION_URL must be set}"
        MIGRATION_DIR="${releaseMigrations}"

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

      # The catalog is data in this repo rather than a release asset, so it comes
      # from the pinned flake source. Only the model files are copied, so a README
      # edit does not rebuild it.
      modelCatalog = pkgs.runCommand "xinity-models-${releaseInfo.version}"
        {
          src = ../models;
          passthru.modelDir = true;
          meta.description = "Xinity model catalog, usable as services.xinity-infoserver.modelInfoDir";
        } ''
          mkdir -p $out
          cd $src
          find . \( -name '*.yaml' -o -name '*.yml' \) \
            -exec install -Dm644 {} $out/{} \;
        '';
    in {
      packages = {
        xinity-models       = modelCatalog;
        xinity-ai-gateway   = mkReleaseBundle { pname = "xinity-ai-gateway"; };
        xinity-ai-daemon    = mkReleaseBundle { pname = "xinity-ai-daemon"; };
        xinity-infoserver   = mkReleaseBundle { pname = "xinity-infoserver"; };
        xinity-tether       = mkReleaseBundle { pname = "xinity-tether"; };
        xinity-ai-dashboard = mkReleaseBinary { pname = "xinity-ai-dashboard"; };
        xinity-cli          = mkReleaseBinary { pname = "xinity-cli"; binaryName = "xinity"; };
        xinity-db-migrate   = migrateScript;
      };
    };
}
