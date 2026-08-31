// The A/B arm, as a control rather than a suggestion: the same cycle against a
// plaintext peer. It must NOT reproduce — that is what localises the defect to
// the TLS handshake instead of sockets in general.

import { spawnSync } from "node:child_process";
import path from "node:path";

const HERE = __dirname;

test("plaintext connect/close plateaus in the guest", () => {
  const result = spawnSync(
    "node",
    [path.join(HERE, "measure.mjs"), "--target", "guest"],
    {
      encoding: "utf8",
      timeout: 20 * 60 * 1000,
      // Shorter than the TLS arm: without a handshake it plateaus early, and a
      // control that doubles the run's wall clock stops getting run.
      env: { ...process.env, PROBE_PEER_TLS: "0", PROBE_DURATION_S: "90" },
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stderr.write(output.endsWith("\n") ? output : `${output}\n`);
  expect(result.status).toBe(0);
});
