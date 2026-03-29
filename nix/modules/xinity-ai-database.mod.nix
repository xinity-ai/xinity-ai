{ withSystem, ... }: {

  # ── Database Module (PostgreSQL + Redis) ───────────────────────────────
  flake.nixosModules.database = { config, lib, pkgs, ... }:
    let
      cfg = config.services.xinity-ai-database;

      resolvedAddress = if cfg.listenMode == "local" then
        "127.0.0.1"
      else if cfg.listenMode == "public" then
        "0.0.0.0"
      else
        let
          addrs = config.networking.interfaces.${cfg.listenMode}.ipv4.addresses;
        in (builtins.head addrs).address;

      postgresListenAddresses = if cfg.listenMode == "local" then
        "127.0.0.1"
      else if cfg.listenMode == "public" then
        "*"
      else
        "${resolvedAddress}, 127.0.0.1";

      postgresAuth = if cfg.listenMode == "local" then ''
        host ${cfg.name} ${cfg.user} 127.0.0.1/32 scram-sha-256
        host ${cfg.name} ${cfg.user} ::1/128 scram-sha-256
      '' else if cfg.listenMode == "public" then ''
        host ${cfg.name} ${cfg.user} 127.0.0.1/32 scram-sha-256
        host ${cfg.name} ${cfg.user} ::1/128 scram-sha-256
        host ${cfg.name} ${cfg.user} 0.0.0.0/0 scram-sha-256
        host ${cfg.name} ${cfg.user} ::/0 scram-sha-256
      '' else ''
        host ${cfg.name} ${cfg.user} 127.0.0.1/32 scram-sha-256
        host ${cfg.name} ${cfg.user} ::1/128 scram-sha-256
        host ${cfg.name} ${cfg.user} ${resolvedAddress}/24 scram-sha-256
      '';

      redisBindAddress = if cfg.listenMode == "local" then
        "127.0.0.1"
      else if cfg.listenMode == "public" then
        "0.0.0.0"
      else
        "${resolvedAddress} 127.0.0.1";
    in {
      options.services.xinity-ai-database = {
        enable = lib.mkEnableOption
          "xinity-ai database stack (PostgreSQL, Redis, migrations)";

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

        listenMode = lib.mkOption {
          type = lib.types.str;
          default = "local";
          description = ''
            Controls how PostgreSQL and Redis bind to the network:
            - "local":  bind to 127.0.0.1 only (reachable from this machine).
            - "public": bind to 0.0.0.0 (reachable from any network).
            - Any other value is treated as a network interface name (e.g. "eth0");
              the first statically configured IPv4 address of that interface is used.
          '';
        };

        postgres = {
          port = lib.mkOption {
            type = lib.types.port;
            default = 5432;
            description = "Port for the PostgreSQL instance.";
          };
        };

        redis = {
          port = lib.mkOption {
            type = lib.types.port;
            default = 6379;
            description = "Port for the Redis instance.";
          };
        };

        pgPasswordFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description =
            "Path to a file containing the password for the PostgreSQL database user.";
        };

        redisPasswordFile = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description =
            "Path to a file containing the password for the Redis instance.";
        };
      };

      config = lib.mkIf cfg.enable {

        assertions = lib.optionals
          (cfg.listenMode != "local" && cfg.listenMode != "public") [{
            assertion =
              config.networking.interfaces.${cfg.listenMode}.ipv4.addresses
              != [ ];
            message = ''
              services.xinity-ai-database.listenMode is set to "${cfg.listenMode}" (a network interface),
              but no static IPv4 address is configured for it.
              Set networking.interfaces.${cfg.listenMode}.ipv4.addresses or choose a different listenMode.
            '';
          }];

        # --- PostgreSQL ---
        services.postgresql = {
          enable = true;
          package = pkgs.postgresql_17;
          enableTCPIP = true;
          ensureDatabases = [ cfg.name ];
          ensureUsers = [{ name = cfg.user; }];
          authentication = postgresAuth;
          settings = {
            listen_addresses = lib.mkDefault postgresListenAddresses;
            port = lib.mkDefault cfg.postgres.port;
            max_connections = lib.mkDefault 100;
            shared_buffers = lib.mkDefault "256MB";
            work_mem = lib.mkDefault "4MB";
            effective_cache_size = lib.mkDefault "768MB";
          };
        };

        # --- Redis ---
        services.redis.servers.xinity = {
          enable = true;
          port = cfg.redis.port;
          requirePassFile = cfg.redisPasswordFile;
          bind = redisBindAddress;
        };

        # --- Firewall ---
        networking.firewall.allowedTCPPorts =
          lib.mkIf (cfg.listenMode != "local")
            [ cfg.postgres.port cfg.redis.port ];

        # --- PostgreSQL password setup ---
        systemd.services.postgresql-auth-setup =
          lib.mkIf (cfg.pgPasswordFile != null) {
            description = "PostgreSQL auth updating Script";

            requires = [ "postgresql-setup.service" ];
            after = [ "postgresql-setup.service" ];
            wantedBy = [ "multi-user.target" ];

            serviceConfig = {
              User = "postgres";
              Group = "postgres";
              Type = "oneshot";
              RemainAfterExit = true;
              LoadCredential = "pgpass:${cfg.pgPasswordFile}";
            };

            script = ''
              # This script uses the provided password file and attaches it to the db user
              ${pkgs.postgresql}/bin/psql -U postgres -c 'ALTER DATABASE "${cfg.name}" OWNER TO "${cfg.user}";'
              ${pkgs.postgresql}/bin/psql -U postgres -c "ALTER USER \"${cfg.user}\" WITH PASSWORD '$(cat $CREDENTIALS_DIRECTORY/pgpass)';"
            '';
          };
      };
    };

  # ── Database Init Module (Migrations) ──────────────────────────────────
  flake.nixosModules.db-init = { config, lib, pkgs, ... }:
    let
      withHostSystem = withSystem pkgs.stdenv.hostPlatform.system;
      cfg = config.services.xinity-ai-db-init;
      dbCfg = config.services.xinity-ai-database;
    in {
      options.services.xinity-ai-db-init = {
        enable = lib.mkEnableOption "xinity-ai database migrations";

        databaseName = lib.mkOption {
          type = lib.types.str;
          default = dbCfg.name;
          description =
            "PostgreSQL database name (defaults to xinity-ai-database.name).";
        };

        databaseUser = lib.mkOption {
          type = lib.types.str;
          default = dbCfg.user;
          description =
            "PostgreSQL user (defaults to xinity-ai-database.user).";
        };

        migratePackage = lib.mkOption {
          type = lib.types.package;
          default =
            withHostSystem ({ config, ... }: config.packages.xinity-db-migrate);
          description = "The xinity-db-migrate package to use.";
        };
      };

      config = lib.mkIf cfg.enable {
        # Migration service - runs as postgres and grants privileges to database user
        systemd.services.xinity-db-migrate = {
          description = "Apply xinity-ai database migrations";
          after = [ "postgresql-setup.service" ]
            ++ lib.optional (dbCfg.pgPasswordFile != null)
            "postgresql-auth-setup.service";
          requires = [ "postgresql-setup.service" ];
          wantedBy = [ "multi-user.target" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            ExecStart = pkgs.writeShellScript "xinity-db-migrate-wrapper" ''
              set -e

              # Run migrations as postgres
              ${cfg.migratePackage}/bin/xinity-db-migrate

              # Grant all privileges on database objects to the target user
              ${pkgs.postgresql}/bin/psql -U postgres -d "${cfg.databaseName}" <<-EOF
                -- Grant privileges on the database
                GRANT ALL PRIVILEGES ON DATABASE "${cfg.databaseName}" TO "${cfg.databaseUser}";

                -- Grant privileges on the schema
                GRANT ALL PRIVILEGES ON SCHEMA public TO "${cfg.databaseUser}";
                GRANT ALL PRIVILEGES ON SCHEMA call_data TO "${cfg.databaseUser}";
                GRANT ALL PRIVILEGES ON SCHEMA drizzle TO "${cfg.databaseUser}";

                -- Grant privileges on all tables
                GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${cfg.databaseUser}";
                GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA call_data TO "${cfg.databaseUser}";
                GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA drizzle TO "${cfg.databaseUser}";

                -- Grant privileges on all sequences
                GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${cfg.databaseUser}";
                GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA call_data TO "${cfg.databaseUser}";
                GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA drizzle TO "${cfg.databaseUser}";

                -- Set default privileges for future objects
                ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO "${cfg.databaseUser}";
                ALTER DEFAULT PRIVILEGES IN SCHEMA call_data GRANT ALL PRIVILEGES ON SEQUENCES TO "${cfg.databaseUser}";
                ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle GRANT ALL PRIVILEGES ON SEQUENCES TO "${cfg.databaseUser}";
              EOF
            '';
            User = "postgres";
          };
          environment = {
            DB_CONNECTION_URL = "postgresql:///${cfg.databaseName}?host=/run/postgresql";
            DB_USER = cfg.databaseUser;  # Pass target user for reference
          };
        };
      };
    };
}
