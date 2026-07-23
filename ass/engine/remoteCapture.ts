// D14-windowed capture of deployed-probe evidence on remote targets
// (Phase 5). The scan window opens at workload start (`wasmer app logs
// --from`) and closes after a bounded quiescence timeout: the poll stops once
// the log stopped growing for `quiescenceMs` (or `maxWaitMs` elapsed), and
// nothing emitted after that close is ever read — so a reused probe's earlier
// or later emissions can neither satisfy nor contaminate the exactly-once
// probe evaluation. The `http` channel is the engine's own GET against the
// deployed probe, captured to a file like every other verdict input.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ResolvedState } from "../executors/contract";
import type { Scenario, Verdict } from "../scenario/schema";
import type { PlannedChannel } from "./capabilities";
import { classifyLogStream, collectPredicates } from "./capabilities";
import type { ChannelCaptures } from "./probe";
import type { StreamSources } from "./verdict";
import type { RemoteApp, RemotePlatform } from "../fixtures/remote";

/** What `resolveRemote` stashes on `ResolvedState.remote`. */
export interface RemoteHandle {
  platform: RemotePlatform;
  /** Fixture name -> the app this run deployed for it. */
  deployed: Record<string, RemoteApp>;
}

export function remoteHandleOf(state: ResolvedState): RemoteHandle | null {
  return (state.remote as RemoteHandle | undefined) ?? null;
}

/** App-instance streams this run has to pull: the probe channels planned as
 * `app-logs`, plus every app-instance stream a predicate or collect entry
 * reads. `app` means both instance streams merged. */
export function neededAppStreams(
  verdict: Verdict | undefined,
  plans: readonly PlannedChannel[],
): string[] {
  const streams = new Set<string>();
  for (const plan of plans) {
    if (plan.source === "app-logs" && plan.channel.type === "log") {
      streams.add(plan.channel.stream);
    }
  }
  if (verdict !== undefined) {
    for (const predicate of collectPredicates(verdict)) {
      if (
        predicate.stream !== undefined &&
        classifyLogStream(predicate.stream) === "app-instance"
      ) {
        streams.add(predicate.stream);
      }
    }
    for (const entry of verdict.collect ?? []) {
      for (const spec of Object.values(entry)) {
        if (classifyLogStream(spec.stream) === "app-instance") {
          streams.add(spec.stream);
        }
      }
    }
  }
  return Array.from(streams).sort();
}

export interface CaptureOptions {
  /** Window open (D14): the workload's start, in epoch ms. */
  workloadStartMs: number;
  /** Window close: stop once the log stayed flat this long. */
  quiescenceMs?: number;
  /** Hard bound on the whole capture. */
  maxWaitMs?: number;
  pollMs?: number;
  httpTimeoutMs?: number;
  io?: { info: (line: string) => void };
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Pull one app-instance stream for every deployed app until quiescence.
 * Returns the captured file path. */
async function captureAppStream(
  handle: RemoteHandle,
  stream: string,
  artifactsDir: string,
  opts: CaptureOptions,
): Promise<string> {
  const quiescenceMs = opts.quiescenceMs ?? 10_000;
  const maxWaitMs = opts.maxWaitMs ?? 90_000;
  const pollMs = opts.pollMs ?? 3_000;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const cliStream =
    stream === "stdout" || stream === "stderr" ? stream : undefined;

  const pull = async (): Promise<string> => {
    const parts: string[] = [];
    for (const [fixture, app] of Object.entries(handle.deployed)) {
      const logs = await handle.platform.appLogs(app, {
        fromMs: opts.workloadStartMs,
        stream: cliStream,
      });
      parts.push(`# ${fixture} (${app.ident})\n${logs}`);
    }
    return parts.join("\n");
  };

  const started = now();
  let content = await pull();
  let flatSince = now();
  while (now() - started < maxWaitMs && now() - flatSince < quiescenceMs) {
    await sleep(pollMs);
    const next = await pull();
    if (next.length !== content.length) {
      flatSince = now();
      content = next;
    }
  }
  const file = path.join(artifactsDir, `probe.app-${stream}.log`);
  writeFileSync(file, content);
  return file;
}

export interface RemoteCapture {
  /** Channel label -> captured file, for `evaluateProbe`. */
  captures: ChannelCaptures;
  /** App-instance stream -> captured file, for `log_matches`/`collect`. */
  appStreamFiles: Record<string, string>;
}

/** Capture everything the verdict needs from the remote target, after the
 * workload and inside the D14 window. Capture failures degrade the channel
 * (an unavailable reading is `inconclusive`, never health) rather than
 * killing a run whose workload already completed. */
export async function captureRemote(
  scenario: Scenario,
  state: ResolvedState,
  plans: readonly PlannedChannel[],
  opts: CaptureOptions,
): Promise<RemoteCapture> {
  const io = opts.io ?? { info: () => {} };
  const handle = remoteHandleOf(state);
  const captures: ChannelCaptures = {};
  const appStreamFiles: Record<string, string> = {};
  if (handle === null || Object.keys(handle.deployed).length === 0) {
    return { captures, appStreamFiles };
  }

  for (const stream of neededAppStreams(scenario.verdict, plans)) {
    try {
      io.info(`capturing app logs (stream: ${stream}, D14 window)`);
      appStreamFiles[stream] = await captureAppStream(
        handle,
        stream,
        state.artifactsDir,
        opts,
      );
    } catch (err) {
      io.info(
        `warning: could not capture app-instance stream "${stream}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  for (const plan of plans) {
    if (plan.source === "app-logs" && plan.channel.type === "log") {
      const file = appStreamFiles[plan.channel.stream];
      if (file !== undefined) {
        captures[`log:${plan.channel.stream}`] = file;
      }
    } else if (plan.source === "http-fetch") {
      try {
        io.info("reading the deployed probe over HTTP");
        const bodies: string[] = [];
        for (const [fixture, app] of Object.entries(handle.deployed)) {
          const body = await handle.platform.fetchBody(
            app.url,
            opts.httpTimeoutMs ?? 90_000,
          );
          bodies.push(`# ${fixture} (${app.url})\n${body}`);
        }
        const file = path.join(state.artifactsDir, "probe.http-body.log");
        writeFileSync(file, bodies.join("\n"));
        captures["http:body"] = file;
      } catch (err) {
        io.info(
          "warning: could not read the deployed probe over HTTP: " +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return { captures, appStreamFiles };
}

/** Stream sources for a remote run: app-instance streams read the captured
 * D14-window files; platform-process streams have no remote adapter (they
 * fail preflight long before this). */
export function remoteStreamSources(
  appStreamFiles: Record<string, string>,
): StreamSources {
  return {
    read: (stream) => {
      const file = appStreamFiles[stream];
      if (file === undefined) {
        return null;
      }
      try {
        return readFileSync(file, "utf8").split("\n");
      } catch {
        return null;
      }
    },
    sourceOf: (stream) => appStreamFiles[stream] ?? null,
  };
}
