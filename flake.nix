{
  description = "Wasmer Integration Tests";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem
      (system:
        let
          pkgs = import nixpkgs {
            inherit system;
          };
        in
          with pkgs;
          {
            devShells.default = mkShell {
              buildInputs = [ deno ];
              shellHook = ''
                alias test-all='deno test --allow-all --parallel'
                echo "Run tests with: test-all"
              '';
            };
          }
      );
}
