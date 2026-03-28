{ self, ... }: {

  # ── Caddy Reverse Proxy Module ────────────────────────────────────────
  flake.nixosModules.caddy = { config, lib, ... }:
    let
      cfg = config.services.xinity-ai-caddy;

      dashboardTarget =
        if cfg.dashboardOrigin != null then cfg.dashboardOrigin
        else "localhost:${toString config.services.xinity-ai-dashboard.port}";

      gatewayTarget =
        if cfg.gatewayOrigin != null then cfg.gatewayOrigin
        else "localhost:${toString config.services.xinity-ai-gateway.port}";

      infoserverTarget =
        if cfg.infoserverOrigin != null then cfg.infoserverOrigin
        else "localhost:${toString config.services.xinity-infoserver.port}";
    in {
      options.services.xinity-ai-caddy = {
        enable = lib.mkEnableOption "Caddy reverse proxy for xinity-ai services";

        domain = lib.mkOption {
          type = lib.types.str;
          description = "Base domain (e.g. example.com). Subdomains are derived from this.";
        };

        acmeEmail = lib.mkOption {
          type = lib.types.str;
          description = "Email address for ACME / Let's Encrypt certificate registration.";
        };

        dashboardSubdomain = lib.mkOption {
          type = lib.types.str;
          default = "dashboard";
          description = "Subdomain prefix for the dashboard (e.g. dashboard.example.com).";
        };

        gatewaySubdomain = lib.mkOption {
          type = lib.types.str;
          default = "api";
          description = "Subdomain prefix for the gateway (e.g. api.example.com).";
        };

        infoserverSubdomain = lib.mkOption {
          type = lib.types.str;
          default = "models";
          description = "Subdomain prefix for the infoserver (e.g. models.example.com).";
        };

        dashboardOrigin = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            Upstream origin for the dashboard (e.g. "http://10.0.0.5:5121" or "localhost:5121").
            If null, defaults to localhost:<port> using the resolved xinity-ai-dashboard module config.
          '';
        };

        gatewayOrigin = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            Upstream origin for the gateway (e.g. "http://10.0.0.5:4121" or "localhost:4121").
            If null, defaults to localhost:<port> using the resolved xinity-ai-gateway module config.
          '';
        };

        infoserverOrigin = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            Upstream origin for the infoserver (e.g. "http://10.0.0.5:8090" or "localhost:8090").
            If null, defaults to localhost:<port> using the resolved xinity-infoserver module config.
          '';
        };
      };

      config = lib.mkIf cfg.enable {
        services.caddy = {
          enable = true;
          globalConfig = ''
            email ${cfg.acmeEmail}
          '';
          virtualHosts."${cfg.dashboardSubdomain}.${cfg.domain}" = {
            extraConfig = ''
              reverse_proxy ${dashboardTarget}
            '';
          };
          virtualHosts."${cfg.gatewaySubdomain}.${cfg.domain}" = {
            extraConfig = ''
              reverse_proxy ${gatewayTarget}
            '';
          };
          virtualHosts."${cfg.infoserverSubdomain}.${cfg.domain}" = {
            extraConfig = ''
              reverse_proxy ${infoserverTarget}
            '';
          };
        };

        networking.firewall.allowedTCPPorts = [ 80 443 ];
      };
    };

  # ── SearXNG Search Engine Module ────────────────────────────────────
  flake.nixosModules.searxng = { config, lib, ... }:
    let
      cfg = config.services.xinity-ai-searxng;
    in {
      options.services.xinity-ai-searxng = {
        enable = lib.mkEnableOption "SearXNG web search engine for xinity-ai";

        port = lib.mkOption {
          type = lib.types.port;
          default = 8888;
          description = "Port SearXNG listens on.";
        };

        host = lib.mkOption {
          type = lib.types.str;
          default = "127.0.0.1";
          description = "Address SearXNG binds to.";
        };

        secretKey = lib.mkOption {
          type = lib.types.str;
          default = "xinity-searxng-default-key";
          description = ''
            SearXNG secret key.
            WARNING: The default value is NOT SECURE. Override via environmentFile for production.
            Setting this directly exposes the secret in the Nix store.
          '';
        };

        environmentFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            Environment file for SearXNG secrets (SEARXNG_SECRET).
            This is the RECOMMENDED and SECURE way to provide the secret key.
            Secrets in environment files are not exposed in the Nix store.
          '';
        };

        extraSettings = lib.mkOption {
          type = lib.types.attrs;
          default = { };
          description = "Additional SearXNG settings (deep-merged into the configuration).";
        };
      };

      config = lib.mkIf cfg.enable {
        services.searx = {
          enable = true;
          settings = lib.recursiveUpdate {
            server = {
              port = cfg.port;
              bind_address = cfg.host;
              secret_key = cfg.secretKey;
              limiter = false;
            };
            search.formats = [ "html" "json" ];
          } cfg.extraSettings;
          environmentFile = cfg.environmentFile;
        };
      };
    };

  # ── All-in-One Module ─────────────────────────────────────────────────
  flake.nixosModules.allinone = { config, lib, pkgs, ... }:
    let
      cfg = config.services.xinity-ai;
    in {
      imports = [
        self.nixosModules.database
        self.nixosModules.db-init
        self.nixosModules.gateway
        self.nixosModules.dashboard
        self.nixosModules.infoserver
        self.nixosModules.searxng
        self.nixosModules.seaweedfs
        self.nixosModules.caddy
      ];

      options.services.xinity-ai = {
        enable = lib.mkEnableOption "xinity-ai all-in-one deployment (PostgreSQL, Redis, gateway, dashboard, infoserver, Caddy)";

        domain = lib.mkOption {
          type = lib.types.str;
          description = "Base domain (e.g. example.com). Caddy will handle HTTPS for *.domain.";
        };

        acmeEmail = lib.mkOption {
          type = lib.types.str;
          description = "Email for ACME/Let's Encrypt certificates.";
        };

        dashboardSubdomain = lib.mkOption {
          type = lib.types.str;
          default = "dashboard";
          description = "Subdomain for dashboard (results in dashboard.example.com).";
        };

        gatewaySubdomain = lib.mkOption {
          type = lib.types.str;
          default = "api";
          description = "Subdomain for gateway API (results in api.example.com).";
        };

        infoserverSubdomain = lib.mkOption {
          type = lib.types.str;
          default = "sysinfo";
          description = "Subdomain for infoserver (results in sysinfo.example.com).";
        };

        database = {
          name = lib.mkOption {
            type = lib.types.str;
            default = "xinity";
            description = "PostgreSQL database name.";
          };
          user = lib.mkOption {
            type = lib.types.str;
            default = "xinity";
            description = "PostgreSQL user.";
          };
          pgPasswordFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to file containing PostgreSQL password for the database user.";
          };
        };

        listenMode = lib.mkOption {
          type = lib.types.str;
          default = "local";
          description = ''
            Controls how PostgreSQL and Redis bind. Forwarded to the database module.
            See services.xinity-ai-database.listenMode for details.
          '';
        };

        gateway = {
          port = lib.mkOption {
            type = lib.types.port;
            default = 4121;
            description = "Port for the gateway service.";
          };
          backendTimeoutMs = lib.mkOption {
            type = lib.types.int;
            default = 300000;
            description = "Maximum time in ms to wait for a backend response.";
          };
        };

        dashboard = {
          port = lib.mkOption {
            type = lib.types.port;
            default = 5121;
            description = "Port for the dashboard service.";
          };
          mcpEnabled = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable the /mcp Model Context Protocol endpoint.";
          };
          licenseKey = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "License key (WARNING: exposes in Nix store, prefer secrets.licenseKeyFile).";
          };
        };

        infoserver = {
          port = lib.mkOption {
            type = lib.types.port;
            default = 8090;
            description = "Port for the infoserver.";
          };
          modelInfoFile = lib.mkOption {
            type = lib.types.path;
            description = "Path to the models YAML file on the host.";
          };
        };

        redis = {
          port = lib.mkOption {
            type = lib.types.port;
            default = 6379;
            description = "Port for the Redis instance.";
          };
          redisPasswordFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to file containing Redis password.";
          };
        };

        searxng = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable the bundled SearXNG instance for web search.";
          };
          port = lib.mkOption {
            type = lib.types.port;
            default = 8888;
            description = "Port for the SearXNG instance.";
          };
        };

        seaweedfs = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Enable the bundled SeaweedFS instance for S3-compatible object storage.";
          };
          s3Port = lib.mkOption {
            type = lib.types.port;
            default = 8333;
            description = "Port for the SeaweedFS S3 API.";
          };
          s3Config = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to S3 access config JSON for SeaweedFS.";
          };
        };

        containerUid = lib.mkOption {
          type = lib.types.int;
          default = 6000;
          description = "UID (and GID) the container processes run as. Secret files passed via *File options must be readable by this UID.";
        };

        # --- Secret file options (recommended for production) ---
        # These use the _FILE env var pattern for secure secret injection.

        secrets = {
          dbConnectionUrlFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to file containing DB connection URL. Applied to gateway and dashboard.";
          };
          redisUrlFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to file containing Redis URL. Applied to gateway.";
          };
          betterAuthSecretFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to file containing Better Auth secret. Applied to dashboard.";
          };
          mailUrlFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to file containing SMTP mail URL. Applied to dashboard.";
          };
          metricsAuthFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to file containing metrics auth. Applied to gateway and dashboard.";
          };
          s3AccessKeyIdFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to file containing S3 access key ID. Applied to gateway and dashboard.";
          };
          s3SecretAccessKeyFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to file containing S3 secret access key. Applied to gateway and dashboard.";
          };
          licenseKeyFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to file containing the license key. Applied to dashboard.";
          };
        };

        environmentFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            Shared environment file for secrets (DB_CONNECTION_URL, REDIS_URL, BETTER_AUTH_SECRET, etc.).
            Applied to all service containers.

            This is the RECOMMENDED and SECURE way to provide credentials.
            Secrets in environment files are not exposed in the Nix store.
          '';
        };

        useHostNetwork = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = ''
            Use host networking mode for containers (--network=host).
            When true, containers use localhost to communicate.
            When false, containers use Docker bridge networking and can reach each other by container name.
          '';
        };

        migrateOnStart = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Run database migrations automatically before starting services.";
        };

      };

      config =
        let
          # INTERNAL URLs - for backend-to-backend communication
          infoserverHost = if cfg.useHostNetwork then "127.0.0.1" else "xinity-infoserver";
          infoserverUrl = "http://${infoserverHost}:${toString cfg.infoserver.port}";

          # PUBLIC URLs - always HTTPS via Caddy
          publicDashboardUrl = "https://${cfg.dashboardSubdomain}.${cfg.domain}";
          publicGatewayUrl = "https://${cfg.gatewaySubdomain}.${cfg.domain}";

          envFiles = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
          networkOptions = lib.optional cfg.useHostNetwork "--network=host";
        in
        lib.mkIf cfg.enable {

          # --- Delegate to database module ---
          services.xinity-ai-database = {
            enable = true;
            name = cfg.database.name;
            user = cfg.database.user;
            listenMode = cfg.listenMode;
            redis.port = cfg.redis.port;
            pgPasswordFile = cfg.database.pgPasswordFile;
            redisPasswordFile = cfg.redis.redisPasswordFile;
          };

          # --- Database initialization (password setup + migrations) ---
          services.xinity-ai-db-init.enable  = cfg.migrateOnStart;

          # --- Gateway ---
          services.xinity-ai-gateway = {
            enable = true;
            containerUid = cfg.containerUid;
            port = cfg.gateway.port;
            backendTimeoutMs = lib.mkDefault cfg.gateway.backendTimeoutMs;
            infoserverUrl = infoserverUrl;
            webSearchEngineUrl =
              if cfg.searxng.enable
              then "http://127.0.0.1:${toString cfg.searxng.port}"
              else null;
            s3Endpoint = lib.mkDefault (
              if cfg.seaweedfs.enable
              then "http://127.0.0.1:${toString cfg.seaweedfs.s3Port}"
              else null
            );
            # Secret file options (mkDefault so direct submodule config can override)
            dbConnectionUrlFile = lib.mkDefault cfg.secrets.dbConnectionUrlFile;
            redisUrlFile = lib.mkDefault cfg.secrets.redisUrlFile;
            metricsAuthFile = lib.mkDefault cfg.secrets.metricsAuthFile;
            s3AccessKeyIdFile = lib.mkDefault cfg.secrets.s3AccessKeyIdFile;
            s3SecretAccessKeyFile = lib.mkDefault cfg.secrets.s3SecretAccessKeyFile;
            environmentFiles = envFiles;
            extraOptions = networkOptions;
          };

          # --- Dashboard ---
          services.xinity-ai-dashboard = {
            enable = true;
            containerUid = cfg.containerUid;
            port = cfg.dashboard.port;
            mcpEnabled = lib.mkDefault cfg.dashboard.mcpEnabled;
            licenseKey = lib.mkDefault cfg.dashboard.licenseKey;
            betterAuthUrl = publicDashboardUrl;  # Public URL for auth redirects
            origin = publicDashboardUrl;          # Public URL for CORS
            infoserverUrl = infoserverUrl;        # Internal URL for server-side fetching
            publicLlmApiUrl = "${publicGatewayUrl}/v1";  # Public URL for client-side API calls
            nodeEnv = "production";
            s3Endpoint = lib.mkDefault (
              if cfg.seaweedfs.enable
              then "http://127.0.0.1:${toString cfg.seaweedfs.s3Port}"
              else null
            );
            # Secret file options (mkDefault so direct submodule config can override)
            dbConnectionUrlFile = lib.mkDefault cfg.secrets.dbConnectionUrlFile;
            betterAuthSecretFile = lib.mkDefault cfg.secrets.betterAuthSecretFile;
            mailUrlFile = lib.mkDefault cfg.secrets.mailUrlFile;
            metricsAuthFile = lib.mkDefault cfg.secrets.metricsAuthFile;
            s3AccessKeyIdFile = lib.mkDefault cfg.secrets.s3AccessKeyIdFile;
            s3SecretAccessKeyFile = lib.mkDefault cfg.secrets.s3SecretAccessKeyFile;
            licenseKeyFile = lib.mkDefault cfg.secrets.licenseKeyFile;
            environmentFiles = envFiles;
            extraOptions = networkOptions;
          };

          # --- InfoServer ---
          services.xinity-infoserver = {
            enable = true;
            port = cfg.infoserver.port;
            modelInfoFile = cfg.infoserver.modelInfoFile;
            environmentFiles = envFiles;
            extraOptions = networkOptions;
          };

          # --- SearXNG ---
          services.xinity-ai-searxng = lib.mkIf cfg.searxng.enable {
            enable = true;
            port = cfg.searxng.port;
          };

          # --- SeaweedFS ---
          services.xinity-ai-seaweedfs = lib.mkIf cfg.seaweedfs.enable {
            enable = true;
            s3Port = cfg.seaweedfs.s3Port;
            s3Config = cfg.seaweedfs.s3Config;
          };

          # --- Caddy (always enabled in allinone) ---
          services.xinity-ai-caddy = {
            enable = true;
            domain = cfg.domain;
            acmeEmail = cfg.acmeEmail;
            dashboardSubdomain = cfg.dashboardSubdomain;
            gatewaySubdomain = cfg.gatewaySubdomain;
            infoserverSubdomain = cfg.infoserverSubdomain;
          };
        };
    };
}
