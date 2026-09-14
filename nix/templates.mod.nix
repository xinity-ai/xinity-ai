{
  flake.templates.nixos-example = {
    path = ../deployment/nixos/example-flake;
    description = "Complete NixOS flake deploying the Xinity AI stack on a single host";
    welcomeText = ''
      # Xinity AI on NixOS

      1. `nix flake update xinity-ai`, as the bundled lock pins the revision this example was written against
      2. Work through the `FILL IN` markers, starting with the `hardware/` sample that `modules/host.nix` points at
      3. Provision secrets: `nix develop`, then `agenix -e <name>.age` from `secrets/` for every applicable entry in `secrets/secrets.nix`
      4. `nixos-rebuild --flake .#exampleHost1 --target-host <user@ip> test`

      Full walkthrough: https://github.com/xinity-ai/xinity-ai/blob/main/deployment/nixos/README.md
    '';
  };
}
