#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const [manifestPath, endpoint] = process.argv.slice(2);

if (!manifestPath || !endpoint) {
  throw new Error(
    "Usage: persist-relay-queries.mjs <manifest.json> <endpoint>",
  );
}

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  throw new Error(`Failed to read Relay manifest ${manifestPath}: ${error}`);
}

if (!Array.isArray(manifest)) {
  throw new Error(`Relay manifest must be an array: ${manifestPath}`);
}

for (const entry of manifest) {
  if (!entry || typeof entry !== "object") {
    throw new Error(`Invalid Relay manifest entry in ${manifestPath}`);
  }

  const text = entry.text;
  if (typeof text !== "string" || text.length === 0) {
    continue;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to persist Relay query ${entry.name ?? entry.id ?? "<unknown>"}: ${response.status} ${body}`,
    );
  }
}

console.error(
  `[local-platform] Persisted Relay queries with text: ${manifest.filter((entry) => typeof entry?.text === "string" && entry.text.length > 0).length}`,
);
