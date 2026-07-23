// `{{ victim.url }}` interpolation of resolved fixture values into executor
// profiles (QA-638). A profile is data, so interpolation walks it wholesale:
// changing the active executor or the target must not require rewriting the
// fixture that feeds it.
//
// References are checked twice. Statically, before any fixture resolves, the
// referenced name must be something the scenario could ever produce — an
// unresolvable reference is a preflight failure that names the variable, not
// a mystery empty string after a six-minute boot. Dynamically, at execute
// time, the variable must actually be present.

import type { Scenario } from "../scenario/schema";

const REFERENCE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

/** Every `{{ … }}` name inside a profile, in declaration order. */
export function templateReferences(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      const scanner = new RegExp(REFERENCE.source, "g");
      let match: RegExpExecArray | null;
      while ((match = scanner.exec(node)) !== null) {
        if (!found.includes(match[1])) {
          found.push(match[1]);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        walk(key);
        walk(child);
      }
    }
  };
  walk(value);
  return found;
}

/** Replace every reference in a profile with its resolved value. Keys are
 * interpolated too: a `volumes: {"{{ matrix.path }}": /work}` mapping carries
 * the resolved path on the key side. */
export function interpolate<T>(
  value: T,
  variables: Record<string, string>,
  where: string,
): T {
  const substitute = (text: string): string =>
    text.replace(REFERENCE, (_, name: string) => {
      const resolved = variables[name];
      if (resolved === undefined) {
        const available = Object.keys(variables).sort();
        throw new TemplateError(
          `${where} references {{ ${name} }}, which no fixture resolved; ` +
            (available.length > 0
              ? `resolved variables: ${available.join(", ")}`
              : "this run resolved no fixture variables"),
        );
      }
      return resolved;
    });
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return substitute(node);
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        out[substitute(key)] = walk(child);
      }
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

/** Affordances a fixture resolves to; `.url`/`.app_id` need a deployment. */
export const FIXTURE_FIELDS = ["url", "app_id", "path", "package"] as const;
export const DEPLOYED_FIELDS = new Set<string>(["url", "app_id"]);

export interface ReferenceCheck {
  reference: string;
  /** null when the reference is valid. */
  problem: string | null;
  /** True when satisfying it requires deploying the fixture as an app. */
  needsDeployment: boolean;
}

/** Static evaluability of one reference against the declaration alone. */
export function checkReference(
  scenario: Scenario,
  reference: string,
): ReferenceCheck {
  const components = Object.keys(scenario.fixtures.components ?? {});
  const apps = Object.keys(scenario.fixtures.apps ?? {});
  const probes = Object.keys(scenario.fixtures.probes ?? {});
  const dot = reference.indexOf(".");
  const head = dot === -1 ? reference : reference.slice(0, dot);
  const tail = dot === -1 ? "" : reference.slice(dot + 1);

  if (head === "component") {
    return {
      reference,
      needsDeployment: false,
      problem: components.includes(tail)
        ? null
        : `names undeclared component "${tail}"; ` +
          (components.length > 0
            ? `declared components: ${components.sort().join(", ")}`
            : "the scenario declares no fixtures.components"),
    };
  }
  const fixtures = [...apps, ...probes].sort();
  if (!fixtures.includes(head)) {
    return {
      reference,
      needsDeployment: false,
      problem:
        `names undeclared fixture "${head}"; ` +
        (fixtures.length > 0
          ? `declared fixtures: ${fixtures.join(", ")}`
          : "the scenario declares no fixtures.apps or fixtures.probes") +
        " (component versions are {{ component.<name> }})",
    };
  }
  if (!(FIXTURE_FIELDS as readonly string[]).includes(tail)) {
    return {
      reference,
      needsDeployment: false,
      problem:
        `names unknown affordance "${tail}" on fixture "${head}"; ` +
        `known affordances: ${FIXTURE_FIELDS.join(", ")}`,
    };
  }
  return {
    reference,
    needsDeployment: DEPLOYED_FIELDS.has(tail),
    problem: null,
  };
}
