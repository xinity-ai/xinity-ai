{
  perSystem =  { pkgs, self', inputs', ... }: {
    devShells.default = pkgs.mkShell {
      packages = [
        inputs'.agenix.packages.default
      ];
    };
  };
}