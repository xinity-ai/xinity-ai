{
  # GPU support for a host: drivers, container passthrough, and the matching Ollama build.
  # Import exactly one of these (see the module list in ./host.nix), matching its cards.

  # Containers get the GPU through CDI:
  #   docker run --device=nvidia.com/gpu=all ...
  #   docker run --gpus all ...              (legacy flag, see systemd.services.docker.path)
  # The image supplies the CUDA userspace, so the container's CUDA version must be
  # supported by the driver version chosen here.
  flake.nixosModules.gpu-nvidia = {config, lib, pkgs, ...}: {
    nixpkgs.config.allowUnfree = true;

    # Required even on a headless machine: this does not pull in X, and the hardware.nvidia
    # options below are inert unless "nvidia" appears here.
    services.xserver.videoDrivers = [ "nvidia" ];

    hardware.graphics.enable = true;

    hardware.nvidia = {
      package = config.boot.kernelPackages.nvidiaPackages.stable;

      # false = proprietary kernel modules, works on every supported card.
      # Turing (RTX 20xx) and newer can use the open modules; Blackwell requires them.
      open = false;

      modesetting.enable = true;
      # Avoids the multi-second device init on every container start.
      nvidiaPersistenced = true;
      powerManagement.enable = false;
    };

    # Datacenter cards (A100, H100, L40S, ...) want the datacenter driver instead of
    # everything above: drop services.xserver.videoDrivers and hardware.nvidia, then set
    #   hardware.nvidia.datacenter.enable = true;
    #   hardware.nvidia.package = config.boot.kernelPackages.nvidiaPackages.dc;

    services.ollama.package = lib.mkDefault pkgs.ollama-cuda;

    hardware.nvidia-container-toolkit.enable = true;
    virtualisation.docker.daemon.settings.features.cdi = lib.mkDefault true;

    # dockerd resolves docker's own `--gpus` flag by looking for the toolkit hook on its
    # PATH. Without this only the CDI syntax works, which breaks third party compose files
    # and tools that hardcode `--gpus all`.
    systemd.services.docker.path = [
      (lib.getOutput "tools" config.hardware.nvidia-container-toolkit.package)
    ];

    environment.systemPackages = [ pkgs.nvtopPackages.nvidia ];
  };

  # There is no container toolkit equivalent for AMD: the host provides the amdgpu kernel
  # driver and the container gets the device nodes directly.
  #   docker run --device=/dev/kfd --device=/dev/dri --security-opt seccomp=unconfined ...
  # Both nodes are root owned, so root containers need no extra group; a container running
  # as a non-root user needs --group-add video --group-add render.
  # Consumer cards that ROCm does not list as supported usually still work by pretending to
  # be a supported one, via HSA_OVERRIDE_GFX_VERSION in the container's environment, or
  # services.ollama.rocmOverrideGfx for the native Ollama.
  flake.nixosModules.gpu-amd = {lib, pkgs, ...}: {
    hardware.amdgpu.initrd.enable = true;

    hardware.graphics.enable = true;
    hardware.amdgpu.opencl.enable = true;

    services.ollama.package = lib.mkDefault pkgs.ollama-rocm;

    environment.systemPackages = with pkgs; [
      rocmPackages.rocminfo
      rocmPackages.rocm-smi
      nvtopPackages.amd
    ];
  };
}
