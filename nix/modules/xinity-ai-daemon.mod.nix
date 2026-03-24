{ withSystem, self, inputs, ... }: {
  flake.nixosModules.default = self.nixosModules.server;
  flake.nixosModules.server = { config, lib, pkgs, ... }:
    let
      withHostSystem = withSystem pkgs.stdenv.hostPlatform.system;
      cfg = config.services.xinity-ai-daemon;
      cfgOllama = config.services.ollama;
    in {

      options.services.xinity-ai-daemon = {
        enable = lib.mkEnableOption "Enable xinity-ai-daemon service";
        package = lib.mkOption {
          type = lib.types.package;

          default = withHostSystem
            ({ config, ... }: config.packages.xinity-ai-daemon);
          description = "The package providing the service derivation.";
        };
        envFiles = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          description = "Environment files for xinity-ai-daemon (e.g. for DB_CONNECTION_URL).";
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
          description = "Path to a file containing the PostgreSQL connection URL. Uses systemd LoadCredential for secure access.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          description = "Port for xinity-ai-daemon.";
          default = 4010;
        };

        host = lib.mkOption {
          type = lib.types.str;
          default = "0.0.0.0";
          description = "Host address the daemon binds to.";
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

        stateDir = lib.mkOption {
          type = lib.types.str;
          default = "/var/lib/xinity-ai-daemon";
          description = "Local state directory for the daemon.";
        };

        cidrPrefix = lib.mkOption {
          type = lib.types.str;
          default = "";
          description = "Network CIDR prefix.";
        };

        syncIntervalMs = lib.mkOption {
          type = lib.types.int;
          default = 300000;
          description = "Sync interval in milliseconds.";
        };

        # --- Ollama settings ---

        ollamaEndpoint = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Ollama API endpoint (enables ollama driver). If null and services.ollama is enabled, derived automatically.";
        };

        # --- vLLM settings ---

        vllmBackend = lib.mkOption {
          type = lib.types.enum [ "systemd" "docker" ];
          default = "systemd";
          description = "vLLM backend type.";
        };

        vllmEnvDir = lib.mkOption {
          type = lib.types.str;
          default = "/etc/vllm";
          description = "vLLM environment config directory.";
        };

        vllmTemplateUnitPath = lib.mkOption {
          type = lib.types.str;
          default = "/etc/systemd/system/vllm-driver@.service";
          description = "vLLM systemd template unit path.";
        };

        vllmPath = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to vllm binary (enables vllm-systemd driver).";
        };

        vllmDockerImage = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "vLLM Docker image (enables vllm-docker driver).";
        };

        vllmHfCacheDir = lib.mkOption {
          type = lib.types.str;
          default = "/var/lib/vllm/hf-cache";
          description = "HuggingFace cache directory for vLLM.";
        };

        vllmTritonCacheDir = lib.mkOption {
          type = lib.types.str;
          default = "/var/lib/vllm/triton-cache";
          description = "Triton cache directory for vLLM.";
        };

        vllmHealthTimeoutMs = lib.mkOption {
          type = lib.types.int;
          default = 3600000;
          description = "vLLM health check timeout in milliseconds.";
        };

        vllmHealthPollIntervalMs = lib.mkOption {
          type = lib.types.int;
          default = 5000;
          description = "vLLM health check poll interval in milliseconds.";
        };

        vllmMaxRestartCount = lib.mkOption {
          type = lib.types.int;
          default = 3;
          description = "Max container restarts before marking installation as permanently failed.";
        };

        # --- Logging ---

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

        extraEnvironment = lib.mkOption {
          type = lib.types.attrsOf lib.types.str;
          default = { };
          description = "Additional environment variables to pass to the service.";
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
          // cfg.extraEnvironment;
          serviceConfig = {
            EnvironmentFile = cfg.envFiles;
            ExecStart = "${cfg.package}/bin/xinity-ai-daemon";
            Restart = "always";
            StateDirectory = "xinity-ai-daemon";
          } // lib.optionalAttrs (cfg.dbConnectionUrlFile != null) {
            LoadCredential = [ "db-connection-url:${cfg.dbConnectionUrlFile}" ];
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
