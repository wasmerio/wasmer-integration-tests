import {
  AppDefinition,
  EDGE_HEADER_JOURNAL_STATUS,
  EDGE_HEADER_PURGE_INSTANCES,
  randomAppName,
  sleep,
  TestEnv,
} from "../../src/index";
import { assert, assertEquals } from "../../src/testing_tools";

function buildPhpInstabootTimestampApp(): AppDefinition {
  const phpCode = `
<?php

error_reporting(E_ALL);
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');

function router() {
  $timestamp_path = '/tmp/timestamp.txt';
  $header_instaboot = 'HTTP_X_EDGE_INSTABOOT';

  // if instaboot header is set, create timestamp file
  if (isset($_SERVER[$header_instaboot])) {
    $timestamp = time();
    file_put_contents($timestamp_path, $timestamp);
  } else {
    // if timestamp file exists, return timestamp
    if (file_exists($timestamp_path)) {
      $timestamp = file_get_contents($timestamp_path);
      echo $timestamp;
    } else {
      echo 'NO_TIMESTAMP';
    }
  }
}

router();
        `;

  const spec: AppDefinition = {
    wasmerToml: {
      dependencies: {
        "php/php": "8.3.*",
      },
      fs: {
        "/src": "src",
      },
      command: [
        {
          name: "app",
          module: "php/php:php",
          runner: "https://webc.org/runner/wasi",
          annotations: {
            wasi: {
              "main-args": ["-S", "localhost:8080", "/src/index.php"],
            },
          },
        },
      ],
    },
    appYaml: {
      kind: "wasmer.io/App.v0",
      name: randomAppName(),
      package: ".",
      debug: true,
      capabilities: {
        instaboot: {
          requests: [{ path: "/" }],
        },
      },
    },
    files: {
      src: {
        "index.php": phpCode,
      },
    },
  };

  return spec;
}

/// Instaboot cache purge test.
///
/// Uses a PHP app that creates a timestamp file during instaboot, and
/// then returns that timestamp value in responses.
test.skip("app-cache-purge-instaboot-php", async () => {
  const env = TestEnv.fromEnv();

  const spec = buildPhpInstabootTimestampApp();

  // Deploy the app, but specify noWait to prevent the CLI from doing a first
  // request. That would mess with the later validation.
  const info = await env.deployApp(spec, { noWait: true });

  // The first request should not have a journal yet, so no timestamp should
  // be returned.
  {
    const res = await env.fetchApp(info, "/", {
      headers: {},
    });
    const body = await res.text();

    // No journal should have been created yet, so the status should be "none".
    assertEquals(res.headers.get(EDGE_HEADER_JOURNAL_STATUS), "none");
    assertEquals(body.trim(), "NO_TIMESTAMP");
  }

  // Now do a new request that should be served from a journal.
  // Must provide the purge header to ensure a new instance is created, otherwise
  // the old instance started without a journal would still  be active.
  {
    const res = await env.fetchApp(info, "/", {
      headers: {
        [EDGE_HEADER_PURGE_INSTANCES]: "1",
      },
    });
    const body = await res.text();

    // No journal should have been created yet, so the status should be "none".
    assertEquals(
      res.headers.get(EDGE_HEADER_JOURNAL_STATUS),
      "bootsrap=journal+memory",
    );
    // Body should be a timestamp.
    try {
      parseInt(body);
    } catch {
      throw new Error(`Expected body to be a timestamp, got: ${body}`);
    }
  }
});

/// Instaboot max_age test.
///
/// Ensures that the max_age config option is respected by Edge.
///
/// Uses a PHP app that creates a timestamp file during instaboot, and
/// then returns that timestamp value in responses.
///
test.skip("instaboot-max-age", async () => {
  const env = TestEnv.fromEnv();
  const spec = buildPhpInstabootTimestampApp();
  spec.appYaml.capabilities!.instaboot!.max_age = "5s";

  // No-wait to prevent the CLI from doing a first request which initialises
  // the timestamp.
  const info = await env.deployApp(spec, { noWait: true });

  const fetchApp = () =>
    env.fetchApp(info, "/", {
      headers: {
        [EDGE_HEADER_PURGE_INSTANCES]: "1",
      },
    });

  // First request - should be NO_TIMESTAMP
  {
    const res = await fetchApp();
    const body = await res.text();
    assertEquals(body.trim(), "NO_TIMESTAMP");
    assertEquals(res.headers.get(EDGE_HEADER_JOURNAL_STATUS), "none");
  }

  // Second request - should be a timestamp
  let initialTimestamp: number;
  {
    const res = await fetchApp();
    const body = await res.text();
    assertEquals(
      res.headers.get(EDGE_HEADER_JOURNAL_STATUS),
      "bootsrap=journal+memory",
    );
    try {
      initialTimestamp = parseInt(body);
    } catch {
      throw new Error(`Expected body to be a timestamp, got: ${body}`);
    }
  }

  // Now wait for the max_age to expire.
  console.log("Sleeping to wait for old journal to expire...");
  await sleep(6_000);

  // Request to trigger re-creation of the journal
  {
    await fetchApp();
    await fetchApp();
  }

  // Now the timestamp should be different.
  {
    const res = await fetchApp();
    const body = await res.text();
    assertEquals(
      res.headers.get(EDGE_HEADER_JOURNAL_STATUS),
      "bootsrap=journal+memory",
    );
    let newTimestamp: number;
    try {
      newTimestamp = parseInt(body);
    } catch {
      throw new Error(`Expected body to be a timestamp, got: "${body}"`);
    }

    console.log("Validating old vs new timestamp", {
      initialTimestamp,
      newTimestamp,
    });
    assert(newTimestamp > initialTimestamp);
  }
});
