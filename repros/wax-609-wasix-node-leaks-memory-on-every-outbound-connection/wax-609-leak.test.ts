// ASS workload: drives the guest and judges its memory curve from the host.
//
// A jest spec rather than a raw-wasmer profile because the judgement needs a
// vantage point outside the guest, and `raw-wasmer` only spawns the guest and
// reads its output. See measure.mjs for why in-guest counters cannot see this.

import { spawnSync } from "node:child_process";
import path from "node:path";

const HERE = __dirname;

test("guest memory keeps climbing under repeated database connect/close", () => {
  const result = spawnSync(
    "node",
    [path.join(HERE, "measure.mjs"), "--target", "guest"],
    { encoding: "utf8", timeout: 20 * 60 * 1000 },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // jest runs with silent: true, which mutes console but not a direct write.
  process.stderr.write(output.endsWith("\n") ? output : `${output}\n`);
  expect(result.status).toBe(0);
});
