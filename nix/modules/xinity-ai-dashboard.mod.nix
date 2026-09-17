{ withSystem, ... }: {
  flake.nixosModules.dashboard = { config, lib, pkgs, ... }:
    let
      withHostSystem = withSystem pkgs.stdenv.hostPlatform.system;
      cfg = config.services.xinity-ai-dashboard;
      s3Options = import ./lib/s3-options.nix { inherit lib; };
      dynamicConfig = import ./lib/dynamic-config.nix { inherit lib; };

      # [sync:dynamic-keys] - generated from the config declaration, do not edit
      dashboardManageableKeys = [
        "SIGNUP_ENABLED"
        "DEPLOYMENT_STRATEGY"
        "PROMETHEUS_URL"
        "LICENSE_KEY"
        "MCP_ENABLED"
        "NOTIFICATIONS_ENABLED"
      ];
      # [/sync:dynamic-keys]

      removed = path: message:
        lib.mkRemovedOptionModule
          ([ "services" "xinity-ai-dashboard" ] ++ path)
          message;

      renamed = from: to:
        lib.mkRenamedOptionModule
          ([ "services" "xinity-ai-dashboard" ] ++ from)
          ([ "services" "xinity-ai-dashboard" ] ++ to);

      loadCredentialEntries =
        lib.optional (cfg.dbConnectionUrlFile != null) "db-connection-url:${cfg.dbConnectionUrlFile}"
        ++ lib.optional (cfg.betterAuthSecretFile != null) "better-auth-secret:${cfg.betterAuthSecretFile}"
        ++ lib.optional (cfg.mailUrlFile != null) "mail-url:${cfg.mailUrlFile}"
        ++ lib.optional (cfg.metricsAuthFile != null) "metrics-auth:${cfg.metricsAuthFile}"
        ++ lib.optional (cfg.secretKeyFile != null) "secret-key:${cfg.secretKeyFile}"
        ++ lib.optional (cfg.s3AccessKeyIdFile != null) "s3-access-key-id:${cfg.s3AccessKeyIdFile}"
        ++ lib.optional (cfg.s3SecretAccessKeyFile != null) "s3-secret-access-key:${cfg.s3SecretAccessKeyFile}"
        ++ lib.optional (cfg.licenseKeyFile != null) "license-key:${cfg.licenseKeyFile}"
        ++ lib.optional (cfg.tlsCertFile != null) "tls-cert:${cfg.tlsCertFile}"
        ++ lib.optional (cfg.tlsKeyFile != null) "tls-key:${cfg.tlsKeyFile}";
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
        (removed [ "betterAuthUrl" ]
          "The dashboard never read this; auth redirects and session cookies follow `origin`. Set that instead and remove this option from your configuration.")
        (renamed [ "auditLokiUrl" ] [ "auditSinkUrl" ])
        (renamed [ "auditLokiTenant" ] [ "auditSinkTenant" ])
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
            WARNING: DO NOT USE IN PRODUCTION. Set DB_CONNECTION_URL through environmentFiles, or use dbConnectionUrlFile, to keep credentials secure.
            This option exposes secrets in the Nix store.
          '';
        };

        betterAuthSecret = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            Better Auth secret key. Generate using 'openssl rand -base64 32'.
            WARNING: DO NOT USE IN PRODUCTION. Set BETTER_AUTH_SECRET through environmentFiles, or use betterAuthSecretFile, to keep credentials secure.
            This option exposes secrets in the Nix store.
          '';
        };

        origin = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Allowed origin for CORS headers and SvelteKit's ORIGIN check. Must match the URL users visit in their browser, including the scheme (e.g. https://dashboard.example.com). Required: no default can be right for a deployment, and a wrong one breaks auth redirects and CSRF validation. The allinone module derives it from `domain` and `dashboardSubdomain`.";
        };

        infoserverUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = "https://sysinfo.xinity.ai";
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
          default = 600000;
          description = "How long the local catalog snapshot is trusted before the dashboard re-validates it. A revalidation costs one 304 when nothing changed; this sets how stale a newly published model entry can be.";
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
            WARNING: DO NOT USE IN PRODUCTION. Set MAIL_URL through environmentFiles, or use mailUrlFile, to keep credentials secure.
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
            WARNING: DO NOT USE IN PRODUCTION. Set METRICS_AUTH through environmentFiles, or use metricsAuthFile, to keep credentials secure.
            This option exposes secrets in the Nix store.
          '';
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

        auditSinkUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Sink audit events are mirrored to for SIEM ingestion. The scheme picks the transport: http(s):// is a Loki base URL (e.g. http://127.0.0.1:6122), udp://, tcp:// or tls:// is an RFC 5424 syslog collector (e.g. tls://collector.example.com:6514). Requires a license with the audit-log feature. Leave null to keep audit events in the database only. Syslog tuning (facility, framing, app name, CA) goes through extraEnvironment.";
        };

        auditSinkTenant = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Tenant id sent as X-Scope-OrgID to a Loki auditSinkUrl. Only needed for multi-tenant Loki or Grafana Cloud.";
        };

        tlsCertFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the PEM-encoded TLS certificate. Loaded via systemd LoadCredential and exposed as XINITY_TLS_CERT_FILE. Enables HTTPS on the dashboard, which is only needed when nothing terminates TLS in front of it.";
        };

        tlsKeyFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the PEM-encoded TLS private key. Setting only one of the pair is a configuration error and the dashboard refuses to start rather than serve plaintext.";
        };

        licenseKey = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            License key for unlocking paid features (Ed25519-signed token).
            WARNING: DO NOT USE IN PRODUCTION. Set LICENSE_KEY through environmentFiles, or use licenseKeyFile, to keep credentials secure.
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

        secretKeyFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            Path to a file containing XINITY_SECRET_KEY, 32 bytes of base64 from
            `openssl rand -base64 32`. The dashboard encrypts dashboard-managed secrets with
            it before storing them, so every host that sets or reads one needs the same value.

            During a key rotation, supply XINITY_SECRET_KEY_PREVIOUS through environmentFiles.
          '';
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

        # --- Reverse proxy (adapter-level settings) ---

        reverseProxy = {
          ipHeader = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            example = "x-forwarded-for";
            description = "HTTP header the reverse proxy uses to pass the real client IP. Set to \"x-forwarded-for\" when running behind a reverse proxy (Caddy, nginx, Traefik). When null, the adapter uses the raw TCP peer address.";
          };

          xffDepth = lib.mkOption {
            type = lib.types.int;
            default = 1;
            description = "Number of trusted proxy hops. The adapter reads the Nth entry from the right of the X-Forwarded-For header. Set to 1 for a single reverse proxy, 2 for two chained proxies, etc.";
          };

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

        dashboardManaged = dynamicConfig.dashboardManagedOption dashboardManageableKeys;
      } // s3Options;

      config = lib.mkIf cfg.enable {
        # Require a METRICS_AUTH source: the service-discovery endpoint would
        # otherwise expose compute-node topology to anonymous callers.
        assertions = [
          {
            assertion = cfg.metricsAuth != null || cfg.metricsAuthFile != null || cfg.environmentFiles != [ ];
            message = "services.xinity-ai-dashboard: METRICS_AUTH is required. Set `metricsAuth`, `metricsAuthFile`, or provide METRICS_AUTH via `environmentFiles`.";
          }
          {
            assertion = cfg.origin != null;
            message = "services.xinity-ai-dashboard: `origin` is required. Set it to the URL users visit in their browser, scheme included (e.g. https://dashboard.example.com). The allinone module sets it for you from `domain` and `dashboardSubdomain`.";
          }
        ];

        systemd.services.xinity-ai-dashboard = {
          description = "Xinity AI Dashboard";
          wantedBy = [ "multi-user.target" ];
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          environment = dynamicConfig.delegateToDashboard cfg.dashboardManaged ({
            HTTP_PORT = toString cfg.port;
            # Never null in a config that evaluates: the assertion above rejects that first.
            ORIGIN = toString cfg.origin;
            HTTP_OVERRIDE_ORIGIN = toString cfg.origin;
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
          // lib.optionalAttrs (cfg.auditSinkUrl != null) {
            AUDIT_SINK_URL = cfg.auditSinkUrl;
          }
          // lib.optionalAttrs (cfg.auditSinkTenant != null) {
            AUDIT_SINK_TENANT = cfg.auditSinkTenant;
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
          // lib.optionalAttrs (cfg.secretKeyFile != null) {
            XINITY_SECRET_KEY_FILE = "%d/secret-key";
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
          // lib.optionalAttrs (cfg.tlsCertFile != null) {
            XINITY_TLS_CERT_FILE = "%d/tls-cert";
          }
          // lib.optionalAttrs (cfg.tlsKeyFile != null) {
            XINITY_TLS_KEY_FILE = "%d/tls-key";
          }
          // lib.optionalAttrs (cfg.reverseProxy.ipHeader != null) {
            HTTP_IP_HEADER = cfg.reverseProxy.ipHeader;
            HTTP_XFF_DEPTH = toString cfg.reverseProxy.xffDepth;
          }
          // cfg.extraEnvironment);
          serviceConfig = {
            EnvironmentFile = cfg.environmentFiles;
            ExecStart = "${cfg.package}/bin/xinity-ai-dashboard";
            Restart = "always";
            RestartSec = 5;
            RestartSteps = 10;
            RestartMaxDelaySec = 300;
          } // lib.optionalAttrs (loadCredentialEntries != [ ]) {
            LoadCredential = loadCredentialEntries;
          };
        };
      };
    };
}
