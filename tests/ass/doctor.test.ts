// `ass doctor` tests (Phase 3): every toolchain probe is faked at its process
// boundary, so the capability table is deterministic and says the same thing
// on a developer laptop, in CI, and in a container.

import {
  formatDoctor,
  parseVersion,
  runDoctor,
} from "../../ass/bootstrap/doctor";
import type { Probe } from "../../ass/bootstrap/doctor";
import { cli, makeRoot } from "./helpers";

/** Everything present and current. */
const HEALTHY: Record<string, { status: number; stdout: string }> = {
  pnpm: { status: 0, stdout: "10.4.1\n" },
  python3: { status: 0, stdout: "Python 3.12.7\n" },
  docker: { status: 0, stdout: "Docker Compose version v2.29.7\n" },
  gh: { status: 0, stdout: "Logged in to github.com\n" },
  wasmer: { status: 0, stdout: "wasmer 6.1.0\n" },
  go: { status: 0, stdout: "go version go1.23.4 linux/amd64\n" },
  cargo: { status: 0, stdout: "cargo 1.83.0\n" },
  nix: { status: 127, stdout: "" },
  "apt-get": { status: 127, stdout: "" },
};

function probeWith(
  overrides: Record<string, { status: number; stdout: string }> = {},
): Probe {
  const table = { ...HEALTHY, ...overrides };
  return (argv) => table[argv[0]] ?? { status: 127, stdout: "" };
}

function doctor(
  overrides: Record<string, { status: number; stdout: string }> = {},
  extra: { nodeVersion?: string; exists?: () => boolean } = {},
) {
  return runDoctor({
    cwd: "/repo",
    probe: probeWith(overrides),
    nodeVersion: extra.nodeVersion ?? "v22.14.0",
    exists: extra.exists ?? (() => true),
    platform: "linux",
  });
}

function capability(report: ReturnType<typeof doctor>, name: string) {
  const found = report.capabilities.find((c) => c.name.startsWith(name));
  expect(found).toBeDefined();
  return found!;
}

describe("version parsing", () => {
  test.each([
    ["v22.14.0", [22, 14, 0]],
    ["Python 3.12.7", [3, 12, 7]],
    ["Docker Compose version v2.29.7", [2, 29, 7]],
    ["go version go1.23.4 linux/amd64", [1, 23, 4]],
  ])("%s", (text, expected) => {
    expect(parseVersion(text)).toEqual(expected);
  });

  test("a banner without a version reads as unknown", () => {
    expect(parseVersion("command not found")).toBeNull();
  });
});

describe("capability table", () => {
  test("a fully provisioned machine is ready", () => {
    const report = doctor();
    expect(report.ok).toBe(true);
    expect(report.capabilities.every((c) => c.ok)).toBe(true);
    expect(formatDoctor(report).at(-1)).toBe("ready");
  });

  test("Docker absent removes the local target and nothing else", () => {
    const report = doctor({ docker: { status: 127, stdout: "" } });
    // Optional: the harness still works, so doctor does not fail the machine.
    expect(report.ok).toBe(true);
    const compose = capability(report, "docker compose");
    expect(compose.ok).toBe(false);
    expect(compose.required).toBe(false);
    // R4-03: local is the only target the engine runs today, so the degrade
    // must not imply a remote fallback that has not landed.
    expect(compose.degrades).toContain("every target ass can currently run");
    expect(compose.degrades).not.toContain("remote targets stay usable");
    const rendered = formatDoctor(report).join("\n");
    expect(rendered).toContain("unavailable: local-target runs");
    expect(rendered).toContain("fix: install Docker Engine");
    expect(rendered).toContain("1 capability degraded");
  });

  test("compose v1 does not pass as compose v2", () => {
    const report = doctor({
      docker: { status: 0, stdout: "docker-compose version 1.29.2\n" },
    });
    expect(capability(report, "docker compose").ok).toBe(false);
  });

  test("a missing Node or pnpm fails with remediation", () => {
    const oldNode = doctor({}, { nodeVersion: "v20.11.1" });
    expect(oldNode.ok).toBe(false);
    expect(capability(oldNode, "node").remediation).toContain("22");
    expect(formatDoctor(oldNode).at(-1)).toContain("missing required: node");

    const noPnpm = doctor({ pnpm: { status: 127, stdout: "" } });
    expect(noPnpm.ok).toBe(false);
    expect(capability(noPnpm, "pnpm").remediation).toContain("corepack");
  });

  test("uninstalled dependencies are a required failure", () => {
    const report = doctor({}, { exists: () => false });
    expect(report.ok).toBe(false);
    expect(capability(report, "dependencies").remediation).toContain(
      "make setup",
    );
  });

  test("a missing baseline engine costs only its own baseline (D10)", () => {
    const report = doctor({ go: { status: 127, stdout: "" } });
    expect(report.ok).toBe(true);
    expect(capability(report, "baseline engine: go").degrades).toContain(
      "engine: go",
    );
  });

  test("remediation follows the machine: nix is preferred when present", () => {
    const nixed = doctor({ nix: { status: 0, stdout: "nix 2.24.9\n" } });
    expect(capability(nixed, "node").remediation).toContain("nix develop");
  });
});

describe("ass doctor through the CLI", () => {
  test("exits 0 when ready and 1 when a required capability is missing", async () => {
    const root = makeRoot();
    const ready = await cli(root, ["doctor"], undefined, {
      probe: probeWith(),
      nodeVersion: "v22.14.0",
      exists: () => true,
      platform: "linux",
    });
    expect(ready.code).toBe(0);
    expect(ready.stdout).toContain("ready");

    const broken = await cli(root, ["doctor"], undefined, {
      probe: probeWith({ pnpm: { status: 127, stdout: "" } }),
      nodeVersion: "v22.14.0",
      exists: () => true,
      platform: "linux",
    });
    expect(broken.code).toBe(1);
    expect(broken.stdout).toContain("missing required: pnpm");
  });
});
