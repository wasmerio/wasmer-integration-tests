// ass CLI: list | try | run | promote | doctor (docs/anti-slop-shield-v1.md
// §3/§5). `try` and `run` are the same engine over the same file format —
// what differs is the boundary they search and the assessment they derive
// (D6) — and they share one override surface (D12). Command routing is
// commander (D16 as amended); domain validation stays ours.

import path from "node:path";
import process from "node:process";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import {
  AmbiguousSlugError,
  listScenarios,
  loadScenario,
  rootsFrom,
  ScenarioLoadError,
  ScenarioNotFoundError,
  type LoadedScenario,
  type ScenarioKind,
} from "./scenario/loader";
import { classifySelector } from "./scenario/selectors";
import { promoteScenario, PromoteError } from "./scenario/promote";
import {
  formatDoctor,
  runDoctor,
  type DoctorOptions,
} from "./bootstrap/doctor";
import { TARGET_ENVS, type TargetEnv } from "./executors/contract";
import { EXIT_OK, EXIT_USAGE, type RunMode } from "./engine/assessment";
import { PreflightError } from "./engine/capabilities";
import { runScenario, type RunnerDeps } from "./engine/runner";
import { colorEnabled } from "./report/style";
import { Presenter } from "./report/presenter";
import { ExecutorProfileError } from "./executors/jest";
import type { SimulatorDeps } from "./simulator/deps";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CliOptions {
  cwd?: string;
  io?: CliIo;
  /** Test seam: fake the platform driver / deployer / workload exec. */
  runnerDeps?: RunnerDeps;
  /** Test seam: fake the toolchain probes doctor runs. */
  doctor?: Omit<DoctorOptions, "cwd">;
  /** Test seam: fake the simulator's platform driver / probe / registries. */
  simulatorDeps?: SimulatorDeps;
  /** Colorize output. Defaults to sniffing `process.stdout`, which is only
   * the right question when `io` is unset and actually writes there. */
  color?: boolean;
}

export interface Overrides {
  env: TargetEnv;
  cpus?: number;
  executor?: string;
  components: Record<string, string>;
  /** Production's acknowledgement gate (Phase 5). */
  prodAcknowledged?: boolean;
}

class UsageError extends Error {}

/** Raw flag values as commander hands them to a try/run action. */
interface OverrideFlagValues {
  env: TargetEnv;
  cpus?: number;
  executor?: string;
  component: Record<string, string>;
  edge?: string;
  backend?: string;
  verbose?: boolean;
  iKnowThisIsProd?: boolean;
}

