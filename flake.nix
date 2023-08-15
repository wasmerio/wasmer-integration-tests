{
  description = "wasmer-integration-tests";

  inputs = {
    flakeutils = {
      url = "github:numtide/flake-utils";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flakeutils }:
    flakeutils.lib.eachDefaultSystem (system:
      let
        NAME = "wasmer-integration-tests";
        VERSION = "0.1";

        pkgs = import nixpkgs {
          inherit system;
        };

      in
      rec {

        # packages.${NAME} = pkgs.stdenv.mkDerivation {
        #   pname = NAME;
        #   version = VERSION;

        #   buildPhase = "echo 'no-build'";
        # };

        # defaultPackage = packages.${NAME};

        # # For `nix run`.
        # apps.${NAME} = flakeutils.lib.mkApp {
        #   drv = packages.${NAME};
        # };
        # defaultApp = apps.${NAME};

        devShell = pkgs.stdenv.mkDerivation {
          name = NAME;
          src = self;
          buildInputs = with pkgs; [
            python3
            # Python package manager.
            poetry
            # Python shell.
            python3Packages.ipython
            # Python formatter.
            black
            # Python LSP server for editors.
            pyright
          ];
          runtimeDependencies = with pkgs; [ ];
        };
      }
    );
}
