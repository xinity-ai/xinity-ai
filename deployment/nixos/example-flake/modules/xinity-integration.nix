{inputs, ...}:
{
  flake.nixosModules.xinity-integration = {config, lib, ...}: {
    imports = with inputs.xinity-ai.nixosModules; [ 
      allinone
    ];

    services.xinity-ai = {
      enable = true;
      # FILL IN the domain these services are reached at, and the address ACME registers
      domain = "example.com";
      acmeEmail = "admin@example.com";
      database.pgPasswordFile =
        config.age.secrets.pgPassword.path or "/etc/xinity/pg.key";
      listenMode = "local";
      redis.redisPasswordFile = config.age.secrets.redisPassword.path or null;

      gateway.backendTimeoutMs = 3000000;
      infoserver.modelInfoDir = ../models;
      environmentFiles =
        lib.optional (config.age.secrets ? sharedEnv) config.age.secrets.sharedEnv.path;

      # Needed once inference nodes run on other machines, as Caddy does not front the tether
      # tether.openFirewall = true;

      monitoring = {
        enable = true;
        basicAuthUsername = "superuser";
        basicAuthPasswordFile = config.age.secrets.prometheusPass.path or null;
      };

      secrets = {
        licenseKeyFile = config.age.secrets.licenseKey.path or null;
        betterAuthSecretFile = config.age.secrets.betterAuthSecret.path or null;
        tetherSecretFile = config.age.secrets.tetherSecret.path or null;
        metricsAuthFile = config.age.secrets.metricsAuth.path or null;
        s3AccessKeyIdFile = config.age.secrets.s3AccessKeyId.path or null;
        s3SecretAccessKeyFile =
          config.age.secrets.s3SecretAccessKey.path or null;
      };
    };

    services.xinity-ai-daemon = {
      enable = true;
      vllmBackend= "docker";
      vllmDockerImage = "vllm/vllm-openai:latest";
    };

    # services.xinity-ai-dashboard.extraEnvironment.TRUSTED_ORIGINS = "https://sso-domain.example.com";

    # Potential extra rules for allowing outside nodes to access the pg db from specific port ranges
    # services.postgresql.enableTCPIP = true;
    # services.postgresql.authentication = ''
    #   host    all    all    10.100.0.0/24    scram-sha-256
    # '';
    
  };
}