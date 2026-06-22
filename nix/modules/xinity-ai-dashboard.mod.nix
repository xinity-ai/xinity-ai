{ withSystem, ... }: {
  flake.nixosModules.dashboard = { config, lib, pkgs, ... }:
    let
      withHostSystem = withSystem pkgs.stdenv.hostPlatform.system;
      cfg = config.services.xinity-ai-dashboard;

      removed = path: message:
        lib.mkRemovedOptionModule
          ([ "services" "xinity-ai-dashboard" ] ++ path)
          message;

      loadCredentialEntries =
        lib.optional (cfg.dbConnectionUrlFile != null) "db-connection-url:${cfg.dbConnectionUrlFile}"
        ++ lib.optional (cfg.betterAuthSecretFile != null) "better-auth-secret:${cfg.betterAuthSecretFile}"
        ++ lib.optional (cfg.mailUrlFile != null) "mail-url:${cfg.mailUrlFile}"
        ++ lib.optional (cfg.metricsAuthFile != null) "metrics-auth:${cfg.metricsAuthFile}"
        ++ lib.optional (cfg.s3AccessKeyIdFile != null) "s3-access-key-id:${cfg.s3AccessKeyIdFile}"
        ++ lib.optional (cfg.s3SecretAccessKeyFile != null) "s3-secret-access-key:${cfg.s3SecretAccessKeyFile}"
        ++ lib.optional (cfg.licenseKeyFile != null) "license-key:${cfg.licenseKeyFile}";
    in {
      imports = [
        (removed [ "image" ]
          "The dashboard now runs as a native systemd service backed by `services.xinity-ai-dashboard.package`, not an OCI container. Remove this option from your configuration.")
        (removed [ "containerUid" ]
          "The dashboard now runs as a native systemd service, not an OCI container. Remove this option from your configuration.")
        (removed [ "extraOptions" ]
          "OCI container runtime arguments don't apply to the systemd service the dashboard now runs as. Remove this option from your configuration.")
        (removed [ "volumes" ]
          "OCI volume mounts don't apply to the systemd service the dashboard now runs as. Secrets are exposed via `LoadCredential` driven by the `*File` options instead. Remove this option from your configuration.")
        (removed [ "mountLogDir" ]
          "The dashboard now writes directly to the host path set in `logDir`; no bind-mount is needed. Remove this option from your configuration.")
      ];

      options.services.xinity-ai-dashboard = {
        enable = lib.mkEnableOption "the xinity-ai dashboard, a SvelteKit web application that provides the admin UI for managing organizations, API keys, model routing, and user accounts";

        package = lib.mkOption {
          type = lib.types.package;
          default = withHostSystem ({ config, ... }: config.packages.xinity-ai-dashboard);
          description = "The xinity-ai-dashboard package to use. Defaults to the prebuilt release binary for the current platform.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 5121;
          description = "HTTP port the dashboard listens on.";
        };

        # --- Required settings ---

        dbConnectionUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            PostgreSQL connection URL.
            WARNING: DO NOT USE IN PRODUCTION. Use environmentFiles instead to keep credentials secure.
            This option exposes secrets in the Nix store.
          '';
        };

        betterAuthSecret = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            Better Auth secret key. Generate using 'openssl rand -base64 32'.
            WARNING: DO NOT USE IN PRODUCTION. Use environmentFiles instead to keep credentials secure.
            This option exposes secrets in the Nix store.
          '';
        };

        betterAuthUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Public URL of the auth service (e.g. https://dashboard.example.com). Used by Better Auth for OAuth callbacks and session cookie domains.";
        };

        origin = lib.mkOption {
          type = lib.types.str;
          default = "http://localhost:5173";
          description = "Allowed origin for CORS headers and SvelteKit's ORIGIN check. Must match the URL users visit in their browser, including the scheme (e.g. https://dashboard.example.com).";
        };

        infoserverUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = "https://sysinfo.xinity.at";
          description = "Internal URL of the xinity-infoserver instance. The dashboard uses this server-side to fetch available model information.";
        };

        gatewayUrl = lib.mkOption {
          type = lib.types.str;
          default = "http://localhost:4121";
          description = "Public-facing gateway base URL shown to users in documentation and code examples (e.g. https://api.example.com). Must NOT include the /v1 path segment - that is appended by the dashboard and code examples as needed.";
        };

        # --- Optional settings ---

        appName = lib.mkOption {
          type = lib.types.str;
          default = "Xinity Admin";
          description = "Display name of the application.";
        };

        signupEnabled = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Whether user self-registration is enabled. When disabled, only existing users or those invited by an admin can sign in.";
        };

        computeManagementEnabled = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable the compute management UI, which allows administrators to register, monitor, and manage inference nodes directly from the dashboard.";
        };

        notificationsEnabled = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable the background notification scheduler that sends email alerts for events such as usage limits, node health changes, and system announcements.";
        };

        multiTenantMode = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "When enabled, any authenticated user can create new organizations. When disabled, only instance administrators can create organizations, and regular users must be invited.";
        };

        infoserverCacheTtlMs = lib.mkOption {
          type = lib.types.int;
          default = 30000;
          description = "Duration in milliseconds to cache responses from the infoserver. Reduces load on the infoserver when the dashboard frequently queries model availability.";
        };

        nodeEnv = lib.mkOption {
          type = lib.types.enum [ "production" "development" "test" ];
          default = "production";
          description = "Node.js runtime environment. Use \"production\" for optimized builds, \"development\" for verbose error pages and hot-reload support.";
        };

        logLevel = lib.mkOption {
          type = lib.types.str;
          default = "debug";
          description = "Pino log level. Valid values from most to least verbose: trace, debug, info, warn, error, fatal.";
        };

        logDir = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Directory for persistent log files. When set, the dashboard writes structured JSON logs to this directory in addition to stdout/journald.";
        };

        mailUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            SMTP connection URL (e.g. smtps://user:pass@mail.example.com).
            WARNING: DO NOT USE IN PRODUCTION. Use environmentFiles instead to keep credentials secure.
            This option exposes secrets in the Nix store.
          '';
        };

        mailFrom = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Sender address for outgoing emails.";
        };

        metricsAuth = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            username:password for /metrics endpoint.
            WARNING: DO NOT USE IN PRODUCTION. Use environmentFiles instead to keep credentials secure.
            This option exposes secrets in the Nix store.
          '';
        };

        # --- S3 / SeaweedFS settings ---

        s3Endpoint = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "SeaweedFS / S3-compatible endpoint URL.";
        };

        s3AccessKeyId = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            S3 access key ID.
            WARNING: DO NOT USE IN PRODUCTION. Use environmentFiles instead to keep credentials secure.
            This option exposes secrets in the Nix store.
          '';
        };

        s3SecretAccessKey = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            S3 secret access key.
            WARNING: DO NOT USE IN PRODUCTION. Use environmentFiles instead to keep credentials secure.
            This option exposes secrets in the Nix store.
          '';
        };

        s3Bucket = lib.mkOption {
          type = lib.types.str;
          default = "xinity-media";
          description = "S3 bucket name used for storing uploaded media objects such as user avatars and organization logos.";
        };

        s3Region = lib.mkOption {
          type = lib.types.str;
          default = "us-east-1";
          description = "S3 region for the object storage endpoint. For SeaweedFS or MinIO, the conventional value is 'us-east-1'.";
        };

        mcpEnabled = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable the /mcp endpoint implementing the Model Context Protocol (MCP). This allows AI coding assistants and other MCP-compatible clients to interact with the dashboard programmatically.";
        };

        prometheusUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "URL of a Prometheus instance the dashboard queries server-side for live GPU metrics (e.g. http://127.0.0.1:9090). When set, the Compute page shows utilization rings and energy readouts. Leave null to keep the Compute page in its no-metrics mode.";
        };

        licenseKey = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            License key for unlocking paid features (Ed25519-signed token).
            WARNING: DO NOT USE IN PRODUCTION. Use licenseKeyFile or environmentFiles instead to keep credentials secure.
            This option exposes secrets in the Nix store.
          '';
        };

        instanceAdminEmails = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Comma-separated list of email addresses that are granted instance-admin privileges. Setting this enables single-tenant mode, where these users have full control and no organizations are needed.";
        };

        # --- Secret file options (recommended for production) ---
        # Loaded via systemd's LoadCredential mechanism and exposed under %d/.

        dbConnectionUrlFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the PostgreSQL connection URL.";
        };

        betterAuthSecretFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the Better Auth secret key.";
        };

        mailUrlFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the SMTP mail URL.";
        };

        metricsAuthFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the metrics basic auth credentials.";
        };

        s3AccessKeyIdFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the S3 access key ID.";
        };

        s3SecretAccessKeyFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the S3 secret access key.";
        };

        licenseKeyFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the license key.";
        };

        # --- Generic escape hatches ---

        environmentFiles = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = ''
            systemd EnvironmentFile paths loaded at service start for sensitive values
            (BETTER_AUTH_SECRET, DB_CONNECTION_URL, etc.). This is the RECOMMENDED and
            SECURE way to provide credentials.
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
        # Require a METRICS_AUTH source: the service-discovery endpoint would
        # otherwise expose compute-node topology to anonymous callers.
        assertions = [
          {
            assertion = cfg.metricsAuth != null || cfg.metricsAuthFile != null || cfg.environmentFiles != [ ];
            message = "services.xinity-ai-dashboard: METRICS_AUTH is required. Set `metricsAuth`, `metricsAuthFile`, or provide METRICS_AUTH via `environmentFiles`.";
          }
        ];

        systemd.services.xinity-ai-dashboard = {
          description = "Xinity AI Dashboard";
          wantedBy = [ "multi-user.target" ];
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          environment = {
            HTTP_PORT = toString cfg.port;
            ORIGIN = cfg.origin;
            NODE_ENV = cfg.nodeEnv;
            APP_NAME = cfg.appName;
            SIGNUP_ENABLED = lib.boolToString cfg.signupEnabled;
            COMPUTE_MANAGEMENT_ENABLED = lib.boolToString cfg.computeManagementEnabled;
            NOTIFICATIONS_ENABLED = lib.boolToString cfg.notificationsEnabled;
            MULTI_TENANT_MODE = lib.boolToString cfg.multiTenantMode;
            MCP_ENABLED = lib.boolToString cfg.mcpEnabled;
            INFOSERVER_CACHE_TTL_MS = toString cfg.infoserverCacheTtlMs;
            LOG_LEVEL = cfg.logLevel;
            GATEWAY_URL = cfg.gatewayUrl;
            S3_BUCKET = cfg.s3Bucket;
            S3_REGION = cfg.s3Region;
          }
          // lib.optionalAttrs (cfg.logDir != null) {
            LOG_DIR = cfg.logDir;
          }
          // lib.optionalAttrs (cfg.dbConnectionUrl != null) {
            DB_CONNECTION_URL = cfg.dbConnectionUrl;
          }
          // lib.optionalAttrs (cfg.betterAuthSecret != null) {
            BETTER_AUTH_SECRET = cfg.betterAuthSecret;
          }
          // lib.optionalAttrs (cfg.infoserverUrl != null) {
            INFOSERVER_URL = cfg.infoserverUrl;
          }
          // lib.optionalAttrs (cfg.mailUrl != null) {
            MAIL_URL = cfg.mailUrl;
          }
          // lib.optionalAttrs (cfg.mailFrom != null) {
            MAIL_FROM = cfg.mailFrom;
          }
          // lib.optionalAttrs (cfg.metricsAuth != null) {
            METRICS_AUTH = cfg.metricsAuth;
          }
          // lib.optionalAttrs (cfg.s3Endpoint != null) {
            S3_ENDPOINT = cfg.s3Endpoint;
          }
          // lib.optionalAttrs (cfg.s3AccessKeyId != null) {
            S3_ACCESS_KEY_ID = cfg.s3AccessKeyId;
          }
          // lib.optionalAttrs (cfg.s3SecretAccessKey != null) {
            S3_SECRET_ACCESS_KEY = cfg.s3SecretAccessKey;
          }
          // lib.optionalAttrs (cfg.instanceAdminEmails != null) {
            INSTANCE_ADMIN_EMAILS = cfg.instanceAdminEmails;
          }
          // lib.optionalAttrs (cfg.prometheusUrl != null) {
            PROMETHEUS_URL = cfg.prometheusUrl;
          }
          // lib.optionalAttrs (cfg.licenseKey != null) {
            LICENSE_KEY = cfg.licenseKey;
          }
          // lib.optionalAttrs (cfg.dbConnectionUrlFile != null) {
            DB_CONNECTION_URL_FILE = "%d/db-connection-url";
          }
          // lib.optionalAttrs (cfg.betterAuthSecretFile != null) {
            BETTER_AUTH_SECRET_FILE = "%d/better-auth-secret";
          }
          // lib.optionalAttrs (cfg.mailUrlFile != null) {
            MAIL_URL_FILE = "%d/mail-url";
          }
          // lib.optionalAttrs (cfg.metricsAuthFile != null) {
            METRICS_AUTH_FILE = "%d/metrics-auth";
          }
          // lib.optionalAttrs (cfg.s3AccessKeyIdFile != null) {
            S3_ACCESS_KEY_ID_FILE = "%d/s3-access-key-id";
          }
          // lib.optionalAttrs (cfg.s3SecretAccessKeyFile != null) {
            S3_SECRET_ACCESS_KEY_FILE = "%d/s3-secret-access-key";
          }
          // lib.optionalAttrs (cfg.licenseKeyFile != null) {
            LICENSE_KEY_FILE = "%d/license-key";
          }
          // cfg.extraEnvironment;
          serviceConfig = {
            EnvironmentFile = cfg.environmentFiles;
            ExecStart = "${cfg.package}/bin/xinity-ai-dashboard";
            Restart = "always";
            RestartSec = 5;
          } // lib.optionalAttrs (loadCredentialEntries != [ ]) {
            LoadCredential = loadCredentialEntries;
          };
        };
      };
    };
}
