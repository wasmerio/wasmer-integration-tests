all: setup

test:
	poetry run -- pytest tests -vv

setup: pre-setup-checks install-python-depenencies up wait-for-edge wait-for-backend setup-wasmer install-fixtures
	@echo "both backend and edge are up, and wasmer is configured to use the local registry"
	@echo "Also, the test-app is deployed and ready to be used"
	@echo "You can now run 'make logs' to see the logs from Edge and the backend"
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
	@wasmer config set registry.url http://localhost:8080/graphql
	@wasmer login "wap_default_token"
	@wasmer whoami

install-static-web-server:
	@echo "publishing static-web-server..."
	@(cd packages/static-web-server && \
	  wasmer publish --wait --timeout 300s --registry "http://localhost:8080/graphql"  || true)
	@echo "setup static-web-server complete"

install-test-app: install-static-web-server
	@echo "publishing test-app..."
	@(cd packages/test-app && \
	  wasmer publish --wait --timeout 300s --registry "http://localhost:8080/graphql" || true)

	@echo "deploying test-app..."
	@(cd packages/test-app && \
	  cp app.yaml.sample app.yaml && \
	  wasmer deploy --non-interactive --no-wait --registry "http://localhost:8080/graphql" || true)
	@echo "test-app deployed!"

	@echo "waiting for the first response from edge for test-app (this may take a while)..."
	@curl --retry 3 --retry-all-errors -vvv -f -H "Host: test-app.wasmer.app" 127.0.0.1:80
	@echo "test-app is up!"

install-wasix-echo-server: install-static-web-server
	@echo "publishing wasix-echo-server..."
	@(cd packages/wasix-echo-server && \
	  wasmer publish --wait --timeout 600s --registry "http://localhost:8080/graphql" || true)

	@echo "deploying wasix-echo-server..."
	@(cd packages/wasix-echo-server && \
	  cp app.yaml.sample app.yaml && \
	  wasmer deploy -v --non-interactive --no-wait --registry "http://localhost:8080/graphql" || true)
	@echo "wasix-echo-server deployed!"

	@echo "waiting for the first response from edge for test-app (this may take a while)..."
	@curl --retry 3 --retry-all-errors -vvv -f -H "Host: wasix-echo-server.wasmer.app" 127.0.0.1:80
	@echo "wasix-echo-server is up!"

install-fixtures: install-test-app install-wasix-echo-server

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
