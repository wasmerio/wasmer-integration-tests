// Scenario schema (QA-634, docs/anti-slop-shield-v1.md §4): fixtures / load /
// verdict plus typed meta. Two validation modes share one schema: "draft"
// (experiments/) is permissive, "persisted" (repros/) requires pins, a
// verdict, explicit lifecycle, and a baseline or waiver (D10).

import { z } from "zod";
import { classifySelector } from "./selectors";
import {
  LOAD_EXECUTOR_NAMES,
  SCENARIO_OUTCOMES,
  TARGET_ENVS,
} from "../executors/contract";
import type { ScenarioOutcome, TargetEnv } from "../executors/contract";

export type ValidationMode = "draft" | "persisted";
export type { ScenarioOutcome, TargetEnv };
export { SCENARIO_OUTCOMES, TARGET_ENVS };

// meta.lifecycle (D6)

const openLifecycleSchema = z.strictObject({ state: z.literal("open") });

const fixedLifecycleSchema = z.strictObject({
  state: z.literal("fixed"),
  /** Component -> first known-good version; keys ⊆ fixtures.components. */
  fixed_in: z.record(z.string().min(1)),
  fixed_at: z.string().min(1),
  evidence: z.string().min(1),
});

const retiredLifecycleSchema = z.strictObject({
  state: z.literal("retired"),
  superseded_by: z.string().min(1),
});

export const lifecycleSchema = z.discriminatedUnion("state", [
  openLifecycleSchema,
  fixedLifecycleSchema,
  retiredLifecycleSchema,
]);
export type Lifecycle = z.infer<typeof lifecycleSchema>;

const metaSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  lifecycle: lifecycleSchema.optional(),
  links: z.record(z.string().min(1)).optional(),
});

// fixtures

// D13: unknown keys cannot be honored by a target, so they are schema errors.
const fixtureConfigSchema = z.strictObject({
  max_instances: z.number().int().positive().optional(),
});

/** A fixture may state which executors can drive it (QA-637). Omitted means
 * "any": most fixtures are executor-agnostic, and the declaration is for the
 * cases where they are not — a probe packaged for `wasmer run` has no meaning
 * to an HTTP load generator. */
const fixtureExecutorsSchema = z.array(z.string().min(1)).min(1);

const appFixtureSchema = z.strictObject({
  source: z.string().min(1),
  config: fixtureConfigSchema.optional(),
  executors: fixtureExecutorsSchema.optional(),
});

const probeFixtureSchema = z.strictObject({
  source: z.string().min(1),
  config: fixtureConfigSchema.optional(),
  executors: fixtureExecutorsSchema.optional(),
});

const perturbationSchema = z.strictObject({
  cpus: z.number().int().positive().optional(),
  wipe_caches: z.array(z.string().min(1)).optional(),
});

const fixturesSchema = z.strictObject({
  apps: z.record(appFixtureSchema).optional(),
  probes: z.record(probeFixtureSchema).optional(),
  components: z.record(z.string().min(1)).optional(),
  perturbations: z.record(perturbationSchema).optional(),
});

// load: several executor profiles, exactly one active per run (D8)

export interface Load {
  /** Name of the profile that runs by default; `--executor` picks another. */
  activeExecutor: string;
  /** Profile name -> its settings, with the `executor:` key removed. */
  profiles: Record<string, Record<string, unknown>>;
  /** Profile name -> the executor that runs it. A profile is named after its
   * executor unless it says otherwise, which is what lets a scenario declare
   * two `raw-wasmer` profiles — the shape D8's "compare two guest engine
   * versions" control needs. */
  executors: Record<string, string>;
}

function executorOf(name: string, profile: unknown): string {
  const declared = (profile as Record<string, unknown> | null)?.["executor"];
  return typeof declared === "string" && declared.length > 0 ? declared : name;
}

