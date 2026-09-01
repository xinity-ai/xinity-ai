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

        buckets = lib.mkOption {
          type = lib.types.listOf lib.types.str;
          default = [ ];
          description = "Buckets to create on start. SeaweedFS does not create a bucket on first write, so a client configured against a missing bucket fails every upload. Created through 'weed shell', which talks to the master and so keeps working when s3Config restricts the S3 endpoint.";
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

        systemd.services.xinity-ai-seaweedfs-buckets = lib.mkIf (cfg.buckets != [ ]) {
          description = "Create the SeaweedFS buckets xinity-ai expects";
          wantedBy = [ "multi-user.target" ];
          after = [ "xinity-ai-seaweedfs.service" ];
          requires = [ "xinity-ai-seaweedfs.service" ];

          serviceConfig = {
            User = "seaweedfs";
            Group = "seaweedfs";
            Type = "oneshot";
            RemainAfterExit = true;
            # oneshot disables the start timeout by default, and this unit talks to the network.
            TimeoutStartSec = 240;
            WorkingDirectory = cfg.dataDir;
          };

          # Three things this has to survive, all of them observed rather than guessed:
          # the server's own ports come up at different times, `weed shell` blocks forever when the
          # filer is not reachable yet, and it exits 0 whether or not the bucket was created. So the
          # filer decides readiness, every call is bounded, and success is read back from the list.
          script = ''
            for _ in $(seq 1 60); do
              ${pkgs.curl}/bin/curl -s -o /dev/null "http://127.0.0.1:${toString cfg.filerPort}/" && break
              sleep 1
            done

            shell() {
              echo "$1" | timeout 30 ${cfg.package}/bin/weed shell -master=127.0.0.1:${toString cfg.masterPort} 2>/dev/null
            }

            ${lib.concatMapStringsSep "\n" (bucket: ''
              shell "s3.bucket.create -name ${bucket}" || true
            '') cfg.buckets}

            # The prompt shares a line with the first result, so names are taken by field.
            listed=$(shell "s3.bucket.list" | tr -d '>' | awk '{print $1}')
            ${lib.concatMapStringsSep "\n" (bucket: ''
              if ! echo "$listed" | grep -qxF "${bucket}"; then
                echo "SeaweedFS bucket '${bucket}' was not created; media uploads would be dropped." >&2
                exit 1
              fi
            '') cfg.buckets}
          '';
        };
      };
    };
}
