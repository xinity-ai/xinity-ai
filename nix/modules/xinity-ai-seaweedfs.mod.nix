{ self, ... }: {
  flake.nixosModules.seaweedfs = { config, lib, pkgs, ... }:
    let
      cfg = config.services.xinity-ai-seaweedfs;
    in {
      options.services.xinity-ai-seaweedfs = {
        enable = lib.mkEnableOption "SeaweedFS S3-compatible object storage for xinity-ai";

        package = lib.mkOption {
          type = lib.types.package;
          default = pkgs.seaweedfs;
          description = "The SeaweedFS package to use.";
        };

        s3Port = lib.mkOption {
          type = lib.types.port;
          default = 8333;
          description = "Port for the S3 API endpoint.";
        };

        masterPort = lib.mkOption {
          type = lib.types.port;
          default = 9333;
          description = "Port for the SeaweedFS master.";
        };

        volumePort = lib.mkOption {
          type = lib.types.port;
          default = 8080;
          description = "Port for the SeaweedFS volume server.";
        };

        filerPort = lib.mkOption {
          type = lib.types.port;
          default = 8889;
          description = "Port for the SeaweedFS filer (default 8889 to avoid conflict with SearXNG).";
        };

        dataDir = lib.mkOption {
          type = lib.types.str;
          default = "/var/lib/seaweedfs";
          description = "Directory for SeaweedFS data persistence.";
        };

        s3Config = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to S3 config JSON file (for access keys). If null, anonymous access is allowed.";
        };

        extraArgs = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = "Additional arguments to pass to 'weed server'.";
        };
      };

      config = lib.mkIf cfg.enable {
        systemd.tmpfiles.rules = [
          "d ${cfg.dataDir} 0750 seaweedfs seaweedfs - -"
        ];

        users.users.seaweedfs = {
          isSystemUser = true;
          group = "seaweedfs";
          home = cfg.dataDir;
        };

        users.groups.seaweedfs = { };

        systemd.services.xinity-ai-seaweedfs = {
          description = "SeaweedFS S3-compatible object storage";
          wantedBy = [ "multi-user.target" ];
          after = [ "network.target" ];

          serviceConfig = {
            User = "seaweedfs";
            Group = "seaweedfs";
            ExecStart = lib.concatStringsSep " " ([
              "${cfg.package}/bin/weed"
              "server"
              "-master.port=${toString cfg.masterPort}"
              "-volume.port=${toString cfg.volumePort}"
              "-filer"
              "-filer.port=${toString cfg.filerPort}"
              "-s3"
              "-s3.port=${toString cfg.s3Port}"
              "-dir=${cfg.dataDir}"
            ]
            ++ lib.optional (cfg.s3Config != null) "-s3.config=${cfg.s3Config}"
            ++ cfg.extraArgs);
            Restart = "always";
            RestartSec = 5;
            WorkingDirectory = cfg.dataDir;
          };
        };
      };
    };
}