const loadSchema = z
  .record(z.unknown())
  .superRefine((raw, ctx) => {
    const profileNames = Object.keys(raw).filter((k) => k !== "executor");
    if (profileNames.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "load must declare at least one executor profile " +
          "(e.g. jest:, artillery-http:, raw-wasmer:)",
      });
      return;
    }
    for (const name of profileNames) {
      const profile = raw[name];
      if (
        typeof profile !== "object" ||
        profile === null ||
        Array.isArray(profile)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `executor profile "${name}" must be a mapping`,
        });
        continue;
      }
      // A profile's name *is* its executor unless it names one, so a typo in
      // the profile name is an unknown executor — caught here rather than at
      // dispatch, after fixtures have resolved.
      const executor = executorOf(name, profile);
      if (!(LOAD_EXECUTOR_NAMES as readonly string[]).includes(executor)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message:
            `unknown executor "${executor}"; a load profile is named after ` +
            "the executor that runs it, or names one with executor:. Known " +
            `executors: ${[...LOAD_EXECUTOR_NAMES].sort().join(", ")}`,
        });
      }
    }
    const executor = raw["executor"];
    if (executor === undefined) {
      if (profileNames.length > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "ambiguous active executor: several profiles are declared " +
            `(${profileNames.sort().join(", ")}) but no executor: names the default`,
        });
      }
      return;
    }
    if (typeof executor !== "string" || executor.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executor"],
        message: "executor must be the name of a declared profile",
      });
      return;
    }
    if (!profileNames.includes(executor)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executor"],
        message:
          `executor "${executor}" has no matching profile; ` +
          `declared profiles: ${profileNames.sort().join(", ")}`,
      });
    }
  })
  .transform((raw): Load => {
    const profiles: Record<string, Record<string, unknown>> = {};
    const executors: Record<string, string> = {};
    for (const [name, profile] of Object.entries(raw)) {
      if (name === "executor") continue;
      // `executor:` is addressing, not settings: the executor's own strict
      // profile schema must never see it.
      const settings = { ...((profile ?? {}) as Record<string, unknown>) };
      delete settings["executor"];
      profiles[name] = settings;
      executors[name] = executorOf(name, profile);
    }
    const activeExecutor =
      typeof raw["executor"] === "string"
        ? raw["executor"]
        : Object.keys(profiles)[0];
    return { activeExecutor, profiles, executors };
  });

// verdict: any/all combinators (D7), probe contract (D11), baseline (D10)

export interface LogMatchesPredicate {
  log_matches: { stream: string; pattern: string };
}
export interface OutputMatchesPredicate {
  output_matches: { stream?: "stdout" | "stderr"; pattern: string };
}
export type Predicate = LogMatchesPredicate | OutputMatchesPredicate;
export type CombinatorNode =
  | { any: Array<Predicate | CombinatorNode> }
  | { all: Array<Predicate | CombinatorNode> };

const logMatchesSchema = z.strictObject({
  log_matches: z.strictObject({
    stream: z.string().min(1),
    pattern: z.string().min(1),
  }),
});

const outputMatchesSchema = z.strictObject({
  output_matches: z.strictObject({
    stream: z.enum(["stdout", "stderr"]).optional(),
    pattern: z.string().min(1),
  }),
});

const predicateSchema = z.union([logMatchesSchema, outputMatchesSchema], {
  errorMap: () => ({
    message:
      "expected a predicate (log_matches: {stream, pattern} or " +
      "output_matches: {pattern, stream?}) or a nested any:/all: combinator",
  }),
});

const combinatorSchema: z.ZodType<CombinatorNode> = z.lazy(() =>
  z.union(
    [
      z.strictObject({
        any: z.array(z.union([predicateSchema, combinatorSchema])).min(1),
      }),
      z.strictObject({
        all: z.array(z.union([predicateSchema, combinatorSchema])).min(1),
      }),
    ],
    {
      errorMap: () => ({
        message:
          "predicates sit under an explicit combinator: " +
          "{any: [...]} or {all: [...]}",
      }),
    },
  ),
) as z.ZodType<CombinatorNode>;

// Open union (D11): unknown type errors name the known members.
const probeChannelSchema = z.discriminatedUnion(
  "type",
  [
    z.strictObject({
      type: z.literal("log"),
      stream: z.enum(["stdout", "stderr"]),
    }),
    z.strictObject({
      type: z.literal("http"),
      match: z.literal("body"),
    }),
  ],
  {
    errorMap: (issue, ctx) => {
      if (issue.code === z.ZodIssueCode.invalid_union_discriminator) {
        return {
          message:
            "unknown probe channel type; known channel types: " +
            '{type: "log", stream: stdout|stderr}, {type: "http", match: body} ' +
            "(the union is open — new transports are additive)",
        };
      }
      return { message: ctx.defaultError };
    },
  },
);
export type ProbeChannel = z.infer<typeof probeChannelSchema>;

const probeSchema = z.strictObject({
  channels: z.array(probeChannelSchema).min(1),
});

