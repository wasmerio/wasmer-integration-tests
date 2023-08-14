# Use a specific platform and base image
FROM --platform=linux/amd64 debian:stable-slim

ARG GITHUB_TOKEN

# Define environment variables for the GitHub repo details
ENV GITHUB_OWNER=wasmerio \
    GITHUB_REPO=edge \
    BINARY_NAME=wasmer-server

# Install dependencies.
RUN apt-get update \
    && apt-get install -y curl jq \
    && rm -rf /var/lib/apt/lists/*

COPY ./download-latest-release.sh /usr/local/bin/download-latest-release.sh
RUN export GITHUB_TOKEN=${GITHUB_TOKEN} && /usr/local/bin/download-latest-release.sh

# Copy configuration file to the container
COPY platform_config_local.yaml /host/platform_config_local.yaml

# Sanity check to make sure the server works.
RUN wasmer-server --help

# Define default command
CMD ["wasmer-server", "serve", "-c", "/app/platform_config.yaml"]
