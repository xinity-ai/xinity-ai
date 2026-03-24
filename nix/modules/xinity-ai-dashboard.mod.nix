{ self, ... }:
let
  version = (builtins.fromJSON (builtins.readFile "${self}/package.json")).version;
in {
  flake.nixosModules.dashboard = { config, lib, ... }:
    let
      cfg = config.services.xinity-ai-dashboard;
    in {
      options.services.xinity-ai-dashboard = {
        enable = lib.mkEnableOption "xinity-ai-dashboard OCI container";

        image = lib.mkOption {
          type = lib.types.str;
          default = "ghcr.io/xinity-ai/xinity-ai-dashboard:${version}";
          description = "OCI image for the dashboard.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 5121;
          description = "Port the dashboard listens on.";
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
          description = "Public URL of the auth service (e.g. https://dashboard.example.com).";
        };

        origin = lib.mkOption {
          type = lib.types.str;
          default = "http://localhost:5173";
          description = "Allowed origin for CORS / SvelteKit ORIGIN.";
        };

        infoserverUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = "https://sysinfo.xinity.at";
          description = "URL of the xinity-infoserver instance.";
        };

        publicLlmApiUrl = lib.mkOption {  
          type = lib.types.str;
          default = "http://localhost:4121";
          description = "Client-side URL to the gateway API (PUBLIC_LLM_API_URL).";
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
          description = "Whether user self-registration is enabled.";
        };

        computeManagementEnabled = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable compute management features.";
        };

        notificationsEnabled = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable the notification scheduler.";
        };

        multiTenantMode = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Allow any authenticated user to create organizations.";
        };

        infoserverCacheTtlMs = lib.mkOption {
          type = lib.types.int;
          default = 30000;
          description = "How long to cache infoserver responses locally (ms).";
        };

        nodeEnv = lib.mkOption {
          type = lib.types.enum [ "production" "development" "test" ];
          default = "production";
          description = "Node environment.";
        };

        logLevel = lib.mkOption {
          type = lib.types.str;
          default = "debug";
          description = "Pino log level.";
        };

        logDir = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Directory for log files inside the container. If null, only stdout logging is used.";
        };

        mountLogDir = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Whether to mount logDir as a volume from the host. Requires logDir to be set and an absolute path.";
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
          description = "S3 bucket for media objects.";
        };

        s3Region = lib.mkOption {
          type = lib.types.str;
          default = "us-east-1";
          description = "S3 region (use 'us-east-1' for SeaweedFS).";
        };

        mcpEnabled = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Enable the /mcp Model Context Protocol endpoint.";
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
          description = "Comma-separated list of instance admin emails (enables single-tenant mode).";
        };

        # --- Secret file options (recommended for production) ---
        # These use the _FILE env var pattern: the app reads the secret from the file at runtime.
        # Files are mounted read-only into the container at /run/secrets/*.

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
            Environment files for sensitive values (BETTER_AUTH_SECRET, DB_CONNECTION_URL, etc.).
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

        volumes = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = "Extra volume mounts (e.g. ./logs:/usr/src/app/packages/xinity-ai-dashboard/logs).";
        };
      };

      config = lib.mkIf cfg.enable {
        assertions = [
          {
            assertion = !cfg.mountLogDir || (cfg.logDir != null && lib.hasPrefix "/" cfg.logDir);
            message = ''
              services.xinity-ai-dashboard.mountLogDir is enabled, but logDir is ${if cfg.logDir == null then "null" else "\"${cfg.logDir}\" (not an absolute path)"}.
              Set logDir to an absolute path (starting with /) when using mountLogDir.
            '';
          }
        ];

        # Ensure log directory exists with correct permissions when mounting
        systemd.tmpfiles.rules = lib.optional cfg.mountLogDir
          "d ${cfg.logDir} 0777 - - - -";

        virtualisation.oci-containers.containers.xinity-ai-dashboard = {
          image = cfg.image;
          ports = [ "${toString cfg.port}:${toString cfg.port}" ];
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
            PUBLIC_LLM_API_URL = cfg.publicLlmApiUrl;
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
          // lib.optionalAttrs (cfg.betterAuthUrl != null) {
            BETTER_AUTH_URL = cfg.betterAuthUrl;
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
          // lib.optionalAttrs (cfg.licenseKey != null) {
            LICENSE_KEY = cfg.licenseKey;
          }
          # --- Secret file env vars (_FILE pattern) ---
          // lib.optionalAttrs (cfg.dbConnectionUrlFile != null) {
            DB_CONNECTION_URL_FILE = "/run/secrets/db-connection-url";
          }
          // lib.optionalAttrs (cfg.betterAuthSecretFile != null) {
            BETTER_AUTH_SECRET_FILE = "/run/secrets/better-auth-secret";
          }
          // lib.optionalAttrs (cfg.mailUrlFile != null) {
            MAIL_URL_FILE = "/run/secrets/mail-url";
          }
          // lib.optionalAttrs (cfg.metricsAuthFile != null) {
            METRICS_AUTH_FILE = "/run/secrets/metrics-auth";
          }
          // lib.optionalAttrs (cfg.s3AccessKeyIdFile != null) {
            S3_ACCESS_KEY_ID_FILE = "/run/secrets/s3-access-key-id";
          }
          // lib.optionalAttrs (cfg.s3SecretAccessKeyFile != null) {
            S3_SECRET_ACCESS_KEY_FILE = "/run/secrets/s3-secret-access-key";
          }
          // lib.optionalAttrs (cfg.licenseKeyFile != null) {
            LICENSE_KEY_FILE = "/run/secrets/license-key";
          }
          // cfg.extraEnvironment;
          environmentFiles = cfg.environmentFiles;
          volumes = cfg.volumes
            ++ lib.optional cfg.mountLogDir "${cfg.logDir}:${cfg.logDir}"
            ++ lib.optional (cfg.dbConnectionUrlFile != null) "${cfg.dbConnectionUrlFile}:/run/secrets/db-connection-url:ro"
            ++ lib.optional (cfg.betterAuthSecretFile != null) "${cfg.betterAuthSecretFile}:/run/secrets/better-auth-secret:ro"
            ++ lib.optional (cfg.mailUrlFile != null) "${cfg.mailUrlFile}:/run/secrets/mail-url:ro"
            ++ lib.optional (cfg.metricsAuthFile != null) "${cfg.metricsAuthFile}:/run/secrets/metrics-auth:ro"
            ++ lib.optional (cfg.s3AccessKeyIdFile != null) "${cfg.s3AccessKeyIdFile}:/run/secrets/s3-access-key-id:ro"
            ++ lib.optional (cfg.s3SecretAccessKeyFile != null) "${cfg.s3SecretAccessKeyFile}:/run/secrets/s3-secret-access-key:ro"
            ++ lib.optional (cfg.licenseKeyFile != null) "${cfg.licenseKeyFile}:/run/secrets/license-key:ro";
          extraOptions = cfg.extraOptions;
        };
      };
    };
}
