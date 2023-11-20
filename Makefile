all: setup

test:
	poetry run -- pytest tests -vv

setup: pre-setup-checks install-python-depenencies up wait-for-edge wait-for-backend setup-wasmer 
	@echo "both backend and edge are up, and wasmer is configured to use the local registry"
	@echo "Also, the test-app is deployed and ready to be used"
	@echo "You can now run 'make logs' to see the logs of the edge and backend"
	@echo "You can now run 'curl -H \"Host: test-app.wasmer.app\" localhost:80' to see the test-app running."

pre-setup-checks:
	@echo "Checking if docker is installed..."
	@docker --version
	@echo "Checking if docker-compose is installed..."
	@docker-compose --version
	@echo "Checking if wasmer is installed..."
	@wasmer --version

install-python-depenencies:
	@echo "Installing python dependencies..."
	poetry install

setup-wasmer:
	@echo "Setting up wasmer to use the local registry"
	@wasmer config set registry.url http://localhost:8080
	@wasmer login "wap_default_token"
	@wasmer whoami

install-fixtures:
	@echo "publishing static-web-server..."
	cd packages/static-web-server && wasmer publish || true
	@echo "setup static-web-server complete"

	@echo "publishing test-app..."
	cd packages/test-app && cp app.yaml.sample app.yaml && (wasmer deploy --non-interactive --publish-package --no-wait || true)
	@echo "test-app deployed!"

	@echo "waiting for the first response from edge for test-app (this may take a while)..."
	
	export counter=0; \
	export max_attempts=3; \
	until curl -vvv -f -H "Host: test-app.wasmer.app" 127.0.0.1:80; do \
		[[ $$counter -eq $%max_attempts ]] && echo "test app failed"; exit 1; \
		counter=$$((counter+1)); \
	done;

	@echo "publishing wasix-echo-server..."
	cd packages/wasix-echo-server && cp app.yaml.sample app.yaml && (wasmer deploy -v --non-interactive --publish-package --no-wait || true)
	@echo "wasix-echo-server deployed!"


	@echo "waiting for the first response from edge for test-app (this may take a while)..."
	export counter=0; \
	export max_attempts=3; \
	until curl -vvv -f -H "Host: wasix-echo-server.wasmer.app" 127.0.0.1:80; do \
		[[ $$counter -eq $%max_attempts ]] && echo "test app failed"; exit 1; \
		counter=$$((counter+1)); \
	done;

run:
	docker-compose up


up:
	docker-compose up -d

down:
	docker-compose down


wait-for-backend:
	@echo "Waiting for backend to start..."
	@while ! nc -z localhost 8080; do sleep 1; done
	@echo "Waiting for backend to start accepting queries (this may take a while)..."
	@echo "You can run 'make logs' to see the logs of the edge and backend"
	@while ! curl -fs http://localhost:8080 --max-time 10 > /dev/null; do sleep 1; done # connect-timeout is needed, because when backend starts, first curl request gets stuck
	@echo "Backend is up!"


wait-for-edge:
	@echo "Waiting for edge to start..."
	@while ! nc -z localhost 80; do sleep 1; done
	@echo "Edge started"


logs:
	docker-compose logs -f

format:
	poetry run black -- ./tests

# Alias for format
fmt: format
