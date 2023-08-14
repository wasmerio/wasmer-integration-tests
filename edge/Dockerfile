# Use a specific platform and base image
FROM --platform=linux/amd64 debian:stable-slim

# Define environment variables for the GitHub repo details
ENV GITHUB_OWNER=wasmerio \
    GITHUB_REPO=edge \
    BINARY_NAME=wasmer-server

# Install necessary utilities, fetch the binary, make it executable, and move it to a directory in PATH
RUN apt-get update \
    && apt-get install -y curl jq \
    && rm -rf /var/lib/apt/lists/* \
    && curl -H "Authorization: token $GITHUB_TOKEN" -s "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/releases/latest" | \
       jq -r ".assets[] | select(.name | test(\"$BINARY_NAME\")) | .url" | \
       xargs curl -H "Accept: application/octet-stream" -H "Authorization: token $GITHUB_TOKEN" -L --output "$BINARY_NAME" \
    && chmod +x "$BINARY_NAME" \
    && mv "$BINARY_NAME" /usr/local/bin

# Copy configuration file to the container
COPY platform_config_local.yaml /host/platform_config_local.yaml

# Define default command
CMD ["wasmer-server", "serve", "-c", "/app/platform_config.yaml"]

# Use build arguments for sensitive information
ARG GITHUB_TOKEN
