{
  perSystem = { pkgs, self', inputs', ... }:
    let
      bun2nix = inputs'.bun2nix.packages.default;
    in {
      packages.xinity-ai-dependencies = bun2nix.fetchBunDeps { bunNix = ../bun.nix; };
    };
}
