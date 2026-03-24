{
  perSystem = { pkgs, self', inputs', ... }:
    let
      bun2nix = inputs'.bun2nix.packages.default;
      bunDeps = self'.packages.xinity-ai-dependencies;
      pname = "xinity-ai-daemon";
    in {
      packages.xinity-ai-daemon = bun2nix.mkDerivation {
        inherit pname bunDeps;
        bunInstallFlags= [
          "--linker=isolated"
          "--filter=packages/common-db"
          "--filter=packages/xinity-ai-daemon"
        ];
        packageJson = ../../package.json;
        src = ../..;
        module = "packages/xinity-ai-daemon/src/index.ts";
      };
    };
}
