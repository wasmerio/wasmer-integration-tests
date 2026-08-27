import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as pathModule from "node:path";

import { projectRoot } from "../utils/path";
import { SELF_TEST_CHECKS } from "../utils/fixture-contract";

// Runs the Node fixture the way Edge runs it: several instances sharing one
// /data volume. The durable-counter checks are the only part of /self-test
// that touches shared state, and a read-modify-write that is atomic only
// in-process silently corrupts the counter file for every other instance.
//
// Deploys nothing and needs no platform, so it runs in seconds. The DB checks
// are satisfied without a database: with no DB_* vars injected the fixture
// asserts the "cleanly database-less" branch of the contract.

const FIXTURE_DIR = pathModule.join(projectRoot, "fixtures", "node");
const INSTANCES = 3;
const ROUNDS = 25;

jest.setTimeout(120_000);

interface SelfTestBody {
  ok: boolean;
  checks: { name: string; ok: boolean; error?: string }[];
  unique_hash: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitForReady(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`fixture on :${port} exited early (${child.exitCode})`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) {
        await res.text();
        return;
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`fixture on :${port} never became ready`);
}

describe("node fixture /self-test", () => {
  let dataDir: string;
  const children: ChildProcess[] = [];
  const ports: number[] = [];

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(pathModule.join(os.tmpdir(), "fixture-selftest-"));
    for (let i = 0; i < INSTANCES; i++) {
      const port = await freePort();
      const child = spawn(process.execPath, ["src/main.js"], {
        cwd: FIXTURE_DIR,
        env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
        stdio: "ignore",
      });
      children.push(child);
      ports.push(port);
    }
    await Promise.all(ports.map((port, i) => waitForReady(port, children[i])));
  });

  afterAll(() => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("reports every contract check on a single instance", async () => {
    const res = await fetch(`http://127.0.0.1:${ports[0]}/self-test`);
    const body = (await res.json()) as SelfTestBody;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.map((check) => check.name).sort()).toEqual(
      [...SELF_TEST_CHECKS].sort(),
    );
    expect(body.checks.every((check) => check.ok)).toBe(true);
    expect(typeof body.unique_hash).toBe("string");
    expect(body.unique_hash.length).toBeGreaterThan(0);
  });

  test("stays green with instances sharing one volume concurrently", async () => {
    const failures: string[] = [];

    for (let round = 0; round < ROUNDS; round++) {
      const bodies = await Promise.all(
        ports.map(async (port) => {
          const res = await fetch(`http://127.0.0.1:${port}/self-test`);
          return {
            port,
            status: res.status,
            body: (await res.json()) as SelfTestBody,
          };
        }),
      );

      for (const { port, status, body } of bodies) {
        if (status === 200 && body.ok) {
          continue;
        }
        const broken = body.checks
          .filter((check) => !check.ok)
          .map((check) => `${check.name}: ${check.error}`)
          .join("; ");
        failures.push(`round ${round} :${port} -> ${status} ${broken}`);
      }
    }

    expect(failures).toEqual([]);
  });

  test("counters survive concurrent increments without going backwards", async () => {
    const read = async (): Promise<number> => {
      const res = await fetch(`http://127.0.0.1:${ports[0]}/inc/counter`);
      return parseInt(await res.text(), 10);
    };

    const regressions: string[] = [];
    let previous = await read();

    for (let round = 0; round < ROUNDS; round++) {
      await Promise.all(
        ports.map((port) =>
          fetch(`http://127.0.0.1:${port}/inc/counter`, {
            method: "POST",
          }).then((res) => res.text()),
        ),
      );
      const current = await read();
      if (current <= previous) {
        regressions.push(`round ${round}: ${previous} -> ${current}`);
      }
      previous = current;
    }

    expect(regressions).toEqual([]);
  });
});