export const BASELINE_ENGINES = [
  "python3",
  "node",
  "go",
  "cargo",
  "binary",
] as const;

const expectableOutcomeSchema = z.enum(["reproduced", "not-reproduced"]);

function refineEngineCommand(
  run: { engine?: string; command?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (run.engine === "binary" && run.command === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command"],
      message: 'engine "binary" requires an explicit command: [...]',
    });
  }
  if (run.engine !== "binary" && run.command !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command"],
      message: `command: is only valid with engine "binary" (got "${run.engine}")`,
    });
  }
}

const baselineSpecSchema = z
  .strictObject({
    engine: z.enum(BASELINE_ENGINES),
    command: z.array(z.string().min(1)).min(1).optional(),
    entry: z.array(z.string().min(1)).min(1),
    workdir: z.string().min(1).optional(),
    expect: expectableOutcomeSchema.default("not-reproduced"),
  })
  .superRefine(refineEngineCommand);

const baselineWaiverSchema = z.strictObject({
  waived: z.string().min(1),
});

const baselineSchema = z.union([baselineSpecSchema, baselineWaiverSchema], {
  errorMap: () => ({
    message:
      "baseline must declare a native engine run " +
      "({engine, entry, expect?}) or a reasoned waiver ({waived: reason})",
  }),
});
export type Baseline = z.infer<typeof baselineSchema>;
export type BaselineSpec = z.infer<typeof baselineSpecSchema>;

/** The union members share optional keys, so `"waived" in baseline` does not
 * discriminate. Narrow on the value instead. */
export function baselineSpecOf(baseline: Baseline): BaselineSpec | null {
  return "waived" in baseline && baseline.waived !== undefined
    ? null
    : (baseline as BaselineSpec);
}

