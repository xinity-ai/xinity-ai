{ withSystem, self, inputs, ... }: {
  flake.nixosModules.default = self.nixosModules.server;
  flake.nixosModules.server = { config, lib, pkgs, ... }:
    let
      withHostSystem = withSystem pkgs.stdenv.hostPlatform.system;
      cfg = config.services.xinity-ai-daemon;
      cfgOllama = config.services.ollama;
    in {

      options.services.xinity-ai-daemon = {
        enable = lib.mkEnableOption "the xinity-ai daemon, a systemd service that manages local inference backends (Ollama, vLLM), registers the node with the gateway, and handles model lifecycle operations";
        package = lib.mkOption {
          type = lib.types.package;

          default = withHostSystem
            ({ config, ... }: config.packages.xinity-ai-daemon);
          description = "The xinity-ai-daemon package to use. Defaults to the package built from this flake for the current platform.";
        };
        envFiles = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          description = "List of systemd EnvironmentFile paths loaded at service start. This is the recommended way to inject secrets like DB_CONNECTION_URL without exposing them in the Nix store.";
          default = [ ];
        };

        dbConnectionUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            PostgreSQL connection URL.
            WARNING: DO NOT USE IN PRODUCTION. Use envFiles or dbConnectionUrlFile instead to keep credentials secure.
            This option exposes secrets in the Nix store.
          '';
        };

        dbConnectionUrlFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the PostgreSQL connection URL. The file is loaded via systemd's LoadCredential mechanism and exposed to the daemon as DB_CONNECTION_URL_FILE. This is more secure than dbConnectionUrl as the secret never enters the Nix store.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          description = "HTTP port the daemon API listens on. The gateway connects to this port to forward inference requests and manage models.";
          default = 4010;
        };

        host = lib.mkOption {
          type = lib.types.str;
          default = "0.0.0.0";
          description = "Host address the daemon binds to. Use 0.0.0.0 to accept connections on all interfaces, or 127.0.0.1 to restrict to localhost.";
        };

        infoserverUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "URL of the xinity-infoserver instance. The daemon uses this to fetch model definitions and report its own status.";
        };

        infoserverCacheTtlMs = lib.mkOption {
          type = lib.types.int;
          default = 30000;
          description = "Duration in milliseconds to cache responses from the infoserver locally. Reduces repeated network calls when the daemon checks model definitions.";
        };

        stateDir = lib.mkOption {
          type = lib.types.str;
          default = "/var/lib/xinity-ai-daemon";
          description = "Directory where the daemon persists local state such as model installation status and runtime metadata. Created automatically via systemd StateDirectory.";
        };

        cidrPrefix = lib.mkOption {
          type = lib.types.str;
          default = "";
          description = "Network CIDR prefix used to determine the daemon's advertised IP address when registering with the gateway. The daemon selects the first local address matching this prefix. Leave empty to use the default route address.";
        };

        syncIntervalMs = lib.mkOption {
          type = lib.types.int;
          default = 300000;
          description = "Interval in milliseconds between sync cycles. During each cycle the daemon re-registers with the gateway, reports GPU/model health, and reconciles desired model state.";
        };

        # --- Ollama settings ---

        ollamaEndpoint = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Ollama API endpoint URL (e.g. http://127.0.0.1:11434). Setting this enables the Ollama inference driver. If left null and the NixOS services.ollama module is enabled, the endpoint is derived automatically from its host and port settings.";
        };

        # --- vLLM settings ---

        vllmBackend = lib.mkOption {
          type = lib.types.enum [ "systemd" "docker" ];
          default = "systemd";
          description = ''
            How vLLM instances are managed. "systemd" launches vLLM as systemd template units (requires vllmPath). "docker" runs vLLM in OCI containers (requires vllmDockerImage).
          '';
        };

        vllmEnvDir = lib.mkOption {
          type = lib.types.str;
          default = "/etc/vllm";
          description = "Directory containing per-model environment files for vLLM. Each file is named after the model and contains environment variable overrides (e.g. GPU_MEMORY_UTILIZATION, TENSOR_PARALLEL_SIZE).";
        };

        vllmTemplateUnitPath = lib.mkOption {
          type = lib.types.str;
          default = "/etc/systemd/system/vllm-driver@.service";
          description = "Path to the vLLM systemd template unit file (vllm-driver@.service). The daemon instantiates this template for each model it manages.";
        };

        vllmPath = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Absolute path to the vllm binary. Setting this enables the vllm-systemd driver. Required when vllmBackend is set to \"systemd\".";
        };

        vllmDockerImage = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "OCI image reference for vLLM (e.g. vllm/vllm-openai:latest). Setting this enables the vllm-docker driver. Required when vllmBackend is set to \"docker\".";
        };

        vllmHfCacheDir = lib.mkOption {
          type = lib.types.str;
          default = "/var/lib/vllm/hf-cache";
          description = "Directory where vLLM caches downloaded HuggingFace model weights. Shared across all vLLM instances to avoid redundant downloads.";
        };

        vllmTritonCacheDir = lib.mkOption {
          type = lib.types.str;
          default = "/var/lib/vllm/triton-cache";
          description = "Directory where vLLM stores compiled Triton GPU kernels. Persisting this cache avoids recompilation on service restarts.";
        };

        vllmHealthTimeoutMs = lib.mkOption {
          type = lib.types.int;
          default = 3600000;
          description = "Maximum time in milliseconds to wait for a newly started vLLM instance to become healthy. Large models on slow storage may need a higher value as weight loading can take significant time.";
        };

        vllmHealthPollIntervalMs = lib.mkOption {
          type = lib.types.int;
          default = 5000;
          description = "Interval in milliseconds between health check polls while waiting for a vLLM instance to become ready.";
        };

        vllmMaxRestartCount = lib.mkOption {
          type = lib.types.int;
          default = 3;
          description = "Maximum number of times a vLLM container is restarted after a crash before the daemon marks the model installation as permanently failed and stops retrying.";
        };

        # --- TLS ---

        tlsCertFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the PEM-encoded TLS certificate. Enables HTTPS on the daemon.";
        };

        tlsKeyFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the PEM-encoded TLS private key.";
        };

        # --- Logging ---

        logLevel = lib.mkOption {
          type = lib.types.enum [ "fatal" "error" "warn" "info" "debug" "trace" ];
          default = "info";
          description = "Pino log level. Controls the verbosity of structured JSON logs emitted by the daemon.";
        };

        logDir = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Directory for persistent log files. When set, the daemon writes structured JSON logs to this directory in addition to stdout/journald. If null, only stdout logging is used.";
        };

        extraEnvironment = lib.mkOption {
          type = lib.types.attrsOf lib.types.str;
          default = { };
          description = "Additional environment variables passed to the systemd service. Use this for driver-specific tuning or feature flags not covered by dedicated options.";
        };
      };

      config = lib.mkIf cfg.enable {
        systemd.services.xinity-ai-daemon = {
          description = "Xinity AI Daemon";
          wantedBy = [ "multi-user.target" ];
          environment = {
            PORT = toString cfg.port;
            HOST = cfg.host;
            STATE_DIR = cfg.stateDir;
            CIDR_PREFIX = cfg.cidrPrefix;
            SYNC_INTERVAL_MS = toString cfg.syncIntervalMs;
            INFOSERVER_CACHE_TTL_MS = toString cfg.infoserverCacheTtlMs;
            VLLM_BACKEND = cfg.vllmBackend;
            VLLM_ENV_DIR = cfg.vllmEnvDir;
            VLLM_TEMPLATE_UNIT_PATH = cfg.vllmTemplateUnitPath;
            VLLM_HF_CACHE_DIR = cfg.vllmHfCacheDir;
            VLLM_TRITON_CACHE_DIR = cfg.vllmTritonCacheDir;
            VLLM_HEALTH_TIMEOUT_MS = toString cfg.vllmHealthTimeoutMs;
            VLLM_HEALTH_POLL_INTERVAL_MS = toString cfg.vllmHealthPollIntervalMs;
            VLLM_MAX_RESTART_COUNT = toString cfg.vllmMaxRestartCount;
            LOG_LEVEL = cfg.logLevel;
          }
          // lib.optionalAttrs (cfg.dbConnectionUrl != null) {
            DB_CONNECTION_URL = cfg.dbConnectionUrl;
          }
          // lib.optionalAttrs (cfg.dbConnectionUrlFile != null) {
            DB_CONNECTION_URL_FILE = "%d/db-connection-url";
          }
          // lib.optionalAttrs (cfg.ollamaEndpoint != null) {
            XINITY_OLLAMA_ENDPOINT = cfg.ollamaEndpoint;
          }
          // lib.optionalAttrs (cfg.ollamaEndpoint == null && cfgOllama.enable or false) {
            XINITY_OLLAMA_ENDPOINT =
              "${cfgOllama.host}:${toString cfgOllama.port}";
          }
          // lib.optionalAttrs (cfg.infoserverUrl != null) {
            INFOSERVER_URL = cfg.infoserverUrl;
          }
          // lib.optionalAttrs (cfg.vllmPath != null) {
            VLLM_PATH = cfg.vllmPath;
          }
          // lib.optionalAttrs (cfg.vllmDockerImage != null) {
            VLLM_DOCKER_IMAGE = cfg.vllmDockerImage;
          }
          // lib.optionalAttrs (cfg.logDir != null) {
            LOG_DIR = cfg.logDir;
          }
          // lib.optionalAttrs (cfg.tlsCertFile != null) {
            XINITY_TLS_CERT_FILE = "%d/tls-cert";
          }
          // lib.optionalAttrs (cfg.tlsKeyFile != null) {
            XINITY_TLS_KEY_FILE = "%d/tls-key";
          }
          // cfg.extraEnvironment;
          serviceConfig = {
            EnvironmentFile = cfg.envFiles;
            ExecStart = "${cfg.package}/bin/xinity-ai-daemon";
            Restart = "always";
            StateDirectory = "xinity-ai-daemon";
          } // lib.optionalAttrs (cfg.dbConnectionUrlFile != null || cfg.tlsCertFile != null || cfg.tlsKeyFile != null) {
            LoadCredential =
              lib.optional (cfg.dbConnectionUrlFile != null) "db-connection-url:${cfg.dbConnectionUrlFile}"
              ++ lib.optional (cfg.tlsCertFile != null) "tls-cert:${cfg.tlsCertFile}"
              ++ lib.optional (cfg.tlsKeyFile != null) "tls-key:${cfg.tlsKeyFile}";
          };
        };
      };
    };

  flake.nixosConfigurations.container = inputs.nixpkgs.lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      self.nixosModules.server
      {
        services.xinity-ai-daemon.enable = true;
        services.xinity-ai-daemon.envFiles = [ "/etc/.env" ];
        environment.etc.".env".text = ''
          SECRET_TOKEN=set
        '';
        boot.isContainer = true;
        system.stateVersion = "25.05";
      }
    ];
  };
}
