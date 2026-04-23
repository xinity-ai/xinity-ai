{ self, ... }:
let
  version = (builtins.fromJSON (builtins.readFile "${self}/package.json")).version;
in {
  flake.nixosModules.infoserver = { config, lib, ... }:
    let
      cfg = config.services.xinity-infoserver;
    in {
      options.services.xinity-infoserver = {
        enable = lib.mkEnableOption "the xinity-infoserver, a lightweight service that reads a YAML model definition file and serves model metadata (pricing, capabilities, routing) to the gateway and dashboard";

        image = lib.mkOption {
          type = lib.types.str;
          default = "ghcr.io/xinity-ai/xinity-infoserver:${version}";
          description = "OCI image reference for the infoserver container. Override this to pin a specific version or use a private registry.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 8090;
          description = "HTTP port the infoserver listens on inside the container. This port is also published to the host.";
        };

        modelInfoFile = lib.mkOption {
          type = lib.types.nullOr lib.types.path;
          default = null;
          description = "Deprecated: use modelInfoDir instead. Path to a single models YAML file on the host. Will be removed in 1.0.0.";
        };

        modelInfoDir = lib.mkOption {
          type = lib.types.nullOr lib.types.path;
          default = null;
          description = "Path to a directory of model YAML files on the host. Mounted into the container at /data/models.d/. This is the preferred way to configure model sources.";
        };

        refreshIntervalMs = lib.mkOption {
          type = lib.types.int;
          default = 300000;
          description = "Interval in milliseconds between automatic refreshes. On each cycle the infoserver re-reads the model YAML file from disk and re-fetches any remote include URLs, picking up changes without a restart.";
        };

        maxIncludeDepth = lib.mkOption {
          type = lib.types.int;
          default = 10;
          description = "Maximum recursion depth when resolving remote include URLs in the model YAML. Prevents infinite loops if included files reference each other. Increase only if you have a deeply nested include hierarchy.";
        };

        logLevel = lib.mkOption {
          type = lib.types.enum [ "fatal" "error" "warn" "info" "debug" "trace" ];
          default = "debug";
          description = "Pino log level. Controls the verbosity of structured JSON logs emitted by the infoserver.";
        };

        logDir = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Directory for persistent log files. When set, the infoserver writes structured JSON logs to this directory in addition to stdout. If null, only stdout logging is used.";
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
          description = "Extra command-line options passed to the container runtime (podman/docker). Defaults to host networking; override with an empty list to use bridge networking.";
        };
      };

      config = lib.mkIf cfg.enable {
        assertions = [{
          assertion = cfg.modelInfoFile != null || cfg.modelInfoDir != null;
          message = "services.xinity-infoserver: modelInfoDir must be set (or the deprecated modelInfoFile).";
        }];

        virtualisation.oci-containers.containers.xinity-infoserver = {
          image = cfg.image;
          ports = [ "${toString cfg.port}:${toString cfg.port}" ];
          environment = {
            PORT = toString cfg.port;
            REFRESH_INTERVAL_MS = toString cfg.refreshIntervalMs;
            MAX_INCLUDE_DEPTH = toString cfg.maxIncludeDepth;
            LOG_LEVEL = cfg.logLevel;
          }
          // lib.optionalAttrs (cfg.modelInfoFile != null) {
            MODEL_INFO_FILE = "/data/models.yaml";
          }
          // lib.optionalAttrs (cfg.logDir != null) {
            LOG_DIR = cfg.logDir;
          }
          // lib.optionalAttrs (cfg.modelInfoDir != null) {
            MODEL_INFO_DIR = "/data/models.d";
          }
          // cfg.extraEnvironment;
          volumes = lib.optionals (cfg.modelInfoFile != null) [
            "${cfg.modelInfoFile}:/data/models.yaml:ro"
          ] ++ lib.optionals (cfg.modelInfoDir != null) [
            "${cfg.modelInfoDir}:/data/models.d:ro"
          ];
          environmentFiles = cfg.environmentFiles;
          extraOptions = cfg.extraOptions;
        };
      };
    };
}