// A control is runnable exactly one way: a native run (engine: + entry:,
// baseline-shaped) or a declared load profile (executor:).
const controlSchema = z
  .strictObject({
    engine: z.enum(BASELINE_ENGINES).optional(),
    command: z.array(z.string().min(1)).min(1).optional(),
    entry: z.array(z.string().min(1)).min(1).optional(),
    workdir: z.string().min(1).optional(),
    executor: z.string().min(1).optional(),
    expect: expectableOutcomeSchema,
  })
  .superRefine((control, ctx) => {
    const native = control.engine !== undefined;
    if (native === (control.executor !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "a control declares either a native run (engine: + entry:) or " +
          `an executor:, not ${native ? "both" : "neither"}`,
      });
      return;
    }
    if (native) {
      if (control.entry === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entry"],
          message: "a native control requires entry: [...]",
        });
      }
      refineEngineCommand(control, ctx);
      return;
    }
    for (const field of ["command", "entry", "workdir"] as const) {
      if (control[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field}: is only valid on a native control (with engine:)`,
        });
      }
    }
  });

// Evidence retained either way (QA-641): named grep-with-context extraction
// over a log stream, e.g. {edge_panic_context: {stream: edge,
// pattern: "panicked at", before: 1, after: 4}}.
const collectSpecSchema = z.strictObject({
  stream: z.string().min(1),
  pattern: z.string().min(1),
  before: z.number().int().nonnegative().default(0),
  after: z.number().int().nonnegative().default(0),
});
export type CollectSpec = z.infer<typeof collectSpecSchema>;

const collectEntrySchema = z
  .record(collectSpecSchema)
  .superRefine((entry, ctx) => {
    if (Object.keys(entry).length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "each collect entry names exactly one evidence item: " +
          "{<name>: {stream, pattern, before?, after?}}",
      });
    }
  });

const verdictSchema = z
  .strictObject({
    reproduced_when: combinatorSchema.optional(),
    not_reproduced_when: combinatorSchema.optional(),
    probe: probeSchema.optional(),
    baseline: baselineSchema.optional(),
    controls: z.record(controlSchema).optional(),
    collect: z.array(collectEntrySchema).optional(),
  })
  .superRefine((verdict, ctx) => {
    if (verdict.reproduced_when === undefined && verdict.probe === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "verdict must declare reproduced_when: and/or probe: — " +
          "otherwise no run can end reproduced",
      });
    }
  });
export type Verdict = z.infer<typeof verdictSchema>;

// scenario

const scenarioBaseSchema = z.strictObject({
  meta: metaSchema,
  fixtures: fixturesSchema.default({}),
  load: loadSchema,
  verdict: verdictSchema.optional(),
});

export interface Scenario {
  meta: {
    id: string;
    title: string;
    lifecycle: Lifecycle;
    links?: Record<string, string>;
  };
  fixtures: z.infer<typeof fixturesSchema>;
  load: Load;
  verdict?: Verdict;
}

function crossValidate(
  scenario: z.infer<typeof scenarioBaseSchema>,
  mode: ValidationMode,
  ctx: z.RefinementCtx,
): void {
  const components = scenario.fixtures.components ?? {};
  const lifecycle = scenario.meta.lifecycle;

  if (lifecycle?.state === "fixed") {
    const undeclared = Object.keys(lifecycle.fixed_in).filter(
      (name) => !(name in components),
    );
    if (Object.keys(lifecycle.fixed_in).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "lifecycle", "fixed_in"],
        message:
          "fixed_in must name at least one component and its first known-good version",
      });
    }
    if (undeclared.length > 0) {
      const declared = Object.keys(components).sort();
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "lifecycle", "fixed_in"],
        message:
          `fixed_in names undeclared component(s): ${undeclared.sort().join(", ")}; ` +
          (declared.length > 0
            ? `declared components: ${declared.join(", ")}`
            : "the scenario declares no fixtures.components"),
      });
    }
  }

  // A fixture that restricts itself to profiles the scenario never declares
  // can never run at all; catching it here beats a preflight failure that
  // depends on which executor happens to be active.
  for (const [name, fixture] of [
    ...Object.entries(scenario.fixtures.apps ?? {}),
    ...Object.entries(scenario.fixtures.probes ?? {}),
  ]) {
    const undeclared = (fixture.executors ?? []).filter(
      (executor) =>
        !(executor in scenario.load.profiles) &&
        !Object.values(scenario.load.executors).includes(executor),
    );
    if (undeclared.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fixtures", name, "executors"],
        message:
          `fixture "${name}" restricts itself to undeclared executor ` +
          `profile(s) ${undeclared.sort().join(", ")}; declared profiles: ` +
          Object.keys(scenario.load.profiles).sort().join(", "),
      });
    }
  }

  for (const [name, control] of Object.entries(
    scenario.verdict?.controls ?? {},
  )) {
    if (
      control.executor !== undefined &&
      !(control.executor in scenario.load.profiles)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verdict", "controls", name, "executor"],
        message:
          `control "${name}" names undeclared executor profile ` +
          `"${control.executor}"; declared profiles: ` +
          Object.keys(scenario.load.profiles).sort().join(", "),
      });
    }
  }

  if (mode !== "persisted") {
    return;
  }

  if (scenario.meta.lifecycle === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["meta", "lifecycle"],
      message:
        "persisted scenarios require an explicit lifecycle " +
        "(open | fixed | retired); `ass promote` stamps open",
    });
  }
  if (scenario.verdict === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verdict"],
      message:
        "persisted scenarios require a verdict; drafts in experiments/ may omit it",
    });
  } else if (scenario.verdict.baseline === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verdict", "baseline"],
      message:
        "persisted scenarios require verdict.baseline (D10) or an explicit " +
        "waiver with a reason: baseline: {waived: …}",
    });
  }
  for (const [name, selector] of Object.entries(components)) {
    const { mode: selectorMode, reason } = classifySelector(selector);
    if (selectorMode === "floating") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fixtures", "components", name],
        message:
          `persisted scenarios require pinned selectors; component "${name}" ` +
          `floats: ${reason}. Use \`ass promote\` to resolve pins, or ` +
          "override at run time (--component) for fix verification",
      });
    }
  }
}

function buildScenarioSchema(mode: ValidationMode): z.ZodType<Scenario> {
  return scenarioBaseSchema
    .superRefine((scenario, ctx) => crossValidate(scenario, mode, ctx))
    .transform(
      (scenario): Scenario =>
        ({
          ...scenario,
          meta: {
            ...scenario.meta,
            lifecycle: scenario.meta.lifecycle ?? { state: "open" },
          },
        }) as Scenario,
    ) as unknown as z.ZodType<Scenario>;
}

export const draftScenarioSchema = buildScenarioSchema("draft");
export const persistedScenarioSchema = buildScenarioSchema("persisted");

export function parseScenario(data: unknown, mode: ValidationMode): Scenario {
  const schema =
    mode === "draft" ? draftScenarioSchema : persistedScenarioSchema;
  return schema.parse(data);
}

export function formatScenarioIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("\n");
}
