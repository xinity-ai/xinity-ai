{ withSystem, ... }: {
  flake.nixosModules.tether = { config, lib, pkgs, ... }:
    let
      withHostSystem = withSystem pkgs.stdenv.hostPlatform.system;
      cfg = config.services.xinity-tether;
    in {
      options.services.xinity-tether = {
        enable = lib.mkEnableOption "the xinity-tether, a lightweight mediator between xinity-ai daemons and PostgreSQL that provides desired-state streaming via SSE, status ingestion, and liveness detection";

        package = lib.mkOption {
          type = lib.types.package;
          default = withHostSystem ({ config, ... }: config.packages.xinity-tether);
          description = "The xinity-tether package to use. Defaults to the prebuilt release bundle for the current platform.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 4020;
          description = "HTTP port the tether listens on.";
        };

        host = lib.mkOption {
          type = lib.types.str;
          default = "0.0.0.0";
          description = "Host address the tether binds to.";
        };

        dbConnectionUrlFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the PostgreSQL connection URL. Loaded via systemd's LoadCredential mechanism.";
        };

        tetherSecretFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the shared secret for daemon authentication. Loaded via systemd's LoadCredential mechanism.";
        };

        metricsAuthFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the metrics auth credentials. Loaded via systemd's LoadCredential mechanism.";
        };

        openFirewall = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Open the tether's port in the firewall. Needed when inference nodes run on other machines, since they connect to the tether directly.";
        };

        tlsCertFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the PEM-encoded TLS certificate. Loaded via systemd LoadCredential and exposed as XINITY_TLS_CERT_FILE. Enables HTTPS on the tether.";
        };

        tlsKeyFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the PEM-encoded TLS private key. Required with tlsCertFile.";
        };

        idleTimeout = lib.mkOption {
          type = lib.types.ints.between 1 255;
          default = 255;
          description = ''
            Seconds a connection may go without traffic before the server closes it.
            Keepalive writes reset it, so daemon SSE connections stay open indefinitely.
            Must be at least three times keepaliveIntervalMs, which the tether
            refuses to start without.
          '';
        };

        keepaliveIntervalMs = lib.mkOption {
          type = lib.types.int;
          default = 15000;
          description = "Interval in milliseconds between SSE keepalive writes.";
        };

        livenessTimeoutMs = lib.mkOption {
          type = lib.types.int;
          default = 45000;
          description = "Time in milliseconds before a silent SSE connection is considered dead and the node is marked unavailable.";
        };

        logLevel = lib.mkOption {
          type = lib.types.enum [ "fatal" "error" "warn" "info" "debug" "trace" ];
          default = "info";
          description = "Pino log level.";
        };

        logDir = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Directory for persistent log files.";
        };

        environmentFiles = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = ''
            systemd EnvironmentFile paths loaded at service start.
            This is the recommended way to inject secrets without exposing them in the Nix store.
          '';
        };

        extraEnvironment = lib.mkOption {
          type = lib.types.attrsOf lib.types.str;
          default = { };
          description = "Additional environment variables to pass to the service.";
        };
      };

      config = lib.mkIf cfg.enable {
        assertions = [
          {
            assertion = cfg.keepaliveIntervalMs * 3 <= cfg.idleTimeout * 1000;
            message = "services.xinity-tether.keepaliveIntervalMs (${toString cfg.keepaliveIntervalMs}ms) must be at most a third of idleTimeout (${toString cfg.idleTimeout}s), otherwise the tether drops live daemon connections between keepalives.";
          }
          {
            assertion = (cfg.tlsCertFile == null) == (cfg.tlsKeyFile == null);
            message = "services.xinity-tether.tlsCertFile and tlsKeyFile must both be set or both be null.";
          }
        ];

        networking.firewall.allowedTCPPorts =
          lib.mkIf cfg.openFirewall [ cfg.port ];

        systemd.services.xinity-tether = {
          description = "Xinity Tether";
          wantedBy = [ "multi-user.target" ];
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          environment = {
            PORT = toString cfg.port;
            HOST = cfg.host;
            IDLE_TIMEOUT = toString cfg.idleTimeout;
            KEEPALIVE_INTERVAL_MS = toString cfg.keepaliveIntervalMs;
            LIVENESS_TIMEOUT_MS = toString cfg.livenessTimeoutMs;
            LOG_LEVEL = cfg.logLevel;
          }
          // lib.optionalAttrs (cfg.dbConnectionUrlFile != null) {
            DB_CONNECTION_URL_FILE = "%d/db-connection-url";
          }
          // lib.optionalAttrs (cfg.tetherSecretFile != null) {
            TETHER_SECRET_FILE = "%d/tether-secret";
          }
          // lib.optionalAttrs (cfg.metricsAuthFile != null) {
            METRICS_AUTH_FILE = "%d/metrics-auth";
          }
          // lib.optionalAttrs (cfg.tlsCertFile != null) {
            XINITY_TLS_CERT_FILE = "%d/tls-cert";
          }
          // lib.optionalAttrs (cfg.tlsKeyFile != null) {
            XINITY_TLS_KEY_FILE = "%d/tls-key";
          }
          // lib.optionalAttrs (cfg.logDir != null) {
            LOG_DIR = cfg.logDir;
          }
          // cfg.extraEnvironment;
          serviceConfig = let
            loadCredentialEntries =
              lib.optional (cfg.dbConnectionUrlFile != null) "db-connection-url:${cfg.dbConnectionUrlFile}"
              ++ lib.optional (cfg.tetherSecretFile != null) "tether-secret:${cfg.tetherSecretFile}"
              ++ lib.optional (cfg.metricsAuthFile != null) "metrics-auth:${cfg.metricsAuthFile}"
              ++ lib.optional (cfg.tlsCertFile != null) "tls-cert:${cfg.tlsCertFile}"
              ++ lib.optional (cfg.tlsKeyFile != null) "tls-key:${cfg.tlsKeyFile}";
          in {
            EnvironmentFile = cfg.environmentFiles;
            ExecStart = "${cfg.package}/bin/xinity-tether";
            Restart = "always";
            RestartSec = 5;
          } // lib.optionalAttrs (loadCredentialEntries != [ ]) {
            LoadCredential = loadCredentialEntries;
          };
        };
      };
    };
}
