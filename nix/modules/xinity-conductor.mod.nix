{ withSystem, ... }: {
  flake.nixosModules.conductor = { config, lib, pkgs, ... }:
    let
      withHostSystem = withSystem pkgs.stdenv.hostPlatform.system;
      cfg = config.services.xinity-conductor;
    in {

      options.services.xinity-conductor = {
        enable = lib.mkEnableOption "the xinity-conductor, the service that sits between runners and the database, coordinating status reports and pushing desired state over SSE";

        package = lib.mkOption {
          type = lib.types.package;
          default = withHostSystem ({ config, ... }: config.packages.xinity-conductor);
          description = "The xinity-conductor package to use. Defaults to the prebuilt release binary for the current platform.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 4020;
          description = "HTTP port the conductor listens on.";
        };

        logLevel = lib.mkOption {
          type = lib.types.enum [ "fatal" "error" "warn" "info" "debug" "trace" ];
          default = "debug";
          description = "Pino log level. Controls the verbosity of structured JSON logs emitted by the conductor.";
        };

        logDir = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Directory for persistent log files. When set, the conductor writes structured JSON logs to this directory in addition to stdout/journald.";
        };

        dbConnectionUrlFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the PostgreSQL connection URL.";
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
        systemd.services.xinity-conductor = {
          description = "Xinity Conductor";
          wantedBy = [ "multi-user.target" ];
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          environment = {
            HOST = "0.0.0.0";
            PORT = toString cfg.port;
            LOG_LEVEL = cfg.logLevel;
          }
          // lib.optionalAttrs (cfg.logDir != null) {
            LOG_DIR = cfg.logDir;
          }
          // lib.optionalAttrs (cfg.dbConnectionUrlFile != null) {
            DB_CONNECTION_URL_FILE = cfg.dbConnectionUrlFile;
          }
          // cfg.extraEnvironment;
          serviceConfig = {
            EnvironmentFile = cfg.environmentFiles;
            ExecStart = "${cfg.package}/bin/xinity-conductor";
            Restart = "always";
            RestartSec = 5;
          };
        };
      };
    };
}
