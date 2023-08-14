#!/usr/bin/env bash

set -Eeuxo pipefail

GITHUB_OWNER=wasmerio
GITHUB_REPO=edge
BINARY_NAME=wasmer-server

echo "Retrieving latest release metadata from Github API"

if [[ -z "$GITHUB_TOKEN" ]]; then
  echo "Required env var \$GITHUB_TOKEN is empty or not set"
  exit 1
fi

echo "token: $GITHUB_TOKEN"

RELEASE=$(curl -H "Authorization: token $GITHUB_TOKEN" -s "https://api.github.com/repos/wasmerio/edge/releases/latest")

echo "Release metadata: $RELEASE"

URL=$(echo "$RELEASE" | jq -r ".assets[] | select(.name | test(\"$BINARY_NAME\")) | .url")

if [[ -z "$URL" ]]; then
  echo "Could not find download link"
  exit 1
fi

echo "Downloading release from URL: $URL"

curl -H "Accept: application/octet-stream" -H "Authorization: token $GITHUB_TOKEN" -L --output "$BINARY_NAME" "$URL"

chmod +x "$BINARY_NAME"
mv "$BINARY_NAME" /usr/local/bin/

echo "Downloaded release"

