{ ... }: {
  flake.nixosModules.monitoring = { config, lib, ... }:
    let
      cfg = config.services.xinity-ai-monitoring;

      passwordAttr =
        if cfg.basicAuthPasswordFile != null
        then { password_file = cfg.basicAuthPasswordFile; }
        else { password = cfg.basicAuthPassword; };

      basicAuth = {
        basic_auth = { username = cfg.basicAuthUsername; } // passwordAttr;
      };

      job = name: targets: ({
        job_name = name;
        metrics_path = "/metrics";
        static_configs = [ { targets = targets; } ];
      } // basicAuth);

      # Daemons come and go from the node registry, so they are discovered via
      # the dashboard's HTTP SD endpoint rather than listed statically.
      daemonSdUrl = "http://${cfg.dashboardTarget}/metrics/sd/daemons";

      daemonJob = {
        job_name = "xinity-daemon";
        metrics_path = "/metrics";
        http_sd_configs = [
          ({
            url = daemonSdUrl;
            refresh_interval = "3m";
          } // basicAuth)
        ];
      } // basicAuth;
    in {
      options.services.xinity-ai-monitoring = {
        enable = lib.mkEnableOption "bundled monitoring: a Prometheus instance pre-wired to scrape the xinity-ai gateway, dashboard, and daemon nodes. Pair it with services.xinity-ai-dashboard.prometheusUrl to light up the live GPU metrics overlay on the Compute page";

        listenAddress = lib.mkOption {
          type = lib.types.str;
          default = "127.0.0.1";
          description = "Address Prometheus binds to. Defaults to 127.0.0.1 so the metrics store is only reachable locally (the dashboard queries it over loopback). Set to 0.0.0.0 only if you need to reach the Prometheus UI from another host.";
        };

        port = lib.mkOption {
          type = lib.types.port;
          default = 9090;
          description = "HTTP port Prometheus listens on for its query API and web UI.";
        };

        scrapeInterval = lib.mkOption {
          type = lib.types.str;
          default = "30s";
          description = "Global scrape interval. How often Prometheus polls each /metrics endpoint.";
        };

        retentionTime = lib.mkOption {
          type = lib.types.str;
          default = "15d";
          description = "How long Prometheus retains time-series data before compacting it out (e.g. \"15d\", \"90d\").";
        };

        gatewayTarget = lib.mkOption {
          type = lib.types.str;
          default = "localhost:4121";
          description = "host:port of the gateway /metrics endpoint. In the all-in-one deployment this resolves to the local gateway port automatically.";
        };

        dashboardTarget = lib.mkOption {
          type = lib.types.str;
          default = "localhost:5121";
          description = "host:port of the dashboard. Scraped for its own /metrics and queried for daemon service discovery at /metrics/sd/daemons. Resolves to the local dashboard port in the all-in-one deployment.";
        };

        basicAuthUsername = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Username Prometheus authenticates as against the xinity /metrics endpoints. Together with the password it forms a user:pass pair that MUST be present in the METRICS_AUTH of every scraped component, or scrapes fail with 401 (e.g. add `prometheus:<password>` to METRICS_AUTH and set this to `prometheus`). Required when enabled.";
        };

        basicAuthPasswordFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the password for basicAuthUsername. Read at scrape time, so it never enters the Nix store. Recommended. Set exactly one of basicAuthPasswordFile or basicAuthPassword.";
        };

        basicAuthPassword = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Password for basicAuthUsername, inline. WARNING: exposes the secret in the Nix store; prefer basicAuthPasswordFile. Set exactly one of the two.";
        };

        extraScrapeConfigs = lib.mkOption {
          type = lib.types.listOf lib.types.attrs;
          default = [ ];
          description = "Additional raw Prometheus scrape_configs entries appended to the generated set. Use this to scrape services outside the xinity stack.";
        };
      };

      config = lib.mkIf cfg.enable {
        assertions = [
          {
            assertion = cfg.basicAuthUsername != null;
            message = "services.xinity-ai-monitoring: basicAuthUsername is required when the module is enabled. Set it to a username present in the scraped services' METRICS_AUTH list (e.g. \"prometheus\").";
          }
          {
            assertion = (cfg.basicAuthPasswordFile != null) != (cfg.basicAuthPassword != null);
            message = "services.xinity-ai-monitoring: set exactly one of basicAuthPasswordFile (recommended) or basicAuthPassword.";
          }
        ];

        services.prometheus = {
          enable = lib.mkDefault true;
          listenAddress = lib.mkDefault cfg.listenAddress;
          port = lib.mkDefault cfg.port;
          retentionTime = lib.mkDefault cfg.retentionTime;
          globalConfig.scrape_interval = lib.mkDefault cfg.scrapeInterval;
          scrapeConfigs =
            [
              (job "xinity-gateway" [ cfg.gatewayTarget ])
              (job "xinity-dashboard" [ cfg.dashboardTarget ])
              daemonJob
            ]
            ++ cfg.extraScrapeConfigs;
        };
      };
    };
}
