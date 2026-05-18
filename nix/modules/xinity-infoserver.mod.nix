{ withSystem, ... }: {
  flake.nixosModules.infoserver = { config, lib, pkgs, ... }:
    let
      withHostSystem = withSystem pkgs.stdenv.hostPlatform.system;
      cfg = config.services.xinity-infoserver;

      removed = path: message:
        lib.mkRemovedOptionModule
          ([ "services" "xinity-infoserver" ] ++ path)
          message;
    in {
      imports = [
        (removed [ "image" ]
          "The infoserver now runs as a native systemd service backed by `services.xinity-infoserver.package`, not an OCI container. Remove this option from your configuration.")
        (removed [ "extraOptions" ]
          "OCI container runtime arguments don't apply to the systemd service the infoserver now runs as. Remove this option from your configuration.")
      ];

      options.services.xinity-infoserver = {
        enable = lib.mkEnableOption "the xinity-infoserver, a lightweight service that reads a YAML model definition file and serves model metadata (pricing, capabilities, routing) to the gateway and dashboard";

        package = lib.mkOption {
          type = lib.types.package;
          default = withHostSystem ({ config, ... }: config.packages.xinity-infoserver);
          description = "The xinity-infoserver package to use. Defaults to the prebuilt release binary for the current platform.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 8090;
          description = "HTTP port the infoserver listens on.";
        };

        modelInfoFile = lib.mkOption {
          type = lib.types.nullOr lib.types.path;
          default = null;
          description = "Deprecated: use modelInfoDir instead. Path to a single models YAML file on the host. Will be removed in 1.0.0.";
        };

        modelInfoDir = lib.mkOption {
          type = lib.types.nullOr lib.types.path;
          default = null;
          description = "Path to a directory of model YAML files on the host. This is the preferred way to configure model sources.";
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
          description = "Directory for persistent log files. When set, the infoserver writes structured JSON logs to this directory in addition to stdout/journald.";
        };

        environmentFiles = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = ''
            systemd EnvironmentFile paths loaded at service start.
            This is the RECOMMENDED and SECURE way to provide credentials.
            Secrets in environment files are not exposed in the Nix store.
          '';
        };

        extraEnvironment = lib.mkOption {
          type = lib.types.attrsOf lib.types.str;
          default = { };
          description = "Additional environment variables to pass to the service.";
        };
      };

      config = lib.mkIf cfg.enable {
        assertions = [{
          assertion = cfg.modelInfoFile != null || cfg.modelInfoDir != null;
          message = "services.xinity-infoserver: modelInfoDir must be set (or the deprecated modelInfoFile).";
        }];

        systemd.services.xinity-infoserver = {
          description = "Xinity Infoserver";
          wantedBy = [ "multi-user.target" ];
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          environment = {
            PORT = toString cfg.port;
            REFRESH_INTERVAL_MS = toString cfg.refreshIntervalMs;
            MAX_INCLUDE_DEPTH = toString cfg.maxIncludeDepth;
            LOG_LEVEL = cfg.logLevel;
          }
          // lib.optionalAttrs (cfg.modelInfoFile != null) {
            MODEL_INFO_FILE = cfg.modelInfoFile;
          }
          // lib.optionalAttrs (cfg.logDir != null) {
            LOG_DIR = cfg.logDir;
          }
          // lib.optionalAttrs (cfg.modelInfoDir != null) {
            MODEL_INFO_DIR = cfg.modelInfoDir;
          }
          // cfg.extraEnvironment;
          serviceConfig = {
            EnvironmentFile = cfg.environmentFiles;
            ExecStart = "${cfg.package}/bin/xinity-infoserver";
            Restart = "always";
            RestartSec = 5;
          };
        };
      };
    };
}
