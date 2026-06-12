{ ... }: {
  flake.nixosModules.prometheus = { config, lib, ... }:
    let
      cfg = config.services.xinity-ai-prometheus;

      # Basic-auth block applied to each xinity scrape job when credentials are
      # configured. Prometheus reads the password from a file so it never lands
      # in the Nix store.
      basicAuth = lib.optionalAttrs (cfg.basicAuthUsername != null && cfg.basicAuthPasswordFile != null) {
        basic_auth = {
          username = cfg.basicAuthUsername;
          password_file = cfg.basicAuthPasswordFile;
        };
      };

      job = name: targets: ({
        job_name = name;
        metrics_path = "/metrics";
        static_configs = [ { targets = targets; } ];
      } // basicAuth);
    in {
      options.services.xinity-ai-prometheus = {
        enable = lib.mkEnableOption "a bundled Prometheus instance pre-wired to scrape the xinity-ai gateway, dashboard, and daemon nodes. Pair it with services.xinity-ai-dashboard.prometheusUrl to light up the live GPU metrics overlay on the Compute fleet page";

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
          description = "host:port of the dashboard /metrics endpoint. In the all-in-one deployment this resolves to the local dashboard port automatically.";
        };

        daemonTargets = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          example = [ "10.0.0.5:4010" "10.0.0.6:4010" ];
          description = "host:port entries for each daemon node's /metrics endpoint. Daemons usually run on separate machines, so this is empty by default. The dashboard's Instance Settings > Monitoring page generates this list from the live node registry.";
        };

        basicAuthUsername = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Username for scraping endpoints protected by METRICS_AUTH. Applied to all xinity jobs when set together with basicAuthPasswordFile.";
        };

        basicAuthPasswordFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to a file containing the password matching basicAuthUsername. Read by Prometheus at scrape time, so the secret never enters the Nix store.";
        };

        extraScrapeConfigs = lib.mkOption {
          type = lib.types.listOf lib.types.attrs;
          default = [ ];
          description = "Additional raw Prometheus scrape_configs entries appended to the generated set. Use this to scrape services outside the xinity stack.";
        };
      };

      config = lib.mkIf cfg.enable {
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
            ]
            ++ lib.optional (cfg.daemonTargets != [ ]) (job "xinity-daemon" cfg.daemonTargets)
            ++ cfg.extraScrapeConfigs;
        };
      };
    };
}
