// `ass promote <slug>`: graduate a draft into a persisted reproduction
// (docs/anti-slop-shield-v1.md §3). Everything it writes is derived from a
// recorded `ass try` run, never from retyping: floating selectors are replaced
// by the concrete ones that run resolved, the lifecycle is stamped `open`, and
// a provenance README records where the artifact came from. Nothing moves
// until the rewritten scenario has passed persisted validation, so a rejected
// promotion leaves the draft exactly where it was.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseToml } from "./toml";
import {
  forgetTryState,
  readTryState,
  digestDeclaration,
  type TryState,
} from "../engine/state";
import { loadScenario, resolveSlug, rootsFrom } from "./loader";
import { baselineSpecOf, parseScenario, type Scenario } from "./schema";
import { classifySelector } from "./selectors";

export class PromoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromoteError";
  }
}

export interface PromoteResult {
  slug: string;
  from: string;
  to: string;
  /** Component -> the selector written into the persisted scenario. */
  pinned: Record<string, string>;
  /** Components that were already pinned in the draft. */
  kept: string[];
  /** Components the recorded run overrode -> the selector the draft declared
   * and the promotion therefore did *not* keep. */
  overridden: Record<string, string>;
}

const KEY_LINE = /^(\s*)(["']?)([A-Za-z0-9_.-]+)\2\s*=\s*(.*)$/;

/** Replace component selectors in place, preserving comments, ordering, and
 * everything untouched. A structural rewrite through a TOML serializer
 * would drop the comments that explain why a pin is what it is. */
function rewriteComponents(
  text: string,
  replacements: Record<string, string>,
): string {
  if (Object.keys(replacements).length === 0) {
    return text;
  }
  const lines = text.split("\n");
  let inComponents = false;
  const remaining = new Set(Object.keys(replacements));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inComponents) {
      if (/^\s*\[fixtures\.components\]\s*(#.*)?$/.test(line)) {
        inComponents = true;
      }
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    if (/^\s*\[/.test(line)) {
      break; // next table header — out of the components block
    }
    const entry = KEY_LINE.exec(line);
    if (entry === null || !remaining.has(entry[3])) {
      continue;
    }
    const trailingComment = / +#.*$/.exec(entry[4]);
    lines[i] =
      `${entry[1]}${entry[2]}${entry[3]}${entry[2]} = ` +
      JSON.stringify(replacements[entry[3]]) +
      (trailingComment ? trailingComment[0] : "");
    remaining.delete(entry[3]);
  }
  if (remaining.size > 0) {
    throw new PromoteError(
      "could not locate component " +
        `${Array.from(remaining).sort().join(", ")} under ` +
        "[fixtures.components] in the draft; pin it by hand and re-run " +
        "promote",
    );
  }
  return lines.join("\n");
}

/** Stamp `lifecycle = { state = "open" }` — a promoted reproduction is by
 * definition an open bug until someone proves otherwise (D6). */
function stampLifecycle(text: string): string {
  const lines = text.split("\n");
  const metaIndex = lines.findIndex((line) =>
    /^\s*\[meta\]\s*(#.*)?$/.test(line),
  );
  if (metaIndex === -1) {
    throw new PromoteError("the draft has no [meta] table");
  }
  let insertAt = metaIndex + 1;
  for (let i = metaIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    if (/^\s*\[/.test(line)) {
      break; // next table header — out of the meta table
    }
    const entry = KEY_LINE.exec(line);
    if (entry === null) {
      break;
    }
    insertAt = i + 1;
    if (entry[3] === "title") {
      break;
    }
  }
  lines.splice(insertAt, 0, `lifecycle = { state = "open" }`);
  return lines.join("\n");
}

function declaredLifecycle(text: string): boolean {
  const data = parseToml(text, "draft") as {
    meta?: { lifecycle?: unknown };
  } | null;
  return data?.meta?.lifecycle !== undefined;
}

// Declaration gaps are checked before the run outcome: a draft with no
// verdict can never record `reproduced`, so reporting the outcome first would
// name the symptom instead of the cause.
function requirePromotable(scenario: Scenario, state: TryState): void {
  if (scenario.verdict === undefined) {
    throw new PromoteError(
      "the draft declares no verdict, so nothing decides whether a future " +
        "run reproduced; add verdict.reproduced_when (and/or verdict.probe) " +
        "before promoting",
    );
  }
  if (scenario.verdict.baseline === undefined) {
    throw new PromoteError(
      "the draft declares no verdict.baseline: nearly every Wasmer bug is a " +
        "native-vs-guest divergence, so a persisted scenario states its " +
        "native baseline ({engine, entry}) or waives it with a reason " +
        "({waived: …}) (D10)",
    );
  }
  // A declared baseline that never ran leaves the native-vs-guest divergence
  // unproven. Persisting that would make the corpus claim a differential it
  // does not have, so promotion refuses until the engine is installed (D10).
  const baselineSpec = baselineSpecOf(scenario.verdict.baseline);
  if (baselineSpec !== null && (state.baseline ?? "not-run") !== "ok") {
    throw new PromoteError(
      `the draft declares a ${baselineSpec.engine} native ` +
        "baseline, but the last recorded run did not exercise it " +
        `(${state.baseline ?? "not-run"}); a reproduction is only a Wasmer ` +
        "bug once the same probe demonstrably passes natively. Install the " +
        "engine (`ass doctor` lists them), re-run `ass try`, and promote again",
    );
  }
  if (state.outcome !== "reproduced") {
    throw new PromoteError(
      `the last recorded \`ass try\` run ended "${state.outcome}" ` +
        `(${state.recordedAt}); promotion persists a proven reproduction, ` +
        "so iterate until it reproduces and try again",
    );
  }
}

interface PinPlan {
  replacements: Record<string, string>;
  kept: string[];
  overridden: Record<string, string>;
}

/** The concrete selectors to write, and which components they replace.
 *
 * What has to be pinned is decided by the *effective* selector the run used,
 * never by the declaration: the two diverge exactly at the D12 override
 * surface, and a component the developer overrode with `--component` ran on
 * something the declaration does not name. Copying the declaration through
 * would persist a reproduction whose evidence came from a version that was
 * never booted (review 4, R4-01). */
function resolvePins(scenario: Scenario, state: TryState): PinPlan {
  const replacements: Record<string, string> = {};
  const kept: string[] = [];
  const overridden: Record<string, string> = {};
  // `readTryState` only rejects unparseable records, so a truncated one can
  // still arrive missing these maps.
  const selectors = state.selectors ?? {};
  const pins = state.pins ?? {};
  for (const [name, declared] of Object.entries(
    scenario.fixtures.components ?? {},
  )) {
    const effective = selectors[name] ?? declared;
    const wasOverridden = effective !== declared;
    if (!wasOverridden && classifySelector(declared).mode === "pinned") {
      kept.push(name);
      continue;
    }
    // Same sentence prefix either way, so the two causes read alike.
    const origin = wasOverridden
      ? `component "${name}" ran on the override "${effective}" rather than ` +
        `its declared "${declared}"`
      : `component "${name}" floats ("${declared}")`;
    const retry = wasOverridden
      ? `Re-run \`ass try\` without the override, or with a pinned ` +
        `--component ${name}=<selector>`
      : `Re-run \`ass try\` with a pinned --component ${name}=<selector>, or ` +
        "pin it by hand";
    const resolved = pins[name];
    if (resolved === undefined || resolved.length === 0) {
      throw new PromoteError(
        `${origin}, and the recorded run did not report what it resolved to, ` +
          "so there is nothing to pin; re-run `ass try` and promote again",
      );
    }
    const classification = classifySelector(resolved);
    if (classification.mode === "floating") {
      throw new PromoteError(
        `${origin}, and the recorded run resolved it to "${resolved}", which ` +
          `is not a pin: ${classification.reason}. ${retry}`,
      );
    }
    replacements[name] = resolved;
    if (wasOverridden) {
      overridden[name] = declared;
    }
  }
  return { replacements, kept, overridden };
}

function provenanceReadme(
  scenario: Scenario,
  state: TryState,
  plan: PinPlan,
  slug: string,
  cwd: string,
): string {
  const pinned = plan.replacements;
  // A repo-relative path is what a reader can act on; an absolute one is
  // about the machine that happened to run it.
  const relative = path.relative(cwd, state.reportPath);
  const reportPath =
    relative && !relative.startsWith("..") ? relative : state.reportPath;
  // The union members share optional fields, so narrowing by key does not
  // discriminate; read it as the open shape it is.
  const spec = scenario.verdict?.baseline as
    | { engine?: string; entry?: string[]; expect?: string; waived?: string }
    | undefined;
  const baseline =
    spec === undefined
      ? "none declared"
      : spec.waived !== undefined
        ? `waived — ${spec.waived}`
        : `${spec.engine} \`${(spec.entry ?? []).join(" ")}\` ` +
          `(expects ${spec.expect}); exercised on the recorded run ` +
          `(${state.baseline ?? "not-run"})`;
  const origin = (name: string): string => {
    const effective = (state.selectors ?? {})[name];
    if (name in plan.overridden) {
      return (
        `resolved from \`--component ${name}=${effective}\`, ` +
        `overriding the draft's \`${plan.overridden[name]}\``
      );
    }
    return name in pinned
      ? `resolved from \`${effective}\``
      : "declared pinned in the draft";
  };
  const components = Object.entries(scenario.fixtures.components ?? {}).map(
    ([name, declared]) =>
      `| \`${name}\` | \`${pinned[name] ?? declared}\` | ${origin(name)} |`,
  );
  const profile = scenario.load.profiles[state.executor] ?? {};
  return `# ${scenario.meta.id} — ${scenario.meta.title}

Promoted from \`experiments/${slug}/\` by \`ass promote ${slug}\`.

## Run it

\`\`\`bash
pnpm ass run ${slug}
\`\`\`

Fix verification is a run-time override, never an edit to this declaration:

\`\`\`bash
pnpm ass run ${slug} --edge path:/path/to/your/build
\`\`\`

## Pinned components

| Component | Selector | Origin |
| --------- | -------- | ------ |
${components.join("\n")}

## Provenance

| Field | Value |
| ----- | ----- |
| Source draft | \`experiments/${slug}/scenario.toml\` |
| Recorded run | ${state.recordedAt} (\`${reportPath}\`) |
| Target | \`${state.env}\`, mode \`${state.mode}\` |
| Workload | \`${state.executor}\`: \`${JSON.stringify(profile)}\` |
| Outcome | \`${state.outcome}\` (assessment \`${state.assessment}\`) |
| Baseline (D10) | ${baseline} |

The reproduction above is what the recorded run observed on the pinned
selectors. Edit this file freely — only \`scenario.toml\` is machine-owned.
`;
}

export function promoteScenario(cwd: string, slug: string): PromoteResult {
  const roots = rootsFrom(cwd);
  const ref = resolveSlug(roots, "experiment", slug);
  const loaded = loadScenario(roots, "experiment", slug);
  const source = path.join(ref.dir, "scenario.toml");
  const text = readFileSync(source, "utf8");

  const state = readTryState(cwd, ref.slug);
  if (state === null) {
    throw new PromoteError(
      `no \`ass try ${ref.slug}\` run has been recorded on this machine; ` +
        "promotion pins what a run actually resolved, so run the draft " +
        "first",
    );
  }
  if (state.declarationDigest !== digestDeclaration(text)) {
    throw new PromoteError(
      `experiments/${ref.slug}/scenario.toml has changed since the recorded ` +
        `run (${state.recordedAt}), so its resolved pins may describe a ` +
        "different experiment; re-run `ass try` and promote again",
    );
  }
  requirePromotable(loaded.scenario, state);

  const target = path.join(roots.reprosDir, ref.slug);
  if (existsSync(target)) {
    throw new PromoteError(
      `repros/${ref.slug}/ already exists; promotion never overwrites a ` +
        "persisted reproduction",
    );
  }

  const plan = resolvePins(loaded.scenario, state);
  const { replacements, kept, overridden } = plan;
  let rewritten = rewriteComponents(text, replacements);
  if (!declaredLifecycle(rewritten)) {
    rewritten = stampLifecycle(rewritten);
  }

  // Prove the rewrite before anything moves: it must parse under persisted
  // validation *and* say what we intended it to say.
  let promoted: Scenario;
  try {
    promoted = parseScenario(
      parseToml(rewritten, "promoted draft"),
      "persisted",
    );
  } catch (err) {
    throw new PromoteError(
      "the promoted scenario does not pass persisted validation, so nothing " +
        `was moved:\n${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const [name, selector] of Object.entries(replacements)) {
    if ((promoted.fixtures.components ?? {})[name] !== selector) {
      throw new PromoteError(
        `rewriting component "${name}" did not take effect; pin it by hand ` +
          "and move the directory yourself",
      );
    }
  }
  if (promoted.meta.lifecycle.state !== "open") {
    throw new PromoteError(
      `the draft declares lifecycle "${promoted.meta.lifecycle.state}"; a ` +
        "promotion stamps open (a reproduction that is already fixed or " +
        "retired belongs in repros/ by hand)",
    );
  }

  // Re-checked immediately before the move, so the rollback below can only
  // ever remove a directory this call created.
  if (existsSync(target)) {
    throw new PromoteError(
      `repros/${ref.slug}/ already exists; promotion never overwrites a ` +
        "persisted reproduction",
    );
  }
  mkdirSync(path.dirname(target), { recursive: true });
  // The copy is the first irreversible step, so everything from here to the
  // last write owns its own unwind: a failure part-way through must leave no
  // half-built repro to trip the retry over "already exists".
  try {
    cpSync(ref.dir, target, { recursive: true });
    writeFileSync(path.join(target, "scenario.toml"), rewritten);
    const notes = path.join(ref.dir, "README.md");
    const draftNotes = existsSync(notes)
      ? readFileSync(notes, "utf8").trim()
      : "";
    writeFileSync(
      path.join(target, "README.md"),
      provenanceReadme(promoted, state, plan, ref.slug, cwd) +
        (draftNotes === ""
          ? ""
          : `\n## Notes carried over from the draft\n\n${draftNotes}\n`),
    );
  } catch (err) {
    rmSync(target, { recursive: true, force: true });
    throw new PromoteError(
      `writing repros/${ref.slug}/ failed, so the draft was left where it ` +
        `is and the partial copy removed:\n${
          err instanceof Error ? err.message : String(err)
        }`,
    );
  }
  rmSync(ref.dir, { recursive: true, force: true });
  forgetTryState(cwd, ref.slug);

  return {
    slug: ref.slug,
    from: ref.dir,
    to: target,
    pinned: replacements,
    kept,
    overridden,
  };
}
