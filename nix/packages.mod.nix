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
            url = releaseUrl "${pname}-${arch}.zip";
            inherit hash;
          };
          nativeBuildInputs = [ pkgs.unzip pkgs.autoPatchelfHook ];
          buildInputs = [ pkgs.stdenv.cc.cc.lib ];
          unpackPhase = ''
            runHook preUnpack
            unzip -q $src
            runHook postUnpack
          '';
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
    in {
      packages = {
        xinity-ai-gateway   = mkReleaseBundle { pname = "xinity-ai-gateway"; };
        xinity-ai-daemon    = mkReleaseBundle { pname = "xinity-ai-daemon"; };
        xinity-infoserver   = mkReleaseBundle { pname = "xinity-infoserver"; };
        xinity-ai-dashboard = mkReleaseBinary { pname = "xinity-ai-dashboard"; };
        xinity-cli          = mkReleaseBinary { pname = "xinity-cli"; binaryName = "xinity"; };
      };
    };
}
