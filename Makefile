all: pre-setup-checks setup


setup: up wait-for-edge wait-for-backend setup-wasmer install-fixtures
	@echo "both backend and edge are up, and wasmer is configured to use the local registry"
	@echo "Also, the test-app is deployed and ready to be used"
	@echo "You can now run 'make logs' to see the logs of the edge and backend"
	@echo "You can now run 'curl -H \"Host: test-app.wasmer.dev\" localhost:9080' to see the test-app running."

pre-setup-checks:
	@echo "Checking if docker is installed..."
	@docker --version
	@echo "Checking if docker-compose is installed..."
	@docker-compose --version
	@echo "Checking if wasmer is installed..."
	@wasmer --version
	@echo "Checking if GITHUB_TOKEN env var is setup..."
ifeq ($(GITHUB_TOKEN),)
	@echo "GITHUB_TOKEN is not set."
	exit 1
else
	@echo "GITHUB_TOKEN is set!"
endif


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
	cd packages/test-app && wasmer deploy --non-interactive --publish-package
	@echo "test-app deployed!"

	@echo "waiting for the first response from edge for test-app (this may take a while)..."
	curl -v -H "Host: test-app.wasmer.dev" localhost:9080

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
	@while ! curl -s http://localhost:8080/ > /dev/null; do \
		sleep 1; \
	done
	@echo "Backend is up!"


wait-for-edge:
	@echo "Waiting for edge to start..."
	@while ! nc -z localhost 9080; do sleep 1; done
	@echo "Edge started"


logs:
	docker-compose logs -f
