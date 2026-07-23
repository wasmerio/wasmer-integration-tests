// `ass audit` (QA-641, Phase 6): local corpus checks. Reads the persisted
// scenarios and this machine's recorded run reports, lists `open` scenarios
// by how long since anything ran them, and flags a `fixed` scenario whose
// most recent floating run reproduced — a regression the lifecycle claims
// cannot happen. The Linear cross-check (lifecycle vs. ticket state) needs
// CI credentials and is a recorded follow-up, not implemented here.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { listScenarios, loadScenario, rootsFrom } from "../scenario/loader";
import type { RunReport } from "./report";

export interface LocalReportRef {
  slug: string;
  outcome: string;
  assessment: string;
  mode: "pinned" | "floating";
  env: string;
  finishedAt: string;
  path: string;
}

function readReportFile(file: string): LocalReportRef | null {
  let parsed: RunReport;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as RunReport;
  } catch {
    return null;
  }
  if (
    parsed?.scenario?.slug === undefined ||
    parsed?.target?.mode === undefined ||
    parsed?.timing?.finishedAt === undefined
  ) {
    return null;
  }
  return {
    slug: parsed.scenario.slug,
    outcome: parsed.outcome,
    assessment: parsed.assessment?.kind ?? "unknown",
    mode: parsed.target.mode,
    env: parsed.target.env,
    finishedAt: parsed.timing.finishedAt,
    path: file,
  };
}

/** Every run report this machine has recorded, wherever a run put it. */
export function collectLocalReports(cwd: string): LocalReportRef[] {
  const refs: LocalReportRef[] = [];
  const tryDir = (
    dir: string,
    pick: (entry: string) => string | null,
  ): void => {
    if (!existsSync(dir)) {
      return;
    }
    for (const entry of readdirSync(dir)) {
      const file = pick(entry);
      if (file === null || !existsSync(file)) {
        continue;
      }
      const ref = readReportFile(file);
      if (ref !== null) {
        refs.push(ref);
      }
    }
  };
  const assDir = path.join(cwd, ".local-platform", "ass");
  // Stack-less and remote runs: .local-platform/ass/runs/<stamp>/report.json
  tryDir(path.join(assDir, "runs"), (entry) =>
    path.join(assDir, "runs", entry, "report.json"),
  );
  // Setup failures land beside the runs dir as flat files.
  tryDir(assDir, (entry) =>
    entry.endsWith("-setup-failed.json") ? path.join(assDir, entry) : null,
  );
  // Platform-booting runs: .local-platform/runs/<stamp>/ass/report.json
  const runsDir = path.join(cwd, ".local-platform", "runs");
  tryDir(runsDir, (entry) => path.join(runsDir, entry, "ass", "report.json"));
  return refs.sort((a, b) => a.finishedAt.localeCompare(b.finishedAt));
}

export interface AuditResult {
  lines: string[];
  exitCode: number;
}

function daysAgo(iso: string, nowMs: number): string {
  const days = Math.floor((nowMs - Date.parse(iso)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

export function runAudit(cwd: string, nowMs: number = Date.now()): AuditResult {
  const lines: string[] = [];
  let exitCode = 0;
  const reports = collectLocalReports(cwd);
  const bySlug = new Map<string, LocalReportRef[]>();
  for (const ref of reports) {
    bySlug.set(ref.slug, [...(bySlug.get(ref.slug) ?? []), ref]);
  }

  const open: Array<{ slug: string; last: LocalReportRef | null }> = [];
  const fixed: Array<{
    slug: string;
    fixedIn: string;
    latestFloating: LocalReportRef | null;
  }> = [];
  const retired: Array<{ slug: string; successor: string }> = [];

  const unloadable: Array<{ slug: string; error: string }> = [];
  for (const ref of listScenarios(rootsFrom(cwd))) {
    if (ref.kind !== "repro") {
      continue; // drafts are never audited or scheduled
    }
    let scenario;
    try {
      scenario = loadScenario(rootsFrom(cwd), "repro", ref.slug).scenario;
    } catch (err) {
      // A repro that no longer parses is corpus rot worth naming, but it
      // must not take the rest of the audit down with it.
      unloadable.push({
        slug: ref.slug,
        error: (err instanceof Error ? err.message : String(err)).split(
          "\n",
        )[0],
      });
      continue;
    }
    const lifecycle = scenario.meta.lifecycle;
    const runs = bySlug.get(ref.slug) ?? [];
    if (lifecycle === undefined || lifecycle.state === "open") {
      open.push({ slug: ref.slug, last: runs[runs.length - 1] ?? null });
    } else if (lifecycle.state === "fixed") {
      const floating = runs.filter((run) => run.mode === "floating");
      fixed.push({
        slug: ref.slug,
        fixedIn: Object.entries(lifecycle.fixed_in)
          .map(([component, version]) => `${component}=${version}`)
          .join(", "),
        latestFloating: floating[floating.length - 1] ?? null,
      });
    } else {
      retired.push({ slug: ref.slug, successor: lifecycle.superseded_by });
    }
  }

  // Stalest first: the scenario nobody has re-run the longest is the one
  // most likely to have silently rotted.
  open.sort((a, b) =>
    (a.last?.finishedAt ?? "").localeCompare(b.last?.finishedAt ?? ""),
  );
  lines.push(`open scenarios (${open.length}):`);
  for (const entry of open) {
    lines.push(
      entry.last === null
        ? `  ${entry.slug}  never run on this machine`
        : `  ${entry.slug}  last run ${daysAgo(entry.last.finishedAt, nowMs)} ` +
            `(${entry.last.outcome}, ${entry.last.mode}, ${entry.last.env})`,
    );
  }

  lines.push(`fixed scenarios (${fixed.length}):`);
  for (const entry of fixed) {
    if (entry.latestFloating === null) {
      lines.push(
        `  ${entry.slug}  fixed in ${entry.fixedIn}; no floating run recorded ` +
          "here yet (regression watch runs in the pipeline)",
      );
    } else if (entry.latestFloating.outcome === "reproduced") {
      exitCode = 2;
      lines.push(
        `  ${entry.slug}  REGRESSION: lifecycle says fixed in ` +
          `${entry.fixedIn}, but the most recent floating run reproduced ` +
          `(${daysAgo(entry.latestFloating.finishedAt, nowMs)}, ` +
          `${entry.latestFloating.env}; ${entry.latestFloating.path})`,
      );
    } else {
      lines.push(
        `  ${entry.slug}  quiet on floating ` +
          `(${entry.latestFloating.outcome}, ` +
          `${daysAgo(entry.latestFloating.finishedAt, nowMs)})`,
      );
    }
  }

  if (retired.length > 0) {
    lines.push(`retired scenarios (${retired.length}):`);
    for (const entry of retired) {
      lines.push(`  ${entry.slug}  superseded by ${entry.successor}`);
    }
  }

  if (unloadable.length > 0) {
    lines.push(`unloadable scenarios (${unloadable.length}):`);
    for (const entry of unloadable) {
      lines.push(`  ${entry.slug}  ${entry.error}`);
    }
  }

  return { lines, exitCode };
}
