{ inputs, ... }: {
  # Including this module is enough to load all secrets that have been set in the secrets directory, and make them usable
  flake.nixosModules.secrets = { pkgs, lib, ... }:
    let
      # Readable by the xinity-ai service containers (UID/GID 6000).
      forXinityServices = file: {
        inherit file;
        owner = "6000";
        group = "6000";
        mode = "0400";
      };

      # Readable by root only — fine for systemd LoadCredential (postgres-auth-setup).
      forRoot = file: { inherit file; };

      # Readable by a specific system user/group (e.g. redis).
      forUser = user: file: {
        inherit file;
        owner = user;
        group = user;
        mode = "0400";
      };

      # Only declare a secret if its .age file exists on disk. Lets you
      # add new secrets one at a time (encrypt → rebuild) without flake
      # eval failures from missing paths.
      declareIfExists = name: spec:
        lib.optionalAttrs (builtins.pathExists spec.file) { ${name} = spec; };
    in {
      imports = [ inputs.agenix.nixosModules.default ];

      environment.systemPackages =
        [ inputs.agenix.packages.${pkgs.stdenv.hostPlatform.system}.default ];

      age.secrets = declareIfExists "licenseKey" (forXinityServices ../secrets/licenseKey.age)
        // declareIfExists "betterAuthSecret" (forXinityServices ../secrets/betterAuthSecret.age)
        // declareIfExists "metricsAuth" (forXinityServices ../secrets/metricsAuth.age)
        // declareIfExists "s3AccessKeyId" (forXinityServices ../secrets/s3AccessKeyId.age)
        // declareIfExists "s3SecretAccessKey" (forXinityServices ../secrets/s3SecretAccessKey.age)
        // declareIfExists "sharedEnv" (forXinityServices ../secrets/sharedEnv.age)
        // declareIfExists "tetherSecret" (forRoot ../secrets/tetherSecret.age)
        // declareIfExists "redisPassword" (forUser "redis-xinity" ../secrets/redisPassword.age)
        // declareIfExists "pgPassword" (forRoot ../secrets/pgPassword.age)
        // declareIfExists "prometheusPass" (forUser "prometheus" ../secrets/prometheusPass.age);
    };
}
