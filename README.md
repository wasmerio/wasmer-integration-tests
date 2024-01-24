# edge-backend-integration-test
Integraiton tests between Edge and the backend

(To run a specific tag of the backend, set the `BACKEND_IMAGE_TAG` env var. Right now, Edge always runs the build from it's latest release).


## Setting up the project


```bash
git clone https://github.com/wasmerio/edge-backend-integration-test.git
cd edge-backend-integration-test
```

> [!NOTE]
> Make sure to add your token for the registry to `.env.dev` before running tests against dev server.

### unlock git-crypt secrets

Get the git-crypt key from 1password and store it  in a file called `git-crypt.key` in the root of the project.
(ask @ayys if you need access to it)
```bash
git-crypt unlock git-crypt.key
```


## How to run tests against the dev server?
```shell
make setup DEV=true  # setup things to run the tests; just `make DEV=true` will also work
make test DEV=true # run the tests on dev server
```

> [!CAUTION]
> `make setup DEV=true` changes the `wasmer.toml` and `app.yaml` files for packages in `packages/` directory.
> So running local tests right after running tests on dev breaks. To fix, run `make clear` before running local tests.

## How to run tests locally?
```shell
make setup
make test
```

config vars for dev and local are in `.env.dev` and `.env.local` respectively.


### Stopping the servers

```bash
make down
```
