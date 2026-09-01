# Media object storage, shared by the gateway that writes it and the dashboard that serves it back.
# Both must point at the same bucket, so the options are defined once and imported by each module
# under its own `services.*` path.
{ lib }:

{
  s3Endpoint = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    default = null;
    description = "URL of the SeaweedFS or S3-compatible object storage endpoint, used for media attached to conversations. Without it the database carries the bytes itself.";
  };

  s3AccessKeyId = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    default = null;
    description = ''
      S3 access key ID.
      WARNING: DO NOT USE IN PRODUCTION. Set S3_ACCESS_KEY_ID through environmentFiles, or use s3AccessKeyIdFile, to keep credentials secure.
      This option exposes secrets in the Nix store.
    '';
  };

  s3SecretAccessKey = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    default = null;
    description = ''
      S3 secret access key.
      WARNING: DO NOT USE IN PRODUCTION. Set S3_SECRET_ACCESS_KEY through environmentFiles, or use s3SecretAccessKeyFile, to keep credentials secure.
      This option exposes secrets in the Nix store.
    '';
  };

  s3Bucket = lib.mkOption {
    type = lib.types.str;
    default = "xinity-media";
    description = "S3 bucket name used for media objects attached to conversations.";
  };

  s3Region = lib.mkOption {
    type = lib.types.str;
    default = "us-east-1";
    description = "S3 region for the object storage endpoint. For SeaweedFS or MinIO, the conventional value is 'us-east-1'.";
  };
}
