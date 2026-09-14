{inputs, self, ...}: {
  flake.nixosConfigurations.exampleHost1 =inputs.nixpkgs.lib.nixosSystem {
    modules = [
      # FILL IN pick the ../hardware sample matching this machine, then replace it with its real config
      ../hardware/qemu.nix
      {
        networking.hostName = "exampleHost1";

        # This indicates the first version with which the system was installd.
        # Used for things like figuring out what state requires migrations or any one off services.
        # Best policy: do not change it
        system.stateVersion = "26.05";
      }
      self.nixosModules.basis
      self.nixosModules.xinity-integration
      self.nixosModules.secrets
      # FILL IN / Uncomment the one matching this machine's cards to use its GPUs.
      # This is really only required when also running a daemon instance on the same node
      # self.nixosModules.gpu-nvidia
      # self.nixosModules.gpu-amd
    ];
  };

  # Some basic reasonable defaults are being set here. 
  # This is the right spot for any on demand customization
  flake.nixosModules.basis = {modulesPath, lib, pkgs, ... }: {
    imports = [
      (modulesPath + "/installer/scan/not-detected.nix")
    ];

    services.openssh.enable = true;
    environment.systemPackages = with pkgs; map lib.lowPrio [ 
      curl 
      git
      vim 
      nano
      bun
    ];

    virtualisation.oci-containers.backend = "docker";
    virtualisation.docker.enable = true;
    virtualisation.docker.autoPrune.enable = true;
    users.users.root.openssh.authorizedKeys.keys = [
      # FILL IN any keys that ought to have access to the machine
      "ssh-ed25519 AAAAC...."
    ];
  };
}