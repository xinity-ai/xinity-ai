{ self, ... }:
let
  version = (builtins.fromJSON (builtins.readFile "${self}/package.json")).version;
in {
  flake.nixosModules.gateway = { config, lib, ... }:
    let
      cfg = config.services.xinity-ai-gateway;
    in {
      options.services.xinity-ai-gateway = {
        enable = lib.mkEnableOption "xinity-ai-gateway OCI container";

        image = lib.mkOption {
          type = lib.types.str;
          default = "ghcr.io/xinity-ai/xinity-ai-gateway:${version}";
          description = "OCI image for the gateway.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 4121;
          description = "Port the gateway listens on.";
        };

        host = lib.mkOption {
          type = lib.types.str;
          default = "0.0.0.0";
          description = "Host address the gateway binds to.";
        };

        dbConnectionUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            PostgreSQL connection URL.
            WARNING: DO NOT USE IN PRODUCTION. Use environmentFiles instead to keep credentials secure.
            This option exposes secrets in the Nix store.
          '';
        };

        redisUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            Redis connection URL.
            WARNING: DO NOT USE IN PRODUCTION. Use environmentFiles instead to keep credentials secure.
            This option exposes secrets in the Nix store.
          '';
        };

        webSearchEngineUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "URL to a web search engine (e.g. SearXNG).";
        };

        responseCacheTtlSeconds = lib.mkOption {
          type = lib.types.int;
          default = 3600;
          description = "TTL in seconds for response caching.";
        };

        infoserverUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "URL of the xinity-infoserver instance.";
        };

        infoserverCacheTtlMs = lib.mkOption {
          type = lib.types.int;
          default = 30000;
          description = "How long to cache infoserver responses locally (ms).";
        };

        loadBalanceStrategy = lib.mkOption {
          type = lib.types.enum [ "random" "round-robin" "least-connections" ];
          default = "least-connections";
          description = "Load balancing strategy for inference nodes.";
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

        backendTimeoutMs = lib.mkOption {
          type = lib.types.int;
          default = 300000;
          description = "Maximum time in ms to wait for a backend response.";
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

        # --- Secret file options (recommended for production) ---
        # These use the _FILE env var pattern: the app reads the secret from the file at runtime.
        # Files are mounted read-only into the container at /run/secrets/*.

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
            Environment files for sensitive values (DB_CONNECTION_URL, REDIS_URL, etc.).
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
          description = "UID (and GID) the container process runs as. Secret files passed via *File options must be readable by this UID.";
        };

        extraOptions = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ "--network=host" ];
          description = "Extra options to pass to the container runtime.";
        };
      };

      config = lib.mkIf cfg.enable {
        virtualisation.oci-containers.containers.xinity-ai-gateway = {
          image = cfg.image;
          ports = [ "${toString cfg.port}:${toString cfg.port}" ];
          environment = {
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
          // lib.optionalAttrs (cfg.webSearchEngineUrl != null) {
            WEB_SEARCH_ENGINE_URL = cfg.webSearchEngineUrl;
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
          # --- Secret file env vars (_FILE pattern) ---
          // lib.optionalAttrs (cfg.dbConnectionUrlFile != null) {
            DB_CONNECTION_URL_FILE = "/run/secrets/db-connection-url";
          }
          // lib.optionalAttrs (cfg.redisUrlFile != null) {
            REDIS_URL_FILE = "/run/secrets/redis-url";
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
          // cfg.extraEnvironment;
          environmentFiles = cfg.environmentFiles;
          volumes =
            lib.optional (cfg.dbConnectionUrlFile != null) "${cfg.dbConnectionUrlFile}:/run/secrets/db-connection-url:ro"
            ++ lib.optional (cfg.redisUrlFile != null) "${cfg.redisUrlFile}:/run/secrets/redis-url:ro"
            ++ lib.optional (cfg.metricsAuthFile != null) "${cfg.metricsAuthFile}:/run/secrets/metrics-auth:ro"
            ++ lib.optional (cfg.s3AccessKeyIdFile != null) "${cfg.s3AccessKeyIdFile}:/run/secrets/s3-access-key-id:ro"
            ++ lib.optional (cfg.s3SecretAccessKeyFile != null) "${cfg.s3SecretAccessKeyFile}:/run/secrets/s3-secret-access-key:ro";
          extraOptions = [ "--user=${toString cfg.containerUid}:${toString cfg.containerUid}" ] ++ cfg.extraOptions;
        };
      };
    };
}
