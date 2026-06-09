#!/usr/bin/env node

const [url, timeoutMsArg = "120000"] = process.argv.slice(2);
const timeoutMs = Number(timeoutMsArg);
const started = Date.now();
let lastError = "not attempted";

if (!url || !Number.isFinite(timeoutMs)) {
  throw new Error("Usage: wait-url.mjs <url> [timeout-ms]");
}

while (Date.now() - started < timeoutMs) {
  try {
    const response = await fetch(url, { method: "GET" });
    if (response.status < 500) {
      console.error(
        `[local-platform] ${url} is reachable (${response.status})`,
      );
      process.exit(0);
    }
    lastError = `${response.status} ${await response.text()}`;
  } catch (error) {
    lastError = String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

throw new Error(`Timed out waiting for ${url}: ${lastError}`);
