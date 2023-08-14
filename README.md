# edge-backend-integration-test
Integraiton tests between Edge and the backend


## Setting up the project


```bash
git clone https://github.com/wasmerio/edge-backend-integration-test.git
cd edge-backend-integration-test
```

### unlock git-crypt secrets

Get the git-crypt key from 1password and store it  in a file called `git-crypt.key` in the root of the project.
(ask @ayys if you need access to it)
```bash
git-crypt unlock git-crypt.key
```


### Run setup target
```bash
make # this will setup everything to get you ready to run pytest
```


### Install and setup pytest

```bash
# Make sure you have python3 installed (^3.10)
# Make sure you have poetry installed
(https://python-poetry.org/docs/#installation)
poetry install
```

Finally, you can run the pytest tests with:
```bash
make test  # make sure docker-compose is running
```


### Stopping the servers

```bash
make down
```
