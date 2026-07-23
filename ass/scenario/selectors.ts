// Pinned-vs-floating classification of component selectors (D12), matching
// the selector grammar of local-platform/localplatform/resolve.py.
// Unrecognized forms classify as floating so strict validation rejects them.

export type SelectorMode = "pinned" | "floating";

export interface SelectorClassification {
  mode: SelectorMode;
  reason: string;
}

const FLOATING_KEYWORDS = new Set([
  "resolve_prod",
  "resolve_dev",
  "latest",
  "latest_dev",
  "latest-dev",
]);

export function classifySelector(selector: string): SelectorClassification {
  if (FLOATING_KEYWORDS.has(selector)) {
    return {
      mode: "floating",
      reason: `"${selector}" resolves to a moving target`,
    };
  }
  if (selector.startsWith("path:")) {
    return { mode: "floating", reason: "path: points at a local build" };
  }
  if (selector.startsWith("github-artifact:")) {
    return {
      mode: "floating",
      reason: "github-artifact: resolves to the latest matching artifact",
    };
  }
  if (selector.startsWith("github-release:")) {
    const tag = selector.split(":")[2] ?? "";
    if (tag === "" || FLOATING_KEYWORDS.has(tag)) {
      return {
        mode: "floating",
        reason: "github-release: without a concrete tag",
      };
    }
    return { mode: "pinned", reason: `release tag ${tag}` };
  }
  if (selector.startsWith("artifact:")) {
    return { mode: "pinned", reason: "artifact of a concrete workflow run" };
  }
  if (selector.startsWith("url:")) {
    return { mode: "pinned", reason: "explicit artifact URL" };
  }
  if (selector.startsWith("registry:")) {
    if (selector.includes("@=")) {
      return { mode: "pinned", reason: "exact registry version (@=)" };
    }
    return {
      mode: "floating",
      reason: "registry package without an exact @= version",
    };
  }
  return {
    mode: "floating",
    reason:
      "unrecognized selector form; cannot be verified as pinned " +
      "(known pinned forms: github-release:<repo>:<tag>:<pattern>, " +
      "artifact:<repo>:<run-id>:<name>, url:…, registry:<pkg>@=<version>)",
  };
}
