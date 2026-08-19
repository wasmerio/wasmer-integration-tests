// Which engine owns a held slug. A world seeded by v1 keeps its recorded
// teardown entries; a v2 world is released by reconciling to the empty set.
// Kept apart from the verbs so the CLI can decide without loading either
// engine's dependency tree.

import { readFileSync } from "node:fs";
import path from "node:path";
import { LocalPlatformDriver } from "../../fixtures/localPlatform";
import { ledgerPath } from "./ledger";
import { loadDeclarationFile } from "./scenario";

export async function resolveDownEngine(
  cwd: string,
  slug: string | undefined,
  file: string | undefined,
): Promise<"v1" | "v2"> {
  const resolved = slug ?? (await slugOfFile(cwd, file));
  if (resolved === "") {
    return "v1";
  }
  const driver = new LocalPlatformDriver(cwd, {
    io: { info: () => undefined },
  });
  try {
    const parsed = JSON.parse(
      readFileSync(ledgerPath(driver.repoDir, resolved), "utf8"),
    ) as {
      stateVersion?: number;
    };
    return parsed.stateVersion === 2 ? "v2" : "v1";
  } catch {
    return "v1";
  }
}

export async function slugOfFile(
  cwd: string,
  file: string | undefined,
): Promise<string> {
  if (file === undefined) {
    return "";
  }
  try {
    return loadDeclarationFile(path.resolve(cwd, file)).declaration.name;
  } catch {
    return "";
  }
}
