{lib, self,...}: {
  perSystem = { pkgs, self', inputs', ... }:
    {
      packages.options-doc = let
        nixosStub = ({ lib, ... }: {
              options = {
                assertions = lib.mkOption {
                  type = lib.types.listOf lib.types.unspecified;
                  default = [];
                  internal = true;
                };
                systemd = lib.mkOption {
                  type = lib.types.attrsOf lib.types.unspecified;
                  default = {};
                  internal = true;
                };
                virtualisation.oci-containers.containers = lib.mkOption {
                  type = lib.types.attrsOf lib.types.unspecified;
                  default = {};
                  internal = true;
                };
                networking = lib.mkOption {
                  type = lib.types.attrsOf lib.types.unspecified;
                  default = {};
                  internal = true;
                };
                # External NixOS services our modules configure
                services.caddy = lib.mkOption { type = lib.types.unspecified; default = {}; internal = true; };
                services.postgresql = lib.mkOption { type = lib.types.unspecified; default = {}; internal = true; };
                services.redis = lib.mkOption { type = lib.types.unspecified; default = {}; internal = true; };
                services.searx = lib.mkOption { type = lib.types.unspecified; default = {}; internal = true; };
                services.ollama = lib.mkOption { type = lib.types.unspecified; default = {}; internal = true; };
              };
            });
        eval = lib.evalModules {
          specialArgs = { inherit pkgs self; inherit (self) inputs; withSystem = _: _: {}; };
          modules = with self.nixosModules; [
            gateway
            dashboard
            database
            daemon
            infoserver
            # caddy
            # searxng
            # allinone
            # seaweedfs
            # server
            nixosStub
          ];
        };
        optionsDoc = pkgs.nixosOptionsDoc {
          options = builtins.removeAttrs eval.options [ "_module" ];
          transformOptions = opt: opt // {
            declarations = builtins.filter (d: lib.hasPrefix "xinity" (toString d)) opt.declarations;
          };
        };
      in optionsDoc.optionsJSON;
    };
}
