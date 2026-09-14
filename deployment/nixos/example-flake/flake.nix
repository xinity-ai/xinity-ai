{
  description = "Example NixOS deployment of the Xinity AI stack";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-26.05";
    # flake-parts for easier and consistent nix modules
    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-parts.inputs.nixpkgs-lib.follows = "nixpkgs";
    xinity-ai.url = "github:xinity-ai/xinity-ai";
    xinity-ai.inputs.nixpkgs.follows = "nixpkgs";
    xinity-ai.inputs.flake-parts.follows = "flake-parts";
    agenix.url = "github:ryantm/agenix";
    agenix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" ];
      imports = [
        # To import an internal flake module: ./other.nix
        ./modules
      ];
    };
}
