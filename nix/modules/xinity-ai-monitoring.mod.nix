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

        grafana = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Provision a Grafana instance alongside Prometheus, pre-wired with the local Prometheus as its default datasource. On by default; set to false to run Prometheus alone.";
          };

          listenAddress = lib.mkOption {
            type = lib.types.str;
            default = "127.0.0.1";
            description = "Address Grafana binds to. Defaults to 127.0.0.1; put a reverse proxy (e.g. Caddy) in front to expose the UI.";
          };

          port = lib.mkOption {
            type = lib.types.port;
            default = 6121;
            description = "HTTP port Grafana listens on.";
          };

          domain = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = "Public domain Grafana is served under. Sets root_url so redirects and generated links work behind a reverse proxy. Leave null when reaching Grafana directly over the bound address.";
          };
        };

        logs = {
          enable = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Collect this machine's systemd journal into a local Loki store (shipped by Promtail) and expose it as a Grafana datasource named \"Loki\". On by default; set to false to skip log collection.";
          };

          port = lib.mkOption {
            type = lib.types.port;
            default = 6122;
            description = "HTTP port the local Loki log store listens on. Bound to loopback; queried by Grafana over 127.0.0.1.";
          };

          retentionPeriod = lib.mkOption {
            type = lib.types.str;
            default = "168h";
            description = "How long Loki retains log lines before the compactor deletes them. Must be a multiple of 24h (e.g. \"168h\" for 7 days).";
          };
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

        services.grafana = lib.mkIf cfg.grafana.enable {
          enable = true;
          settings.server = {
            http_addr = cfg.grafana.listenAddress;
            http_port = cfg.grafana.port;
          } // lib.optionalAttrs (cfg.grafana.domain != null) {
            domain = cfg.grafana.domain;
            root_url = "https://${cfg.grafana.domain}/";
          };
          provision.datasources.settings.datasources =
            [
              {
                name = "Prometheus";
                type = "prometheus";
                access = "proxy";
                url = "http://127.0.0.1:${toString cfg.port}";
                isDefault = true;
              }
            ]
            ++ lib.optional cfg.logs.enable {
              name = "Loki";
              type = "loki";
              access = "proxy";
              url = "http://127.0.0.1:${toString cfg.logs.port}";
            };

          # Dashboards reference the datasources by the fixed uids above, so the
          # same JSON files provision identically here and in the docker stack.
          provision.dashboards.settings.providers =
            [
              {
                name = "xinity";
                orgId = 1;
                folder = "Xinity";
                type = "file";
                disableDeletion = false;
                allowUiUpdates = false;
                updateIntervalSeconds = 30;
                options.path = ../../deployment/monitoring/dashboards;
              }
            ]
            ++ lib.optional cfg.logs.enable {
              name = "xinity-logs";
              orgId = 1;
              folder = "Xinity";
              type = "file";
              disableDeletion = false;
              allowUiUpdates = false;
              updateIntervalSeconds = 30;
              options.path = ../../deployment/monitoring/dashboards-loki;
            };
        };

        services.loki = lib.mkIf cfg.logs.enable {
          enable = true;
          configuration = {
            auth_enabled = false;
            server = {
              http_listen_address = "127.0.0.1";
              http_listen_port = cfg.logs.port;
              grpc_listen_address = "127.0.0.1";
              grpc_listen_port = 9095;
              log_level = "warn";
            };
            common = {
              instance_addr = "127.0.0.1";
              path_prefix = "/var/lib/loki";
              storage.filesystem = {
                chunks_directory = "/var/lib/loki/chunks";
                rules_directory = "/var/lib/loki/rules";
              };
              replication_factor = 1;
              ring.kvstore.store = "inmemory";
            };
            schema_config.configs = [
              {
                from = "2024-01-01";
                store = "tsdb";
                object_store = "filesystem";
                schema = "v13";
                index = {
                  prefix = "index_";
                  period = "24h";
                };
              }
            ];
            limits_config.retention_period = cfg.logs.retentionPeriod;
            compactor = {
              working_directory = "/var/lib/loki/compactor";
              retention_enabled = true;
              delete_request_store = "filesystem";
            };
          };
        };

        services.promtail = lib.mkIf cfg.logs.enable {
          enable = true;
          configuration = {
            server = {
              http_listen_address = "127.0.0.1";
              http_listen_port = 9080;
              grpc_listen_port = 0;
            };
            clients = [
              { url = "http://127.0.0.1:${toString cfg.logs.port}/loki/api/v1/push"; }
            ];
            scrape_configs = [
              {
                job_name = "journal";
                journal = {
                  max_age = "12h";
                  labels.job = "systemd-journal";
                };
                relabel_configs = [
                  { source_labels = [ "__journal__systemd_unit" ]; target_label = "unit"; }
                  { source_labels = [ "__journal__hostname" ]; target_label = "host"; }
                  { source_labels = [ "__journal_priority_keyword" ]; target_label = "level"; }
                ];
              }
            ];
          };
        };
      };
    };
}