function parseEnv(value: string): TargetEnv {
  if (!(TARGET_ENVS as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(
      `unknown --env "${value}"; known environments: ${TARGET_ENVS.join(", ")}`,
    );
  }
  return value as TargetEnv;
}

function parseCpus(value: string): number {
  const cpus = Number(value);
  if (!Number.isInteger(cpus) || cpus <= 0) {
    throw new InvalidArgumentError(
      `--cpus must be a positive integer, got "${value}"`,
    );
  }
  return cpus;
}

function collectComponent(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const eq = value.indexOf("=");
  if (eq <= 0 || eq === value.length - 1) {
    throw new InvalidArgumentError(
      `--component expects <name>=<selector>, got "${value}"`,
    );
  }
  const name = value.slice(0, eq);
  if (name in previous) {
    throw new InvalidArgumentError(
      `duplicate override for component "${name}"`,
    );
  }
  return { ...previous, [name]: value.slice(eq + 1) };
}

// --edge/--backend are sugar for the matching --component entries (D12), so
// collisions between the two spellings are still duplicate overrides.
function overridesFrom(flags: OverrideFlagValues): Overrides {
  const overrides: Overrides = {
    env: flags.env,
    cpus: flags.cpus,
    executor: flags.executor,
    components: { ...flags.component },
    prodAcknowledged: flags.iKnowThisIsProd === true,
  };
  const setComponent = (name: string, selector: string): void => {
    if (name in overrides.components) {
      throw new UsageError(`duplicate override for component "${name}"`);
    }
    overrides.components[name] = selector;
  };
  if (flags.edge !== undefined) {
    setComponent("edge", flags.edge);
  }
  if (flags.backend !== undefined) {
    setComponent("backend", flags.backend);
  }
  return overrides;
}

export function validateOverrides(
  loaded: LoadedScenario,
  overrides: Overrides,
): void {
  const declaredComponents = Object.keys(
    loaded.scenario.fixtures.components ?? {},
  ).sort();
  for (const name of Object.keys(overrides.components)) {
    if (!declaredComponents.includes(name)) {
      throw new UsageError(
        `--component override names undeclared component "${name}"; ` +
          (declaredComponents.length > 0
            ? `declared components: ${declaredComponents.join(", ")}`
            : "the scenario declares no fixtures.components"),
      );
    }
  }
  if (overrides.executor !== undefined) {
    const profiles = Object.keys(loaded.scenario.load.profiles).sort();
    if (!profiles.includes(overrides.executor)) {
      throw new UsageError(
        `--executor names undeclared profile "${overrides.executor}"; ` +
          `declared profiles: ${profiles.join(", ")}`,
      );
    }
  }
}

// D12: any component override switches the run's assessment to floating mode;
// a draft also floats when its own declaration uses floating selectors. A
// remote target with declared platform components floats too: the target
// runs whatever it runs, so the declared `edge`/`backend` pins were not
// honored and a "pinned" claim would attribute the run to versions it never
// used (the R4-01 rule).
export function deriveRunMode(
  loaded: LoadedScenario,
  overrides: Overrides,
): RunMode {
  if (Object.keys(overrides.components).length > 0) {
    return "floating";
  }
  const components = loaded.scenario.fixtures.components ?? {};
  if (
    overrides.env !== "local" &&
    Object.keys(components).some(
      (name) => name === "edge" || name === "backend",
    )
  ) {
    return "floating";
  }
  const declaredFloating = Object.values(components).some(
    (selector) => classifySelector(selector).mode === "floating",
  );
  return declaredFloating ? "floating" : "pinned";
}

function isTruthy(value: string | undefined): boolean {
  return (
    value !== undefined && !["", "0", "false", "no", "off"].includes(value)
  );
}

async function runCommand(
  kind: ScenarioKind,
  slug: string,
  overrides: Overrides,
  cwd: string,
  io: CliIo,
  color: boolean,
  deps?: RunnerDeps,
  verbose = false,
): Promise<number> {
  const loaded = loadScenario(rootsFrom(cwd), kind, slug);
  validateOverrides(loaded, overrides);
  const mode = deriveRunMode(loaded, overrides);
  // The presenter opens the table here and the summary closes it, so a run
  // reads as one continuous piece of output rather than four programs talking
  // over each other.
  const presenter = new Presenter({
    io,
    color,
    verbose: verbose || isTruthy(process.env["VERBOSE"]),
    // The live progress wave draws only on a real terminal: its repaints
    // are carriage-return games that would corrupt piped or CI output.
    animate: process.stdout.isTTY === true ? process.stdout : undefined,
  });
  presenter.banner(loaded.scenario.meta.id, loaded.scenario.meta.title);
  presenter.step("scenario", [
    ["env", overrides.env],
    ["mode", mode],
    ...(kind === "experiment"
      ? ([["kind", "draft"]] as Array<[string, string]>)
      : ([["lifecycle", loaded.scenario.meta.lifecycle.state]] as Array<
          [string, string]
        >)),
  ]);
  try {
    return await runScenario(loaded, overrides, mode, {
      cwd,
      io,
      deps,
      presenter,
    });
  } catch (err) {
    // The table is already open; a preflight or profile error has to be
    // reported inside it and leave the frame closed, not escape as a bare
    // stderr line in a foreign format.
    if (err instanceof PreflightError || err instanceof ExecutorProfileError) {
      const [summary, ...detail] = err.message.split("\n");
      presenter.step("error", summary, "red");
      for (const line of detail) {
        presenter.error(line);
      }
      presenter.close();
      return EXIT_USAGE;
    }
    throw err;
  }
}

export async function runCli(
  argv: string[],
  options: CliOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const io = options.io ?? {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  const color = options.color ?? colorEnabled();
  let code = EXIT_OK;
  const chomp = (s: string): string => (s.endsWith("\n") ? s.slice(0, -1) : s);

  const program = new Command("ass")
    .description("(a)nti (s)lop (s)hield — declarative failure reproductions")
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.out(chomp(s)),
      writeErr: (s) => io.err(chomp(s)),
    });

  // Uniform duplicate rejection for single-valued flags (review 1, R1-04).
  const seen = new Set<string>();
  const once =
    <T>(flag: string, parse: (value: string) => T) =>
    (value: string): T => {
      if (seen.has(flag)) {
        throw new InvalidArgumentError(`duplicate ${flag}`);
      }
      seen.add(flag);
      return parse(value);
    };

  const withOverrideFlags = (cmd: Command): Command =>
    cmd
      .option(
        "--env <env>",
        `target environment (${TARGET_ENVS.join("|")})`,
        once("--env", parseEnv),
        "local" as TargetEnv,
      )
      .option(
        "--cpus <n>",
        "CPU cap perturbation (local target only)",
        once("--cpus", parseCpus),
      )
      .option(
        "--executor <name>",
        "select a declared load profile",
        once("--executor", (value) => value),
      )
      .option(
        "--component <name=selector>",
        "override a declared component (repeatable)",
        collectComponent,
        {},
      )
      .option(
        "--edge <selector>",
        "sugar for --component edge=<selector>",
        once("--edge", (value) => value),
      )
      .option(
        "--backend <selector>",
        "sugar for --component backend=<selector>",
        once("--backend", (value) => value),
      )
      .option(
        "--verbose",
        "show everything the chained tools print, not just the notable lines",
      )
      .option(
        "--i-know-this-is-prod",
        "acknowledge a production run (still interactively confirmed and " +
          "capped; Phase 5)",
      );

  program
    .command("list")
    .description("List known scenarios; experimental entries marked")
    .action(() => {
      for (const ref of listScenarios(rootsFrom(cwd))) {
        io.out(
          ref.kind === "experiment" ? `${ref.slug}  (experimental)` : ref.slug,
        );
      }
    });

  withOverrideFlags(
    program
      .command("try <slug>")
      .description("Run a draft from experiments/ (draft validation)"),
  ).action(async (slug: string, flags: OverrideFlagValues) => {
    code = await runCommand(
      "experiment",
      slug,
      overridesFrom(flags),
      cwd,
      io,
      color,
      options.runnerDeps,
      flags.verbose === true,
    );
  });
  withOverrideFlags(
    program
      .command("run <slug>")
      .description("Run a persisted scenario from repros/ (strict validation)"),
  ).action(async (slug: string, flags: OverrideFlagValues) => {
    code = await runCommand(
      "repro",
      slug,
      overridesFrom(flags),
      cwd,
      io,
      color,
      options.runnerDeps,
      flags.verbose === true,
    );
  });

  program
    .command("promote <slug>")
    .description("Graduate a draft from experiments/ to repros/, pinned")
    .action((slug: string) => {
      const result = promoteScenario(cwd, slug);
      io.out(`promoted ${result.slug}`);
      io.out(
        `  ${path.relative(cwd, result.from)} → ${path.relative(cwd, result.to)}`,
      );
      for (const [name, selector] of Object.entries(result.pinned)) {
        const declared = result.overridden[name];
        io.out(
          declared === undefined
            ? `  pinned ${name}: ${selector}`
            : `  pinned ${name}: ${selector} (from your --component ` +
                `override; the draft declared ${declared})`,
        );
      }
      for (const name of result.kept) {
        io.out(`  kept ${name} (already pinned)`);
      }
      io.out(
        `  review ${path.join(path.relative(cwd, result.to), "README.md")}, ` +
          `then commit and run: pnpm ass run ${result.slug}`,
      );
    });
  // Engine selection: v2 (the reconciler) is the default; `--engine v1` or
  // SIM_ENGINE=v1 falls back to the v1 rebuild-shaped seeder.
  const engineChoice = (flag: string | undefined): "v1" | "v2" =>
    (flag ?? process.env["SIM_ENGINE"] ?? "v2") === "v1" ? "v1" : "v2";

  // Simulator lifecycle verbs (business-simulator-v1 §2.1). Deliberately no
  // --env/--component/--edge/--backend/--cpus: the simulator declares no
  // component pins, is local-only by construction, and must never mutate
  // local.env or the compose file (harness hermeticity).
  program
    .command("up")
    .description(
      "Seed and hold simulated product state on the local platform " +
        "(declaration file with assSchema: 1)",
    )
    .requiredOption("--file <path>", "simulator declaration to seed")
    .option(
      "--set <path=value>",
      "tweak the declaration without editing the file (repeatable), e.g. " +
        "--set apps.count=13 --set telemetry.rps.perApp.my-app=2",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--plan",
      "validate and print the resolved expansion; write nothing",
    )
    .option(
      "--verbose",
      "show everything the platform tooling prints, not just notable lines",
    )
    .option(
      "--exact",
      "two-sided telemetry diffing (CI's mode, not a developer's)",
    )
    .option(
      "--verify",
      "re-observe after applying; the plan must come back empty (I1)",
    )
    .option("--anchor <iso>", "pin the reconcile anchor (tests)")
    .option("--workers <n>", "global worker width", (value: string) =>
      Number(value),
    )
    .option("--workers-sdk <n>", "SDK lane width", (value: string) =>
      Number(value),
    )
    .option(
      "--workers-clickhouse <n>",
      "ClickHouse lane width",
      (value: string) => Number(value),
    )
    .option("--workers-postgres <n>", "Postgres lane width", (value: string) =>
      Number(value),
    )
    .option("--engine <v1|v2>", "state engine (default: v2, the reconciler)")
    .action(
      async (flags: {
        file: string;
        set: string[];
        plan?: boolean;
        verbose?: boolean;
        exact?: boolean;
        verify?: boolean;
        anchor?: string;
        workers?: number;
        workersSdk?: number;
        workersClickhouse?: number;
        workersPostgres?: number;
        engine?: string;
      }) => {
        if (engineChoice(flags.engine) === "v1") {
          const { runUp } = await import("./simulator/up");
          code = await runUp({
            file: flags.file,
            set: flags.set,
            plan: flags.plan === true,
            verbose: flags.verbose === true,
            cwd,
            io,
            deps: options.simulatorDeps,
          });
          return;
        }
        const { runUpV2 } = await import("./simulator/v2/verbs");
        code = await runUpV2({
          ...flags,
          cwd,
          io,
          deps: options.simulatorDeps,
        });
      },
    );
  program
    .command("down [slug]")
    .description(
      "Release held simulated state (replays the teardown descriptor)",
    )
    .option("--file <path>", "declaration file; used only to locate the slug")
    .option("--verbose", "show teardown detail")
    .option(
      "--engine <v1|v2>",
      "state engine (default: whichever holds the slug)",
    )
    .action(
      async (
        slug: string | undefined,
        flags: { file?: string; verbose?: boolean; engine?: string },
      ) => {
        // A v2 hold is released by reconciling to the empty set; a v1 hold
        // still replays its recorded teardown entries.
        const { resolveDownEngine } = await import("./simulator/v2/dispatch");
        const engine =
          flags.engine ?? (await resolveDownEngine(cwd, slug, flags.file));
        if (engine === "v2") {
          const { runDownV2 } = await import("./simulator/v2/verbs");
          const { slugOfFile } = await import("./simulator/v2/dispatch");
          code = await runDownV2({
            slug: slug ?? (await slugOfFile(cwd, flags.file)),
            verbose: flags.verbose === true,
            cwd,
            io,
            color,
            deps: options.simulatorDeps,
          });
          return;
        }
        const { runDown } = await import("./simulator/down");
        code = await runDown({
          file: flags.file,
          slug,
          verbose: flags.verbose === true,
          cwd,
          io,
          deps: options.simulatorDeps,
        });
      },
    );

  const diffFlags = (
    command: import("commander").Command,
  ): import("commander").Command =>
    command
      .requiredOption(
        "--file <path>",
        "simulator declaration to compare against",
      )
      .option(
        "--set <path=value>",
        "tweak the declaration without editing the file (repeatable)",
        (value: string, previous: string[]) => [...previous, value],
        [] as string[],
      )
      .option("--exact", "two-sided telemetry diffing; surplus becomes a plan")
      .option("--anchor <iso>", "pin the reconcile anchor (tests)")
      .option("--verbose", "show engine detail");

  diffFlags(
    program
      .command("diff")
      .description(
        "Print what `ass up` would change; write nothing (the kubectl diff of the simulator)",
      ),
  ).action(async (flags: Record<string, unknown>) => {
    const { runDiffV2 } = await import("./simulator/v2/verbs");
    code = await runDiffV2({
      ...(flags as object),
      cwd,
      io,
      color,
      deps: options.simulatorDeps,
    } as never);
  });

  diffFlags(
    program
      .command("verify")
      .description(
        "Like `diff`, but exits non-zero when the plan is not empty (the I1 gate for CI)",
      ),
  ).action(async (flags: Record<string, unknown>) => {
    const { runDiffV2 } = await import("./simulator/v2/verbs");
    code = await runDiffV2({
      ...(flags as object),
      verifyMode: true,
      cwd,
      io,
      color,
      deps: options.simulatorDeps,
    } as never);
  });
  program
    .command("status")
    .description("Show held scenarios and platform liveness (always exits 0)")
    .option("--json", "stable machine-readable output")
    .action(async (flags: { json?: boolean }) => {
      const { runStatus } = await import("./simulator/status");
      code = await runStatus({
        json: flags.json === true,
        cwd,
        io,
        deps: options.simulatorDeps,
      });
    });

  program
    .command("present")
    .description(
      "Render piped output inside the ass table (a dev loop's servers, a " +
        "chained tool) - noise stays behind --verbose",
    )
    .option("--id <id>", "banner id", "ass")
    .option("--title <text>", "banner title", "")
    .option(
      "--block <key=value>",
      "a phase and its rows; extra rows are newline-separated (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--step <name>", "phase the streamed lines are quoted under")
    .option("--highlight <regex>", "always show lines matching this")
    .option(
      "--collapse <text>",
      "when nothing worth showing appears, print this one line instead of a frame",
    )
    .option("--verbose", "show every streamed line, not just notable ones")
    .action(
      async (flags: {
        id: string;
        title: string;
        block: string[];
        step?: string;
        highlight?: string;
        collapse?: string;
        verbose?: boolean;
      }) => {
        const { runPresent } = await import("./report/stream");
        code = await runPresent({
          id: flags.id,
          title: flags.title,
          blocks: flags.block,
          step: flags.step,
          highlight: flags.highlight,
          collapse: flags.collapse,
          verbose: flags.verbose === true || isTruthy(process.env["VERBOSE"]),
          color,
          io,
          animate: process.stdout.isTTY === true ? process.stdout : undefined,
        });
      },
    );

  program
    .command("doctor")
    .description("Report environment capabilities and how to fix them")
    .action(() => {
      const report = runDoctor({ cwd, ...options.doctor });
      for (const line of formatDoctor(report, { color })) {
        io.out(line);
      }
      code = report.ok ? EXIT_OK : EXIT_USAGE;
    });

  program
    .command("audit")
    .description(
      "Local corpus checks: open scenarios by staleness; fixed scenarios " +
        "whose latest floating run reproduced (a regression) exit 2",
    )
    .action(async () => {
      const { runAudit } = await import("./report/audit");
      const result = runAudit(cwd);
      for (const line of result.lines) {
        io.out(line);
      }
      code = result.exitCode;
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return code;
  } catch (err) {
    // commander already wrote its message (or help) via configureOutput.
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    // Known validation/preflight families exit 1 (D15); anything else is an
    // internal fault and propagates with its stack.
    if (
      err instanceof UsageError ||
      err instanceof PromoteError ||
      err instanceof PreflightError ||
      err instanceof ExecutorProfileError ||
      err instanceof ScenarioLoadError ||
      err instanceof ScenarioNotFoundError ||
      err instanceof AmbiguousSlugError
    ) {
      io.err(`error: ${err.message}`);
      return EXIT_USAGE;
    }
    throw err;
  }
}
