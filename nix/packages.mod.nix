{ self, ... }:
{
  perSystem = { pkgs, ... }:
    let
      releaseInfo = builtins.fromJSON (builtins.readFile "${self}/nix/release.json");

      releaseUrl = path:
        "https://github.com/xinity-ai/xinity-ai/releases/download/${releaseInfo.tag}/${path}";

      mkReleaseBundle = { pname }:
        let
          hash = releaseInfo.bundles.${pname}
            or (throw "packages.mod.nix: no bundle hash for ${pname} in nix/release.json");
        in
        pkgs.runCommand "${pname}-${releaseInfo.version}"
          {
            src = pkgs.fetchurl {
              url = releaseUrl "${pname}.js";
              inherit hash;
            };
            nativeBuildInputs = [ pkgs.makeWrapper ];
            passthru.bundle = pname;
            meta.mainProgram = pname;
          } ''
            install -Dm644 $src $out/share/${pname}/${pname}.js
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/${pname} \
              --add-flags "run $out/share/${pname}/${pname}.js"
          '';

      mkReleaseBinary = { pname, binaryName ? pname }:
        let
          archByNixSystem = {
            "x86_64-linux" = "linux-x64";
            "aarch64-linux" = "linux-arm64";
          };
          system = pkgs.stdenv.hostPlatform.system;
          arch = archByNixSystem.${system}
            or (throw "packages.mod.nix: ${pname} not published for ${system}");
          hash = releaseInfo.binaries.${pname}.${system}
            or (throw "packages.mod.nix: no binary hash for ${pname} on ${system} in nix/release.json");
        in
        pkgs.stdenv.mkDerivation {
          inherit pname;
          version = releaseInfo.version;
          src = pkgs.fetchurl {
            url = releaseUrl "${pname}-${arch}.tar.gz";
            inherit hash;
          };
          sourceRoot = ".";
          nativeBuildInputs = [ pkgs.autoPatchelfHook ];
          buildInputs = [ pkgs.stdenv.cc.cc.lib ];
          dontConfigure = true;
          dontBuild = true;
          dontStrip = true;
          installPhase = ''
            runHook preInstall
            install -Dm755 ${binaryName} $out/bin/${binaryName}
            runHook postInstall
          '';
          meta = {
            mainProgram = binaryName;
            platforms = builtins.attrNames archByNixSystem;
          };
        };
      # The catalog is data in this repo rather than a release asset, so it comes
      # from the pinned flake source. Only the model files are copied, so a README
      # edit does not rebuild it.
      modelCatalog = pkgs.runCommand "xinity-models-${releaseInfo.version}"
        {
          src = ../models;
          passthru.modelDir = true;
          meta.description = "Xinity model catalog, usable as services.xinity-infoserver.modelInfoDir";
        } ''
          mkdir -p $out
          find $src -maxdepth 1 \( -name '*.yaml' -o -name '*.yml' \) \
            -exec install -Dm644 {} $out/ \;
        '';
    in {
      packages = {
        xinity-models       = modelCatalog;
        xinity-ai-gateway   = mkReleaseBundle { pname = "xinity-ai-gateway"; };
        xinity-ai-daemon    = mkReleaseBundle { pname = "xinity-ai-daemon"; };
        xinity-infoserver   = mkReleaseBundle { pname = "xinity-infoserver"; };
        xinity-tether       = mkReleaseBundle { pname = "xinity-tether"; };
        xinity-ai-dashboard = mkReleaseBinary { pname = "xinity-ai-dashboard"; };
        xinity-cli          = mkReleaseBinary { pname = "xinity-cli"; binaryName = "xinity"; };
      };
    };
}
