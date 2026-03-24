{ self, ... }:
let
  version = (builtins.fromJSON (builtins.readFile "${self}/package.json")).version;
in {
  flake.nixosModules.infoserver = { config, lib, ... }:
    let
      cfg = config.services.xinity-infoserver;
    in {
      options.services.xinity-infoserver = {
        enable = lib.mkEnableOption "xinity-infoserver OCI container";

        image = lib.mkOption {
          type = lib.types.str;
          default = "ghcr.io/xinity-ai/xinity-infoserver:${version}";
          description = "OCI image for the infoserver.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 8090;
          description = "Port the infoserver listens on.";
        };

        modelInfoFile = lib.mkOption {
          type = lib.types.path;
          description = "Path to the models YAML file on the host. Will be mounted into the container.";
        };

        refreshIntervalMs = lib.mkOption {
          type = lib.types.int;
          default = 300000;
          description = "How often to re-read model file and re-fetch includes (ms).";
        };

        maxIncludeDepth = lib.mkOption {
          type = lib.types.int;
          default = 10;
          description = "Maximum recursion depth when resolving include URLs.";
        };

        logLevel = lib.mkOption {
          type = lib.types.enum [ "fatal" "error" "warn" "info" "debug" "trace" ];
          default = "info";
          description = "Pino log level.";
        };

        logDir = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Directory for log files. If null, only stdout logging is used.";
        };

        environmentFiles = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = ''
            Environment files to pass to the container.
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
          description = "Extra options to pass to the container runtime.";
        };
      };

      config = lib.mkIf cfg.enable {
        virtualisation.oci-containers.containers.xinity-infoserver = {
          image = cfg.image;
          ports = [ "${toString cfg.port}:${toString cfg.port}" ];
          environment = {
            PORT = toString cfg.port;
            MODEL_INFO_FILE = "/data/models.yaml";
            REFRESH_INTERVAL_MS = toString cfg.refreshIntervalMs;
            MAX_INCLUDE_DEPTH = toString cfg.maxIncludeDepth;
            LOG_LEVEL = cfg.logLevel;
          }
          // lib.optionalAttrs (cfg.logDir != null) {
            LOG_DIR = cfg.logDir;
          }
          // cfg.extraEnvironment;
          volumes = [
            "${cfg.modelInfoFile}:/data/models.yaml:ro"
          ];
          environmentFiles = cfg.environmentFiles;
          extraOptions = cfg.extraOptions;
        };
      };
    };
}
