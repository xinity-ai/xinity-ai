# Since the secrets are encrypted they are safe to version in a git repository, 
# but care should be taken with the ssh keys used to access these. A passphrase is strongly recommended.

let
  # FILL IN
  # User keys (people allowed to encrypt/edit secrets).
  # Paste your pubblic ssh key(s) here. 
  exampleUser1 = "ssh-ed25519 AAAAC...HOB5 example1@workstation"; 
  exampleUser2 = "ssh-ed25519 AAAAC...HOB5 example2@workstation";
  users = [ exampleUser1 exampleUser2];

  # FILL IN
  # Host keys (machines allowed to decrypt secrets at boot).
  # Get this from /etc/ssh/ssh_host_ed25519_key.pub on the server where the configuration should live. For applying on multiple servers, add more keys
  # (or: ssh-keyscan <target-host> | grep ssh-ed25519).
  exampleHost1 = "ssh-ed25519 AAAAC3...dR4N target-host";
  hosts = [ exampleHost1 ];
  recipients = users ++ hosts;
in
{

  # Options that must be set

  # Bundled shared env to contain various settings all at once. See exampleSharedEnv.env
  "sharedEnv.age".publicKeys = recipients;
  "pgPassword.age".publicKeys = recipients;
  "tetherSecret.age".publicKeys = recipients;
  "prometheusPass.age".publicKeys = recipients;
  "metricsAuth.age".publicKeys = recipients;
  "betterAuthSecret.age".publicKeys = recipients;

  # Optional secrets / add ons
  "licenseKey.age".publicKeys = recipients;
  "redisPassword.age".publicKeys = recipients;
  "s3AccessKeyId.age".publicKeys = recipients;
  "s3SecretAccessKey.age".publicKeys = recipients;
}