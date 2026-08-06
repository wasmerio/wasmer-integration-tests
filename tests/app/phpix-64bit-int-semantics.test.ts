import * as fs from "node:fs";
import path from "node:path";

import { AppInfo, randomAppName, TestEnv } from "../../src";
import type { AppDefinition } from "../../src/app/construct";
import { projectRoot } from "../utils/path";

// Repro for ECO-426 — the phpix 0.3.0-rc.4 64-bit build folds unary negation
// to float: https://linear.app/wasmer/issue/ECO-426
//
//   gettype(1)     => "integer"     gettype(-1)  => "double"   <-- wrong
//   gettype(0 - 1) => "integer"     gettype(-$x) => "double"   <-- wrong
//
// So any `int`-typed parameter with a negative default stops compiling, and
// integer-only builtins reject negated values. Real code is full of both:
//
//   Cannot use float as default value for parameter $lineno of type int (twig)
//   Cannot use float as default value for parameter $limit of type int  (gla)
//   array_slice(): Argument #2 ($offset) must be of type int, float given
//
// It reached prod on 2026-08-05 09:20:16Z, when the Edge package override
// moved from 0.2.2 to 0.3.0-rc.4 — that override rewrites the phpix package
// for every app at instance start, so ~2,500 apps changed engine with no
// deploy of their own, and 109 of them started 500ing the same day. Verified
// locally against the packages: 0.2.2 and 0.3.0-rc.3 (same PHP 8.3.31) are
// correct, rc.4 is not, and only the 64-bit builds are affected.
//
// `repros/ECO-426-phpix-64bit-int-typing.sh` is the fast local version of the
// same probe. This test covers the deployed path: the app requests the phpix
// package the way production apps do, so the override decides which build
// serves it. No version is hardcoded — the test is red while the fleet-wide
// pin points at a broken build and green once it is rolled back or fixed.

const FIXTURE_DIR = path.join(projectRoot, "fixtures", "php");

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

interface ProbeResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface IntSemanticsReport {
  php_version: string;
  php_int_size: number;
  php_int_max: string;
  php_int_max_is_int: boolean;
  positive_literal_type: string;
  negative_literal_type: string;
  negated_variable_type: string;
  subtraction_type: string;
  negated_constant_type: string;
  terabyte_is_int: boolean;
  terabyte_value: string;
  intdiv: ProbeResult;
  array_slice: ProbeResult;
  substr: ProbeResult;
}

// A phpix app in the shape production uses: the engine is a package
// dependency and the docroot is served with `-S <addr> -t <docroot>`.
function buildPhpixApp(bits: 32 | 64): AppDefinition {
  const pkg = `phpix/phpix-83-${bits}bit`;
  return {
    wasmerToml: {
      dependencies: {
        // Any selector resolves to whatever the Edge package override serves.
        [pkg]: "*",
      },
      fs: {
        "/src": "src",
      },
      command: [
        {
          name: "app",
          module: `${pkg}:phpix`,
          runner: "https://webc.org/runner/wasi",
          annotations: {
            wasi: {
              "main-args": ["-S", "localhost:8080", "-t", "/src"],
            },
          },
        },
      ],
    },
    appYaml: {
      kind: "wasmer.io/App.v0",
      name: randomAppName(),
      package: ".",
    },
    files: {
      src: {
        "index.php": fixture("int-semantics-report.php"),
        "int-default-negative-literal.php": fixture(
          "int-default-negative-literal.php",
        ),
        "int-default-64bit-literal.php": fixture(
          "int-default-64bit-literal.php",
        ),
      },
    },
  };
}

async function fetchReport(
  env: TestEnv,
  app: AppInfo,
): Promise<IntSemanticsReport> {
  const response = await env.fetchApp(app, "/index.php", { forceWait: true });
  expect(response.status).toBe(200);
  return (await response.json()) as IntSemanticsReport;
}

// Compile-time probes: a file whose *parse* fails cannot report anything, so
// the assertion is on the response itself. Request the real file path, never
// a clean URL — phpix 404s extension-less paths (ECO-419).
async function fetchProbe(
  env: TestEnv,
  app: AppInfo,
  file: string,
): Promise<string> {
  const response = await env.fetchApp(app, `/${file}`, {
    forceWait: true,
    noAssertSuccess: true,
  });
  return await response.text();
}

jest.setTimeout(600_000);

describe("ECO-426 phpix integer semantics", () => {
  test("64-bit phpix types negated integers as int", async () => {
    const env = TestEnv.fromEnv();
    const app = await env.deployApp(buildPhpixApp(64));

    try {
      const report = await fetchReport(env, app);
      console.info(
        `64-bit app served by PHP ${report.php_version} (PHP_INT_SIZE=${report.php_int_size})`,
      );

      // Sanity: we really are on the 64-bit engine. If this fails the app
      // resolved the wrong atom and the rest of the test proves nothing.
      expect(report.php_int_size).toBe(8);
      expect(report.php_int_max).toBe("9223372036854775807");
      expect(report.php_int_max_is_int).toBe(true);

      // ECO-426: negation must not turn an int into a float.
      expect(report.positive_literal_type).toBe("integer");
      expect(report.negative_literal_type).toBe("integer");
      expect(report.negated_variable_type).toBe("integer");
      expect(report.negated_constant_type).toBe("integer");
      expect(report.subtraction_type).toBe("integer");

      // Values in the 64-bit range stay int, and integer-only builtins accept
      // a negated offset — the calls that killed WooCommerce in prod.
      expect(report.terabyte_is_int).toBe(true);
      expect(report.terabyte_value).toBe("1099511627776");
      expect(report.intdiv).toMatchObject({ ok: true, value: 1024 });
      expect(report.array_slice).toMatchObject({ ok: true, value: [3] });
      expect(report.substr).toMatchObject({ ok: true, value: "f" });

      // Compile-time: an `int` parameter must accept a negative default, and
      // on a 64-bit build a literal spanning the full int range.
      expect(await fetchProbe(env, app, "int-default-negative-literal.php")).toContain(
        "negative-literal-ok:-1",
      );
      expect(await fetchProbe(env, app, "int-default-64bit-literal.php")).toContain(
        "large-literal-ok:9223372036854775807",
      );
    } finally {
      await env.deleteApp(app);
    }
  });

  // Control: the 32-bit builds of the same release are healthy, which is what
  // keeps the blast radius to 64-bit apps. Only invariants that hold on a
  // 32-bit build are asserted — 2^40 is legitimately a float there.
  test("32-bit phpix is unaffected", async () => {
    const env = TestEnv.fromEnv();
    const app = await env.deployApp(buildPhpixApp(32));

    try {
      const report = await fetchReport(env, app);
      console.info(
        `32-bit app served by PHP ${report.php_version} (PHP_INT_SIZE=${report.php_int_size})`,
      );

      expect(report.php_int_size).toBe(4);
      expect(report.php_int_max).toBe("2147483647");
      expect(report.negative_literal_type).toBe("integer");
      expect(report.negated_variable_type).toBe("integer");

      expect(await fetchProbe(env, app, "int-default-negative-literal.php")).toContain(
        "negative-literal-ok:-1",
      );
    } finally {
      await env.deleteApp(app);
    }
  });
});
