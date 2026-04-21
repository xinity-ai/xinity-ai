{ ... }: {
  flake.nixosModules.seaweedfs = { config, lib, pkgs, ... }:
    let
      cfg = config.services.xinity-ai-seaweedfs;
    in {
      options.services.xinity-ai-seaweedfs = {
        enable = lib.mkEnableOption "a bundled SeaweedFS instance providing S3-compatible object storage for xinity-ai media uploads (avatars, attachments, etc.)";

        package = lib.mkOption {
          type = lib.types.package;
          default = pkgs.seaweedfs;
          description = "The SeaweedFS package to use. Override this to pin a specific version or use a custom build.";
        };

        s3Port = lib.mkOption {
          type = lib.types.port;
          default = 8333;
          description = "Port for the S3-compatible API endpoint. The gateway and dashboard connect to this port to store and retrieve media objects.";
        };

        masterPort = lib.mkOption {
          type = lib.types.port;
          default = 9333;
          description = "Port for the SeaweedFS master server, which manages volume placement and cluster topology.";
        };

        volumePort = lib.mkOption {
          type = lib.types.port;
          default = 8080;
          description = "Port for the SeaweedFS volume server, which handles the actual blob storage and retrieval.";
        };

        filerPort = lib.mkOption {
          type = lib.types.port;
          default = 8889;
          description = "Port for the SeaweedFS filer, which provides a file-system-like interface on top of blob storage. Defaults to 8889 to avoid conflicting with SearXNG's default port.";
        };

        dataDir = lib.mkOption {
          type = lib.types.str;
          default = "/var/lib/seaweedfs";
          description = "Directory for SeaweedFS data persistence. All volume data, filer metadata, and master state are stored here. A systemd-tmpfiles rule ensures this directory exists with correct ownership.";
        };

        s3Config = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Path to an S3 configuration JSON file that defines access keys and permissions. When null, the S3 endpoint allows anonymous access. See the SeaweedFS documentation for the config file format.";
        };

        extraArgs = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = "Additional command-line arguments appended to the 'weed server' invocation. Useful for tuning replication, compaction, or enabling additional sub-services.";
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
