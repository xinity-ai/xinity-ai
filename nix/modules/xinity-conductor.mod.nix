{ self, ... }:
let
  version = (builtins.fromJSON (builtins.readFile "${self}/package.json")).version;
in {
  flake.nixosModules.conductor = { config, lib, ... }:
    let
      cfg = config.services.xinity-conductor;
    in {
      options.services.xinity-conductor = {
        enable = lib.mkEnableOption "the xinity-conductor, the service that sits between runners and the database, coordinating status reports and pushing desired state over SSE";

        image = lib.mkOption {
          type = lib.types.str;
          default = "ghcr.io/xinity-ai/xinity-conductor:${version}";
          description = "OCI image reference for the conductor container. Override this to pin a specific version or use a private registry.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 4020;
          description = "HTTP port the conductor listens on inside the container. This port is also published to the host.";
        };

        logLevel = lib.mkOption {
          type = lib.types.enum [ "fatal" "error" "warn" "info" "debug" "trace" ];
          default = "debug";
          description = "Pino log level. Controls the verbosity of structured JSON logs emitted by the conductor.";
        };

        logDir = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Directory for persistent log files. When set, the conductor writes structured JSON logs to this directory in addition to stdout. If null, only stdout logging is used.";
        };

        # --- Secret file options (recommended for production) ---
        # Uses the _FILE env var pattern: the app reads the secret from the file at runtime.
        # Files are mounted read-only into the container at /run/secrets/*.

        dbConnectionUrlFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the PostgreSQL connection URL.";
        };

        # --- Generic escape hatches ---

        environmentFiles = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = ''
            Environment files for sensitive values (DB_CONNECTION_URL, etc.).
            This is the RECOMMENDED and SECURE way to provide credentials.
            Secrets in environment files are not exposed in the Nix store.
          '';
        };

        extraEnvironment = lib.mkOption {
          type = lib.types.attrsOf lib.types.str;
          default = { };
          description = "Additional environment variables to pass to the container.";
        };

        extraOptions = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ "--network=host" ];
          description = "Extra command-line options passed to the container runtime (podman/docker). Defaults to host networking; override with an empty list to use bridge networking.";
        };
      };

      config = lib.mkIf cfg.enable {
        virtualisation.oci-containers.containers.xinity-conductor = {
          image = cfg.image;
          ports = [ "${toString cfg.port}:${toString cfg.port}" ];
          environment = {
            HOST = "0.0.0.0";
            PORT = toString cfg.port;
            LOG_LEVEL = cfg.logLevel;
          }
          // lib.optionalAttrs (cfg.logDir != null) {
            LOG_DIR = cfg.logDir;
          }
          // lib.optionalAttrs (cfg.dbConnectionUrlFile != null) {
            DB_CONNECTION_URL_FILE = "/run/secrets/db-connection-url";
          }
          // cfg.extraEnvironment;
          environmentFiles = cfg.environmentFiles;
          volumes = lib.optional (cfg.dbConnectionUrlFile != null)
            "${cfg.dbConnectionUrlFile}:/run/secrets/db-connection-url:ro";
          extraOptions = cfg.extraOptions;
        };
      };
    };
}
