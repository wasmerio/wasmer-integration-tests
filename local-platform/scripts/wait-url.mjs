#!/usr/bin/env node

const [url, timeoutMsArg = "120000"] = process.argv.slice(2);
const timeoutMs = Number(timeoutMsArg);
const started = Date.now();
let lastError = "not attempted";
let attempt = 0;
let lastProgressLogAt = 0;

if (!url || !Number.isFinite(timeoutMs)) {
  throw new Error("Usage: wait-url.mjs <url> [timeout-ms]");
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function truncate(value, maxLength = 160) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

const progressIntervalMs = 10000;
console.error(
  `[local-platform] waiting for ${url} (timeout ${formatDuration(timeoutMs)})`,
);

while (Date.now() - started < timeoutMs) {
  attempt += 1;
  try {
    const response = await fetch(url, { method: "GET" });
    const body = await response.text();
    if (response.status < 500) {
      const elapsed = formatDuration(Date.now() - started);
      if (response.status >= 200 && response.status < 400) {
        console.error(
          `[local-platform] ${url} responded with ${response.status}; treating service as ready after ${elapsed} and ${attempt} attempt(s)`,
        );
      } else {
        const outcome = response.headers.get("x-edge-request-outcome");
        const outcomeSuffix = outcome ? `, outcome=${outcome}` : "";
        const bodySuffix = body.trim()
          ? `, body=${JSON.stringify(truncate(body.trim()))}`
          : "";
        console.error(
          `[local-platform] ${url} responded with ${response.status}; treating service as ready because it is serving HTTP (non-5xx) after ${elapsed} and ${attempt} attempt(s)${outcomeSuffix}${bodySuffix}`,
        );
      }
      process.exit(0);
    }
    lastError = `${response.status} ${body}`;
  } catch (error) {
    lastError = String(error);
  }

  const now = Date.now();
  if (attempt === 1 || now - lastProgressLogAt >= progressIntervalMs) {
    lastProgressLogAt = now;
    console.error(
      `[local-platform] still waiting for ${url} after ${formatDuration(now - started)} (attempt ${attempt}, last error: ${lastError})`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));
}

throw new Error(
  `Timed out waiting for ${url} after ${formatDuration(Date.now() - started)}: ${lastError}`,
);
