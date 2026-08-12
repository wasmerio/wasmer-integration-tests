// Slug resolution and scenario loading. `ass try` searches only experiments/
// (draft validation), `ass run` only repros/ (strict validation); slugs are
// lowercase on disk and resolve case-insensitively (README strategy).

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { load as parseYaml, YAMLException } from "js-yaml";
import { ZodError } from "zod";
import {
  formatScenarioIssues,
  parseScenario,
  type Scenario,
  type ValidationMode,
} from "./schema";

export type ScenarioKind = "experiment" | "repro";

export interface ScenarioRoots {
  experimentsDir: string;
  reprosDir: string;
}

export interface ScenarioRef {
  slug: string;
  kind: ScenarioKind;
  dir: string;
}

export interface LoadedScenario extends ScenarioRef {
  scenario: Scenario;
}

export class ScenarioNotFoundError extends Error {
  constructor(slug: string, kind: ScenarioKind, searchedDir: string) {
    const boundary = kind === "experiment" ? "experiments/" : "repros/";
    const other = kind === "experiment" ? "ass run" : "ass try";
    super(
      `scenario "${slug}" not found in ${boundary} (searched ${searchedDir}). ` +
        `Only ${boundary} is searched by this command; ` +
        `use \`${other}\` for the other boundary.`,
    );
    this.name = "ScenarioNotFoundError";
  }
}

export class AmbiguousSlugError extends Error {
  constructor(slug: string, matches: string[]) {
    super(
      `slug "${slug}" is ambiguous: matches case-colliding directories ` +
        `${[...matches].sort().join(", ")}. Scenario directories must be lowercase on disk.`,
    );
    this.name = "AmbiguousSlugError";
  }
}

export class ScenarioLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioLoadError";
  }
}

export function rootsFrom(rootDir: string): ScenarioRoots {
  return {
    experimentsDir: path.join(rootDir, "experiments"),
    reprosDir: path.join(rootDir, "repros"),
  };
}

function kindDir(roots: ScenarioRoots, kind: ScenarioKind): string {
  return kind === "experiment" ? roots.experimentsDir : roots.reprosDir;
}

export function validationModeFor(kind: ScenarioKind): ValidationMode {
  return kind === "experiment" ? "draft" : "persisted";
}

function scenarioDirs(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return statSync(path.join(dir, name, "scenario.yaml")).isFile();
      } catch {
        return false;
      }
    });
}

export function listScenarios(roots: ScenarioRoots): ScenarioRef[] {
  const refs: ScenarioRef[] = [];
  for (const kind of ["repro", "experiment"] as const) {
    const dir = kindDir(roots, kind);
    for (const name of scenarioDirs(dir)) {
      refs.push({ slug: name, kind, dir: path.join(dir, name) });
    }
  }
  return refs.sort(
    (a, b) => a.slug.localeCompare(b.slug) || a.kind.localeCompare(b.kind),
  );
}

export function resolveSlug(
  roots: ScenarioRoots,
  kind: ScenarioKind,
  slug: string,
): ScenarioRef {
  const dir = kindDir(roots, kind);
  const wanted = slug.toLowerCase();
  const matches = scenarioDirs(dir).filter(
    (name) => name.toLowerCase() === wanted,
  );
  if (matches.length === 0) {
    throw new ScenarioNotFoundError(slug, kind, dir);
  }
  if (matches.length > 1) {
    throw new AmbiguousSlugError(slug, matches);
  }
  return { slug: matches[0], kind, dir: path.join(dir, matches[0]) };
}

export function loadScenario(
  roots: ScenarioRoots,
  kind: ScenarioKind,
  slug: string,
): LoadedScenario {
  const ref = resolveSlug(roots, kind, slug);
  const file = path.join(ref.dir, "scenario.yaml");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new ScenarioLoadError(`cannot read ${file}: ${String(err)}`);
  }
  let data: unknown;
  try {
    data = parseYaml(raw, { filename: file });
  } catch (err) {
    const detail = err instanceof YAMLException ? err.message : String(err);
    throw new ScenarioLoadError(`invalid YAML in ${file}:\n${detail}`);
  }
  try {
    const scenario = parseScenario(data, validationModeFor(kind));
    return { ...ref, scenario };
  } catch (err) {
    if (err instanceof ZodError) {
      const mode = validationModeFor(kind);
      throw new ScenarioLoadError(
        `invalid scenario ${file} (${mode} validation):\n` +
          formatScenarioIssues(err),
      );
    }
    throw err;
  }
}
