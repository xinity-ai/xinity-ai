{ withSystem, ... }: {
  flake.nixosModules.gateway = { config, lib, pkgs, ... }:
    let
      withHostSystem = withSystem pkgs.stdenv.hostPlatform.system;
      cfg = config.services.xinity-ai-gateway;
      s3Options = import ./lib/s3-options.nix { inherit lib; };
      dynamicConfig = import ./lib/dynamic-config.nix { inherit lib; };

      # [sync:dynamic-keys] - generated from the config declaration, do not edit
      dashboardManageableKeys = [
        "RESPONSE_CACHE_TTL_SECONDS"
        "CACHE_APPLICATION_TTL_SECONDS"
        "CACHE_API_KEY_TTL_SECONDS"
        "CACHE_AUTH_FAILURE_TTL_SECONDS"
        "CACHE_MODEL_TTL_SECONDS"
        "CACHE_DIGEST_MAX_ENTRIES"
        "WEB_SEARCH_PROVIDER"
        "WEB_SEARCH_CREDENTIAL"
        "LOAD_BALANCE_STRATEGY"
        "BACKEND_TIMEOUT_MS"
      ];
      # [/sync:dynamic-keys]

      removed = path: message:
        lib.mkRemovedOptionModule
          ([ "services" "xinity-ai-gateway" ] ++ path)
          message;

      renamed = from: to:
        lib.mkRenamedOptionModule
          ([ "services" "xinity-ai-gateway" ] ++ from)
          ([ "services" "xinity-ai-gateway" ] ++ to);

      loadCredentialEntries =
        lib.optional (cfg.dbConnectionUrlFile != null) "db-connection-url:${cfg.dbConnectionUrlFile}"
        ++ lib.optional (cfg.redisUrlFile != null) "redis-url:${cfg.redisUrlFile}"
        ++ lib.optional (cfg.metricsAuthFile != null) "metrics-auth:${cfg.metricsAuthFile}"
        ++ lib.optional (cfg.secretKeyFile != null) "secret-key:${cfg.secretKeyFile}"
        ++ lib.optional (cfg.webSearchCredentialFile != null) "web-search-credential:${cfg.webSearchCredentialFile}"
        ++ lib.optional (cfg.s3AccessKeyIdFile != null) "s3-access-key-id:${cfg.s3AccessKeyIdFile}"
        ++ lib.optional (cfg.s3SecretAccessKeyFile != null) "s3-secret-access-key:${cfg.s3SecretAccessKeyFile}"
        ++ lib.optional (cfg.tlsCertFile != null) "tls-cert:${cfg.tlsCertFile}"
        ++ lib.optional (cfg.tlsKeyFile != null) "tls-key:${cfg.tlsKeyFile}"
        ++ lib.optional (cfg.inferenceCaFile != null) "inference-ca:${cfg.inferenceCaFile}";
    in {
      imports = [
        (removed [ "image" ]
          "The gateway now runs as a native systemd service backed by `services.xinity-ai-gateway.package`, not an OCI container. Remove this option from your configuration.")
        (removed [ "containerUid" ]
          "The gateway now runs as a native systemd service, not an OCI container. Remove this option from your configuration.")
        (removed [ "extraOptions" ]
          "OCI container runtime arguments don't apply to the systemd service the gateway now runs as. Remove this option from your configuration.")
        (renamed [ "webSearchEngineUrl" ] [ "webSearchCredential" ])
      ];

      options.services.xinity-ai-gateway = {
        enable = lib.mkEnableOption "the xinity-ai gateway, an OpenAI-compatible API proxy that handles authentication, rate limiting, load balancing, and request routing across inference nodes";

        package = lib.mkOption {
          type = lib.types.package;
          default = withHostSystem ({ config, ... }: config.packages.xinity-ai-gateway);
          description = "The xinity-ai-gateway package to use. Defaults to the prebuilt release binary for the current platform.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 4121;
          description = "HTTP port the gateway listens on. This is the port clients send OpenAI-compatible API requests to.";
        };

        host = lib.mkOption {
          type = lib.types.str;
          default = "0.0.0.0";
          description = "Host address the gateway binds to. Use 0.0.0.0 to accept connections on all interfaces, or 127.0.0.1 to restrict to localhost.";
        };

        dbConnectionUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            PostgreSQL connection URL.
            WARNING: DO NOT USE IN PRODUCTION. Set DB_CONNECTION_URL through environmentFiles, or use dbConnectionUrlFile, to keep credentials secure.
            This option exposes secrets in the Nix store.
          '';
        };

        redisUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            Redis connection URL.
            WARNING: DO NOT USE IN PRODUCTION. Set REDIS_URL through environmentFiles, or use redisUrlFile, to keep credentials secure.
            This option exposes secrets in the Nix store.
          '';
        };

        webSearchProvider = lib.mkOption {
          type = lib.types.enum [ "searxng" "google" "bing" "brave" "serper" "tavily" ];
          default = "searxng";
          description = "Web search backend the gateway queries. Only takes effect once a credential is set.";
        };

        webSearchCredential = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            Credential for webSearchProvider, which enables web-search-augmented generation when set.
            searxng takes the instance URL, google takes apikey:cx, the others take an API key.
            WARNING: DO NOT USE IN PRODUCTION for anything but a SearXNG URL. Use webSearchCredentialFile
            for API keys, which this option would expose in the Nix store.
          '';
        };

        responseCacheTtlSeconds = lib.mkOption {
          type = lib.types.int;
          default = 3600;
          description = "Time-to-live in seconds for cached LLM responses. Identical requests within this window are served from cache without hitting the inference backend. Set to 0 to disable caching.";
        };

        infoserverUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Internal URL of the xinity-infoserver instance. The gateway queries this to discover available models and their routing information.";
        };

        infoserverCacheTtlMs = lib.mkOption {
          type = lib.types.int;
          default = 600000;
          description = "How long the local catalog snapshot is trusted before the gateway re-validates it. A revalidation costs one 304 when nothing changed; this sets how stale a newly published model entry can be.";
        };

        loadBalanceStrategy = lib.mkOption {
          type = lib.types.enum [ "random" "round-robin" "least-connections" ];
          default = "least-connections";
          description = ''
            Strategy used to distribute requests across inference nodes.
            - "random": pick a random healthy node for each request.
            - "round-robin": cycle through healthy nodes in order.
            - "least-connections": route to the node with the fewest active requests (recommended for heterogeneous hardware).
          '';
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

        logLevel = lib.mkOption {
          type = lib.types.enum [ "fatal" "error" "warn" "info" "debug" "trace" ];
          default = "info";
          description = "Pino log level. Controls the verbosity of structured JSON logs emitted by the gateway.";
        };

        logDir = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Directory for log files. If null, only stdout/journald logging is used.";
        };

        backendTimeoutMs = lib.mkOption {
          type = lib.types.int;
          default = 300000;
          description = "Maximum time in milliseconds to wait for an inference backend to respond before the gateway returns a timeout error to the client. Increase this for models with long generation times.";
        };


        tlsCertFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the PEM-encoded TLS certificate. Loaded via systemd LoadCredential and exposed as XINITY_TLS_CERT_FILE. Enables HTTPS on the gateway.";
        };

        tlsKeyFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the PEM-encoded TLS private key.";
        };

        inferenceCaFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a PEM-encoded CA certificate file used to verify TLS connections to inference daemons. Required when daemons use self-signed certificates.";
        };

        # --- Secret file options (recommended for production) ---
        # These use the _FILE env var pattern: the app reads the secret from the file at runtime.
        # Files are loaded via systemd's LoadCredential mechanism and exposed under %d/.

        dbConnectionUrlFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the PostgreSQL connection URL.";
        };

        redisUrlFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the Redis connection URL.";
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
            `openssl rand -base64 32`. It decrypts dashboard-managed secrets, so every host
            that sets or reads one needs the same value. Required: the service refuses to start without it, here or through
            environmentFiles.

            During a key rotation, supply XINITY_SECRET_KEY_PREVIOUS through environmentFiles.
          '';
        };

        webSearchCredentialFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the credential for webSearchProvider.";
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

        environmentFiles = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = ''
            systemd EnvironmentFile paths loaded at service start for sensitive values
            (DB_CONNECTION_URL, REDIS_URL, etc.). This is the RECOMMENDED and SECURE
            way to provide credentials.
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
        # Nix cannot look inside an environment file, so that is taken as provision enough.
        assertions = [
          {
            assertion = cfg.secretKeyFile != null || cfg.environmentFiles != [ ];
            message = ''
              services.xinity-ai-gateway: XINITY_SECRET_KEY is required. It decrypts
              dashboard-managed secrets, so it must hold the same value as the dashboard that
              sealed them and cannot be created here. Set `secretKeyFile`, or provide
              XINITY_SECRET_KEY through `environmentFiles`.
            '';
          }
        ];

        systemd.services.xinity-ai-gateway = {
          description = "Xinity AI Gateway";
          wantedBy = [ "multi-user.target" ];
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          environment = dynamicConfig.delegateToDashboard cfg.dashboardManaged ({
            HOST = cfg.host;
            PORT = toString cfg.port;
            RESPONSE_CACHE_TTL_SECONDS = toString cfg.responseCacheTtlSeconds;
            INFOSERVER_CACHE_TTL_MS = toString cfg.infoserverCacheTtlMs;
            LOAD_BALANCE_STRATEGY = cfg.loadBalanceStrategy;
            BACKEND_TIMEOUT_MS = toString cfg.backendTimeoutMs;
            LOG_LEVEL = cfg.logLevel;
            S3_BUCKET = cfg.s3Bucket;
            S3_REGION = cfg.s3Region;
          }
          // lib.optionalAttrs (cfg.dbConnectionUrl != null) {
            DB_CONNECTION_URL = cfg.dbConnectionUrl;
          }
          // lib.optionalAttrs (cfg.redisUrl != null) {
            REDIS_URL = cfg.redisUrl;
          }
          // lib.optionalAttrs (cfg.webSearchCredential != null || cfg.webSearchCredentialFile != null) {
            WEB_SEARCH_PROVIDER = cfg.webSearchProvider;
          }
          // lib.optionalAttrs (cfg.webSearchCredential != null) {
            WEB_SEARCH_CREDENTIAL = cfg.webSearchCredential;
          }
          // lib.optionalAttrs (cfg.infoserverUrl != null) {
            INFOSERVER_URL = cfg.infoserverUrl;
          }
          // lib.optionalAttrs (cfg.metricsAuth != null) {
            METRICS_AUTH = cfg.metricsAuth;
          }
          // lib.optionalAttrs (cfg.logDir != null) {
            LOG_DIR = cfg.logDir;
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
          // lib.optionalAttrs (cfg.tlsCertFile != null) {
            XINITY_TLS_CERT_FILE = "%d/tls-cert";
          }
          // lib.optionalAttrs (cfg.tlsKeyFile != null) {
            XINITY_TLS_KEY_FILE = "%d/tls-key";
          }
          // lib.optionalAttrs (cfg.inferenceCaFile != null) {
            XINITY_INFERENCE_CA_FILE = "%d/inference-ca";
          }
          // lib.optionalAttrs (cfg.dbConnectionUrlFile != null) {
            DB_CONNECTION_URL_FILE = "%d/db-connection-url";
          }
          // lib.optionalAttrs (cfg.redisUrlFile != null) {
            REDIS_URL_FILE = "%d/redis-url";
          }
          // lib.optionalAttrs (cfg.metricsAuthFile != null) {
            METRICS_AUTH_FILE = "%d/metrics-auth";
          }
          // lib.optionalAttrs (cfg.secretKeyFile != null) {
            XINITY_SECRET_KEY_FILE = "%d/secret-key";
          }
          // lib.optionalAttrs (cfg.webSearchCredentialFile != null) {
            WEB_SEARCH_CREDENTIAL_FILE = "%d/web-search-credential";
          }
          // lib.optionalAttrs (cfg.s3AccessKeyIdFile != null) {
            S3_ACCESS_KEY_ID_FILE = "%d/s3-access-key-id";
          }
          // lib.optionalAttrs (cfg.s3SecretAccessKeyFile != null) {
            S3_SECRET_ACCESS_KEY_FILE = "%d/s3-secret-access-key";
          }
          // cfg.extraEnvironment);
          serviceConfig = {
            EnvironmentFile = cfg.environmentFiles;
            ExecStart = "${cfg.package}/bin/xinity-ai-gateway";
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
