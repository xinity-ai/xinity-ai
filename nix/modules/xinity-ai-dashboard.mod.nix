{ self, ... }:
let
  version = (builtins.fromJSON (builtins.readFile "${self}/package.json")).version;
in {
  flake.nixosModules.dashboard = { config, lib, ... }:
    let
      cfg = config.services.xinity-ai-dashboard;
    in {
      options.services.xinity-ai-dashboard = {
        enable = lib.mkEnableOption "the xinity-ai dashboard, a SvelteKit web application that provides the admin UI for managing organizations, API keys, model routing, and user accounts";

        image = lib.mkOption {
          type = lib.types.str;
          default = "ghcr.io/xinity-ai/xinity-ai-dashboard:${version}";
          description = "OCI image reference for the dashboard container. Override this to pin a specific version or use a private registry.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 5121;
          description = "HTTP port the dashboard listens on inside the container. This port is also published to the host.";
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
          description = "Directory for persistent log files inside the container. When set, the dashboard writes structured JSON logs to this directory in addition to stdout. If null, only stdout logging is used.";
        };

        mountLogDir = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Whether to bind-mount logDir from the host into the container, making log files accessible outside the container. Requires logDir to be set to an absolute path. A systemd-tmpfiles rule is created to ensure the directory exists on the host.";
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

        containerUid = lib.mkOption {
          type = lib.types.int;
          default = 6000;
          description = "UID and GID the container process runs as. The container is started with --user=UID:UID. Any secret files passed via the *File options must be readable by this UID on the host.";
        };

        extraOptions = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ "--network=host" ];
          description = "Extra command-line options passed to the container runtime (podman/docker). Defaults to host networking; override with an empty list to use bridge networking.";
        };

        volumes = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = "Extra OCI volume mounts in host:container[:options] format (e.g. /srv/logs:/usr/src/app/logs:ro). Secret file mounts are added automatically when *File options are set.";
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
          extraOptions = [ "--user=${toString cfg.containerUid}:${toString cfg.containerUid}" ] ++ cfg.extraOptions;
        };
      };
    };
}
