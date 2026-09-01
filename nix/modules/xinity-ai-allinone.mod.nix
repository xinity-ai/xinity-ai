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

      vhost = subdomain: target: lib.optionalAttrs (subdomain != null) {
        "${subdomain}.${cfg.domain}".extraConfig = lib.mkDefault ''
          reverse_proxy ${target}
        '';
      };
    in {
      options.services.xinity-ai-caddy = {
        enable = lib.mkEnableOption "a Caddy reverse proxy that terminates TLS via ACME/Let's Encrypt and routes traffic to the xinity-ai dashboard, gateway, and infoserver by subdomain";

        domain = lib.mkOption {
          type = lib.types.str;
          description = "Base domain for the xinity-ai deployment (e.g. example.com). Each service gets a subdomain: dashboard.example.com, api.example.com, etc.";
        };

        acmeEmail = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Email address registered with ACME/Let's Encrypt for certificate expiry notifications and account recovery. When null, no email is registered and expiry warnings are lost.";
        };

        dashboardSubdomain = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = "dashboard";
          description = "Subdomain prefix for the dashboard (e.g. dashboard.example.com). Set to null to leave the dashboard unrouted.";
        };

        gatewaySubdomain = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = "api";
          description = "Subdomain prefix for the gateway (e.g. api.example.com). Set to null to leave the gateway unrouted.";
        };

        infoserverSubdomain = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = "models";
          description = "Subdomain prefix for the infoserver (e.g. models.example.com). Set to null to leave the infoserver unrouted, which is what you want when consuming a remote infoserver.";
        };

        grafanaSubdomain = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = "grafana";
          description = "Subdomain prefix for Grafana (e.g. grafana.example.com). Set to null to leave Grafana unrouted.";
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

        grafanaOrigin = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            Upstream origin for grafana (e.g. "http://10.0.0.5:6121" or "localhost:6121").
            If null, no grafana virtualHost is created.
          '';
        };
      };

      config = lib.mkIf cfg.enable {
        services.caddy = {
          enable = lib.mkDefault true;
          globalConfig = lib.mkIf (cfg.acmeEmail != null) (lib.mkDefault ''
            email ${cfg.acmeEmail}
          '');
          virtualHosts =
            vhost cfg.dashboardSubdomain dashboardTarget
            // vhost cfg.gatewaySubdomain gatewayTarget
            // vhost cfg.infoserverSubdomain infoserverTarget
            // lib.optionalAttrs (cfg.grafanaOrigin != null)
              (vhost cfg.grafanaSubdomain cfg.grafanaOrigin);
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
        enable = lib.mkEnableOption "a bundled SearXNG metasearch engine instance that the gateway uses for web-search-augmented generation";

        port = lib.mkOption {
          type = lib.types.port;
          default = 8888;
          description = "HTTP port SearXNG listens on. The gateway connects to this port to perform web searches.";
        };

        host = lib.mkOption {
          type = lib.types.str;
          default = "127.0.0.1";
          description = "Address SearXNG binds to. Use 127.0.0.1 to restrict access to localhost (recommended when behind the gateway), or 0.0.0.0 to allow external access.";
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
          description = "Additional SearXNG settings deep-merged into the generated configuration. Use this to enable/disable search engines, configure rate limiting, or adjust result formatting.";
        };
      };

      config = lib.mkIf cfg.enable {
        services.searx = {
          enable = lib.mkDefault true;
          settings = lib.mkDefault (lib.recursiveUpdate {
            server = {
              port = cfg.port;
              bind_address = cfg.host;
              secret_key = cfg.secretKey;
              limiter = false;
            };
            search.formats = [ "html" "json" ];
          } cfg.extraSettings);
          environmentFile = lib.mkDefault cfg.environmentFile;
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
        self.nixosModules.tether
        self.nixosModules.daemon
        self.nixosModules.seaweedfs
        self.nixosModules.monitoring
        self.nixosModules.caddy

        (lib.mkRemovedOptionModule
          [ "services" "xinity-ai" "containerUid" ]
          "The gateway and dashboard now run as native systemd services, not OCI containers. Remove this option from your configuration.")
        (lib.mkRemovedOptionModule
          [ "services" "xinity-ai" "useHostNetwork" ]
          "The services now run as native systemd processes that always use the host network. Remove this option from your configuration.")
        (lib.mkRemovedOptionModule
          [ "services" "xinity-ai" "infoserver" "modelInfoFile" ]
          "The infoserver no longer accepts a single YAML file. Use `services.xinity-ai.infoserver.modelInfoDir` to point at a directory of model YAML files instead.")
      ];

      options.services.xinity-ai = {
        enable = lib.mkEnableOption "the xinity-ai all-in-one deployment, which provisions and wires together all services (PostgreSQL, Redis, gateway, dashboard, infoserver, Caddy, and optionally SearXNG and SeaweedFS) on a single machine with sensible defaults";

        domain = lib.mkOption {
          type = lib.types.str;
          description = "Base domain for the deployment (e.g. example.com). Caddy provisions TLS certificates and routes traffic for each service's subdomain under this domain.";
        };

        acmeEmail = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Email address registered with ACME/Let's Encrypt for certificate expiry notifications. Forwarded to the Caddy module. Required unless caddy.enable is false.";
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

        grafanaSubdomain = lib.mkOption {
          type = lib.types.str;
          default = "grafana";
          description = "Subdomain for Grafana (results in grafana.example.com). Only routed when monitoring and Grafana are enabled.";
        };

        database = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Provision the local PostgreSQL instance, with automatic schema migrations. Set to false to run against an external server, in which case you give every service its connection URL through secrets.dbConnectionUrlFile or environmentFiles and manage its schema yourself.";
          };
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
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Run the gateway on this machine.";
          };
          port = lib.mkOption {
            type = lib.types.port;
            default = 4121;
            description = "Port for the gateway service.";
          };
          backendTimeoutMs = lib.mkOption {
            type = lib.types.int;
            default = 300000;
            description = "Maximum time in milliseconds to wait for an inference backend to respond. Forwarded to the gateway module.";
          };
        };

        dashboard = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Run the admin dashboard on this machine.";
          };
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
            description = "License key for unlocking paid features (Ed25519-signed token). WARNING: exposes the key in the Nix store. Prefer secrets.licenseKeyFile for production.";
          };
        };

        infoserver = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Run the bundled infoserver on this machine. Set to false to consume a remote one, and point services.xinity-ai.infoserverUrl at it.";
          };
          port = lib.mkOption {
            type = lib.types.port;
            default = 8090;
            description = "Port for the infoserver.";
          };
          modelInfoDir = lib.mkOption {
            type = lib.types.path;
            description = "Path to a directory of model YAML files on the host. Only needed when infoserver.enable is true.";
          };
        };

        infoserverUrl = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = ''
            URL of the infoserver the gateway, dashboard, and daemon should use
            (e.g. https://sysinfo.xinity.ai). When null, the bundled infoserver on loopback is
            used. Required when infoserver.enable is false.
          '';
        };

        tether = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Run the tether on this machine. Inference nodes connect to it to receive desired state.";
          };
          port = lib.mkOption {
            type = lib.types.port;
            default = 4020;
            description = "Port for the tether service.";
          };
          openFirewall = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Open the tether's port in the firewall. Needed when inference nodes run on other machines. Caddy does not front the tether, so this port is separate from 80 and 443.";
          };
          tlsCertFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to a file containing the PEM-encoded TLS certificate for the tether. Enables HTTPS on it.";
          };
          tlsKeyFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to a file containing the PEM-encoded TLS private key for the tether. Required with tether.tlsCertFile.";
          };
        };

        daemon = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = ''
              Run an inference daemon on this machine, tethered over loopback, so the
              all-in-one host serves models itself. Set to false for a control-plane-only
              deployment whose capacity comes entirely from separate inference nodes.
            '';
          };
          port = lib.mkOption {
            type = lib.types.port;
            default = 4044;
            description = "Port the local daemon's API listens on. The gateway connects to it to forward inference requests.";
          };
          ollama = {
            enable = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = ''
                Provision Ollama as the local daemon's inference driver and wire its endpoint
                automatically. Without a driver the daemon registers but can serve nothing.

                NixOS defaults Ollama to CPU inference; set services.ollama.acceleration to
                "cuda" or "rocm" to use the GPU. Set this to false to supply a driver yourself
                through services.xinity-ai-daemon (vLLM, or an Ollama instance elsewhere).
              '';
            };
          };
        };

        caddy = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Run the bundled Caddy reverse proxy, which terminates TLS via ACME and routes each service by subdomain. Set to false to handle reverse proxying yourself, in which case no ports are opened for you and acmeEmail is not required.";
          };
        };

        redis = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Provision the local Redis instance. Set to false to use an external Redis, and give the gateway its URL through secrets.redisUrlFile.";
          };
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
            description = "Enable the bundled SearXNG metasearch engine. When enabled, the gateway automatically uses it for web-search-augmented generation.";
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
            description = "Enable the bundled SeaweedFS instance for S3-compatible object storage. When enabled, the gateway and dashboard automatically use it for media uploads.";
          };
          s3Port = lib.mkOption {
            type = lib.types.port;
            default = 8333;
            description = "Port for the SeaweedFS S3 API.";
          };
          s3Config = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to an S3 configuration JSON file defining access keys and permissions for SeaweedFS. When null, anonymous S3 access is allowed.";
          };
          bucket = lib.mkOption {
            type = lib.types.str;
            default = "xinity-media";
            description = "Bucket media is stored in. Created on the bundled SeaweedFS and handed to the gateway and dashboard, so all three cannot disagree.";
          };
        };

        monitoring = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Enable the bundled monitoring stack (Prometheus), pre-wired to scrape the local gateway and dashboard. When enabled, the dashboard's PROMETHEUS_URL is set automatically so the Compute page shows live GPU metrics.";
          };
          port = lib.mkOption {
            type = lib.types.port;
            default = 9090;
            description = "Port for the Prometheus query API and web UI. Bound to localhost; the dashboard queries it over loopback.";
          };
          basicAuthUsername = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Username Prometheus authenticates as when scraping /metrics. Together with the password it forms a user:pass pair that MUST be present in METRICS_AUTH, or scrapes fail with 401 (add `prometheus:<password>` to METRICS_AUTH and set this to `prometheus`). Required when monitoring.enable is true.";
          };
          basicAuthPasswordFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to a file containing the scrape password for basicAuthUsername. Read at scrape time, so it never enters the Nix store. Recommended over basicAuthPassword.";
          };
          basicAuthPassword = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Scrape password for basicAuthUsername, inline. WARNING: exposes the secret in the Nix store; prefer basicAuthPasswordFile.";
          };
          grafana = {
            enable = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Provision Grafana alongside Prometheus, pre-wired with the local Prometheus datasource. On by default; set to false to run Prometheus alone.";
            };
            port = lib.mkOption {
              type = lib.types.port;
              default = 6121;
              description = "Port for the Grafana UI. Bound to localhost; Caddy serves it at grafana.<domain>.";
            };
          };
          logs = {
            enable = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Collect the machine's systemd journal into a local Loki store and expose it as a Grafana datasource. Also points the dashboard's audit forwarder at that Loki instance. On by default; set to false to skip log collection.";
            };
          };
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
          tetherSecretFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Path to file containing the tether shared secret. Applied to the tether and to the local daemon. Every additional inference node must be given the same secret as TETHER_SECRET; there is one shared secret per deployment, not one per node.";
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

        environmentFiles = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = ''
            systemd EnvironmentFile paths loaded at service start for sensitive values
            (DB_CONNECTION_URL, REDIS_URL, BETTER_AUTH_SECRET, etc.).
            Applied to all services (gateway, dashboard, infoserver).

            This is the RECOMMENDED and SECURE way to provide credentials.
            Secrets in environment files are not exposed in the Nix store.
          '';
        };

        environmentFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          visible = false;
          description = "Deprecated: use environmentFiles instead.";
        };

        migrateOnStart = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = ''
            Run Drizzle database migrations automatically at boot before starting the gateway
            and dashboard. Disable this if you manage schema migrations out-of-band.

            Only applies to the bundled PostgreSQL instance. An external server is never
            migrated for you, so with database.enable = false you manage its schema yourself
            and this option has no effect.
          '';
        };

      };

      config =
        let
          infoserverUrl =
            if cfg.infoserverUrl != null then cfg.infoserverUrl
            else "http://127.0.0.1:${toString cfg.infoserver.port}";

          publicDashboardUrl = "https://${cfg.dashboardSubdomain}.${cfg.domain}";
          publicGatewayUrl = "https://${cfg.gatewaySubdomain}.${cfg.domain}";

          # A TLS-serving tether cannot be reached at 127.0.0.1 without failing hostname
          # verification, so the local daemon uses the same name remote nodes do.
          tetherUrl =
            if cfg.tether.tlsCertFile != null
            then "https://${cfg.domain}:${toString cfg.tether.port}"
            else "http://127.0.0.1:${toString cfg.tether.port}";

          envFiles = cfg.environmentFiles
            ++ lib.optional (cfg.environmentFile != null) cfg.environmentFile;
        in
        lib.mkIf cfg.enable {

          warnings = lib.optional (cfg.environmentFile != null)
            "services.xinity-ai.environmentFile is deprecated. Use services.xinity-ai.environmentFiles instead.";

          assertions = [
            {
              assertion = !cfg.caddy.enable || cfg.acmeEmail != null;
              message = ''
                services.xinity-ai.acmeEmail must be set so Caddy can register with ACME.
                Set it, or set services.xinity-ai.caddy.enable = false to handle reverse
                proxying yourself.
              '';
            }
            {
              assertion = cfg.infoserver.enable || cfg.infoserverUrl != null;
              message = ''
                services.xinity-ai.infoserver.enable is false, so services.xinity-ai.infoserverUrl
                must point at the infoserver to use (e.g. https://sysinfo.xinity.ai).
              '';
            }
          ];

          # --- Delegate to database module ---
          services.xinity-ai-database = lib.mkIf (cfg.database.enable || cfg.redis.enable) {
            enable = true;
            postgres.enable = cfg.database.enable;
            redis.enable = cfg.redis.enable;
            name = lib.mkDefault cfg.database.name;
            user = lib.mkDefault cfg.database.user;
            listenMode = lib.mkDefault cfg.listenMode;
            redis.port = lib.mkDefault cfg.redis.port;
            pgPasswordFile = lib.mkDefault cfg.database.pgPasswordFile;
            redisPasswordFile = lib.mkDefault cfg.redis.redisPasswordFile;
          };

          # --- Database initialization (password setup + migrations) ---
          services.xinity-ai-db-init.enable = cfg.migrateOnStart && cfg.database.enable;

          # --- Gateway ---
          services.xinity-ai-gateway = lib.mkIf cfg.gateway.enable {
            enable = true;
            port = lib.mkDefault cfg.gateway.port;
            backendTimeoutMs = lib.mkDefault cfg.gateway.backendTimeoutMs;
            infoserverUrl = lib.mkDefault infoserverUrl;
            webSearchEngineUrl = lib.mkDefault (
              if cfg.searxng.enable
              then "http://127.0.0.1:${toString cfg.searxng.port}"
              else null
            );
            s3Endpoint = lib.mkDefault (
              if cfg.seaweedfs.enable
              then "http://127.0.0.1:${toString cfg.seaweedfs.s3Port}"
              else null
            );
            # Secret file options (mkDefault so direct submodule config can override)
            dbConnectionUrlFile = lib.mkDefault cfg.secrets.dbConnectionUrlFile;
            redisUrlFile = lib.mkDefault cfg.secrets.redisUrlFile;
            metricsAuthFile = lib.mkDefault cfg.secrets.metricsAuthFile;
            s3Bucket = lib.mkDefault cfg.seaweedfs.bucket;
            s3AccessKeyIdFile = lib.mkDefault cfg.secrets.s3AccessKeyIdFile;
            s3SecretAccessKeyFile = lib.mkDefault cfg.secrets.s3SecretAccessKeyFile;
            environmentFiles = lib.mkDefault envFiles;
          };

          # --- Dashboard ---
          services.xinity-ai-dashboard = lib.mkIf cfg.dashboard.enable {
            enable = true;
            port = lib.mkDefault cfg.dashboard.port;
            mcpEnabled = lib.mkDefault cfg.dashboard.mcpEnabled;
            licenseKey = lib.mkDefault cfg.dashboard.licenseKey;
            betterAuthUrl = lib.mkDefault publicDashboardUrl;  # Public URL for auth redirects
            origin = lib.mkDefault publicDashboardUrl;
            reverseProxy.ipHeader = lib.mkDefault "x-forwarded-for";
            reverseProxy.xffDepth = lib.mkDefault 1;
            infoserverUrl = lib.mkDefault infoserverUrl;        # Internal URL for server-side fetching
            gatewayUrl = lib.mkDefault publicGatewayUrl;        # Public gateway base URL (no /v1 suffix)
            nodeEnv = lib.mkDefault "production";
            prometheusUrl = lib.mkDefault (
              if cfg.monitoring.enable
              then "http://127.0.0.1:${toString cfg.monitoring.port}"
              else null
            );
            auditLokiUrl = lib.mkDefault (
              if cfg.monitoring.enable && cfg.monitoring.logs.enable
              then "http://127.0.0.1:${toString config.services.xinity-ai-monitoring.logs.port}"
              else null
            );
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
            s3Bucket = lib.mkDefault cfg.seaweedfs.bucket;
            s3AccessKeyIdFile = lib.mkDefault cfg.secrets.s3AccessKeyIdFile;
            s3SecretAccessKeyFile = lib.mkDefault cfg.secrets.s3SecretAccessKeyFile;
            licenseKeyFile = lib.mkDefault cfg.secrets.licenseKeyFile;
            environmentFiles = lib.mkDefault envFiles;
          };

          # --- InfoServer ---
          services.xinity-infoserver = lib.mkIf cfg.infoserver.enable {
            enable = true;
            port = lib.mkDefault cfg.infoserver.port;
            modelInfoDir = lib.mkDefault cfg.infoserver.modelInfoDir;
            environmentFiles = lib.mkDefault envFiles;
          };

          # --- Tether ---
          services.xinity-tether = lib.mkIf cfg.tether.enable {
            enable = true;
            port = lib.mkDefault cfg.tether.port;
            dbConnectionUrlFile = lib.mkDefault cfg.secrets.dbConnectionUrlFile;
            tetherSecretFile = lib.mkDefault cfg.secrets.tetherSecretFile;
            metricsAuthFile = lib.mkDefault cfg.secrets.metricsAuthFile;
            openFirewall = lib.mkDefault cfg.tether.openFirewall;
            tlsCertFile = lib.mkDefault cfg.tether.tlsCertFile;
            tlsKeyFile = lib.mkDefault cfg.tether.tlsKeyFile;
            environmentFiles = lib.mkDefault envFiles;
          };

          # --- Daemon (local inference node) ---
          services.xinity-ai-daemon = lib.mkIf cfg.daemon.enable {
            enable = true;
            port = lib.mkDefault cfg.daemon.port;
            tetherUrl = lib.mkDefault tetherUrl;
            tetherSecretFile = lib.mkDefault cfg.secrets.tetherSecretFile;
            infoserverUrl = lib.mkDefault infoserverUrl;
            metricsAuthFile = lib.mkDefault cfg.secrets.metricsAuthFile;
            environmentFiles = lib.mkDefault envFiles;
          };

          services.ollama = lib.mkIf (cfg.daemon.enable && cfg.daemon.ollama.enable) {
            enable = true;
          };

          # --- SearXNG ---
          services.xinity-ai-searxng = lib.mkIf cfg.searxng.enable {
            enable = true;
            port = lib.mkDefault cfg.searxng.port;
          };

          # --- SeaweedFS ---
          services.xinity-ai-seaweedfs = lib.mkIf cfg.seaweedfs.enable {
            buckets = lib.mkDefault [ cfg.seaweedfs.bucket ];
            enable = true;
            s3Port = lib.mkDefault cfg.seaweedfs.s3Port;
            s3Config = lib.mkDefault cfg.seaweedfs.s3Config;
          };

          # --- Monitoring ---
          services.xinity-ai-monitoring = lib.mkIf cfg.monitoring.enable {
            enable = true;
            port = lib.mkDefault cfg.monitoring.port;
            gatewayTarget = lib.mkDefault "localhost:${toString cfg.gateway.port}";
            dashboardTarget = lib.mkDefault "localhost:${toString cfg.dashboard.port}";
            tetherTarget = lib.mkDefault "localhost:${toString cfg.tether.port}";
            basicAuthUsername = lib.mkDefault cfg.monitoring.basicAuthUsername;
            basicAuthPasswordFile = lib.mkDefault cfg.monitoring.basicAuthPasswordFile;
            basicAuthPassword = lib.mkDefault cfg.monitoring.basicAuthPassword;
            grafana.enable = lib.mkDefault cfg.monitoring.grafana.enable;
            grafana.port = lib.mkDefault cfg.monitoring.grafana.port;
            grafana.domain = lib.mkDefault "${cfg.grafanaSubdomain}.${cfg.domain}";
            logs.enable = lib.mkDefault cfg.monitoring.logs.enable;
          };

          # --- Caddy ---
          services.xinity-ai-caddy = lib.mkIf cfg.caddy.enable {
            enable = true;
            domain = lib.mkDefault cfg.domain;
            acmeEmail = lib.mkDefault cfg.acmeEmail;
            # Services running elsewhere are left unrouted rather than proxied to a dead port
            dashboardSubdomain =
              lib.mkDefault (if cfg.dashboard.enable then cfg.dashboardSubdomain else null);
            gatewaySubdomain =
              lib.mkDefault (if cfg.gateway.enable then cfg.gatewaySubdomain else null);
            infoserverSubdomain =
              lib.mkDefault (if cfg.infoserver.enable then cfg.infoserverSubdomain else null);
            grafanaSubdomain = lib.mkDefault cfg.grafanaSubdomain;
            grafanaOrigin =
              if cfg.monitoring.enable && cfg.monitoring.grafana.enable
              then "localhost:${toString cfg.monitoring.grafana.port}"
              else null;
          };
        };
    };
}
