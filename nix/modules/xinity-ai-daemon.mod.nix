{ withSystem, self, inputs, ... }: {
  flake.nixosModules.daemon = { config, lib, pkgs, ... }:
    let
      withHostSystem = withSystem pkgs.stdenv.hostPlatform.system;
      cfg = config.services.xinity-ai-daemon;
      cfgOllama = config.services.ollama;
    in {

      imports = [
        (lib.mkRenamedOptionModule
          [ "services" "xinity-ai-daemon" "envFiles" ]
          [ "services" "xinity-ai-daemon" "environmentFiles" ])
        (lib.mkRemovedOptionModule
          [ "services" "xinity-ai-daemon" "dbConnectionUrl" ]
          "The daemon no longer connects to the database. Use tetherUrl and tetherSecretFile instead.")
        (lib.mkRemovedOptionModule
          [ "services" "xinity-ai-daemon" "dbConnectionUrlFile" ]
          "The daemon no longer connects to the database. Use tetherUrl and tetherSecretFile instead.")
      ];

      options.services.xinity-ai-daemon = {
        enable = lib.mkEnableOption "the xinity-ai daemon, a systemd service that manages local inference backends (Ollama, vLLM), registers the node with the gateway, and handles model lifecycle operations";
        package = lib.mkOption {
          type = lib.types.package;

          default = withHostSystem
            ({ config, ... }: config.packages.xinity-ai-daemon);
          description = "The xinity-ai-daemon package to use. Defaults to the package built from this flake for the current platform.";
        };
        environmentFiles = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          description = ''
            systemd EnvironmentFile paths loaded at service start for sensitive values.
            Secrets in environment files are not exposed in the Nix store.
          '';
          default = [ ];
        };

        tetherUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "URL of the xinity-tether service (e.g. http://localhost:4020). The daemon connects to the tether for desired-state streaming and status reporting.";
        };

        tetherSecretFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the shared secret for tether authentication. Loaded via systemd's LoadCredential mechanism.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          description = "HTTP port the daemon API listens on. The gateway connects to this port to forward inference requests and manage models.";
          default = 4044;
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
          default = 600000;
          description = "How long the local catalog snapshot is trusted before the daemon re-validates it. A revalidation costs one 304 when nothing changed; this sets how stale a newly published model entry can be.";
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

        # --- Metrics ---

        metricsAuthFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the metrics auth credentials, as comma-separated user:pass pairs. Prometheus must present one of these pairs when scraping the daemon's /metrics endpoint. Loaded via systemd's LoadCredential mechanism.";
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
          after = [ "network-online.target" ];
          wants = [ "network-online.target" ];
          # generell system paths instead of specific binaries to allow dynamic tooling resolution. i.e. nvidia-smi generelly gets auto added to this when installing the drivers
          path = [ "/run/current-system/sw" ];
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
          // lib.optionalAttrs (cfg.tetherUrl != null) {
            TETHER_URL = cfg.tetherUrl;
          }
          // lib.optionalAttrs (cfg.tetherSecretFile != null) {
            TETHER_SECRET_FILE = "%d/tether-secret";
          }
          // lib.optionalAttrs (cfg.ollamaEndpoint != null) {
            XINITY_OLLAMA_ENDPOINT = cfg.ollamaEndpoint;
          }
          // lib.optionalAttrs (cfg.ollamaEndpoint == null && cfgOllama.enable or false) {
            XINITY_OLLAMA_ENDPOINT =
              "http://${cfgOllama.host}:${toString cfgOllama.port}";
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
          // lib.optionalAttrs (cfg.metricsAuthFile != null) {
            METRICS_AUTH_FILE = "%d/metrics-auth";
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
          serviceConfig = let
            loadCredentialEntries =
              lib.optional (cfg.tetherSecretFile != null) "tether-secret:${cfg.tetherSecretFile}"
              ++ lib.optional (cfg.metricsAuthFile != null) "metrics-auth:${cfg.metricsAuthFile}"
              ++ lib.optional (cfg.tlsCertFile != null) "tls-cert:${cfg.tlsCertFile}"
              ++ lib.optional (cfg.tlsKeyFile != null) "tls-key:${cfg.tlsKeyFile}";
          in {
            EnvironmentFile = cfg.environmentFiles;
            ExecStart = "${cfg.package}/bin/xinity-ai-daemon";
            Restart = "always";
            StateDirectory = "xinity-ai-daemon";
          } // lib.optionalAttrs (loadCredentialEntries != [ ]) {
            LoadCredential = loadCredentialEntries;
          };
        };
      };
    };

  flake.nixosConfigurations.container = inputs.nixpkgs.lib.nixosSystem {
    system = "x86_64-linux";
    modules = [
      self.nixosModules.daemon
      {
        services.xinity-ai-daemon.enable = true;
        services.xinity-ai-daemon.environmentFiles = [ "/etc/.env" ];
        environment.etc.".env".text = ''
          SECRET_TOKEN=set
        '';
        boot.isContainer = true;
        system.stateVersion = "25.05";
      }
    ];
  };
}
