// Declared log lines (ClickHouse `app_logs`). The table has no owner
// column, so ownership is membership in a managed app; and it is the only
// table in the metrics schema with a TTL, which is why Q-G is refused at
// plan time (see the expander) rather than clamped here.

import { defaultDiff, type ResourceAdapter, type Scope } from "../adapter";
import {
  id,
  resource,
  type OpResult,
  type Operation,
  type Resource,
} from "../model";
import type { LogLineSpec } from "../specs";
import type { EngineContext } from "../engine/context";
import { failed, ok } from "./common";

const STREAM_NAMES: Record<string, LogLineSpec["stream"]> = {
  Stdout: "stdout",
  Stderr: "stderr",
  Runtime: "runtime",
  Unknown: "stdout",
};

const STREAM_VALUES: Record<LogLineSpec["stream"], string> = {
  stdout: "Stdout",
  stderr: "Stderr",
  runtime: "Runtime",
};

export const logLineAdapter: ResourceAdapter<LogLineSpec> = {
  kind: "log-line",
  lane: "clickhouse",
  granularity: "group",

  async observe(
    scope: Scope,
    ctx: EngineContext,
  ): Promise<Resource<LogLineSpec>[]> {
    const appPks = managedAppPks(ctx, scope);
    if (appPks.length === 0) {
      return [];
    }
    const body = await ctx.clickhouse.query(
      `SELECT app_id, toString(toUnixTimestamp64Nano(timestamp)), toString(stream), message
         FROM ${ctx.clickhouse.database}.app_logs
        WHERE app_id IN (${appPks.join(",")})
        ORDER BY app_id, timestamp FORMAT TSV`,
    );
    const observed: Array<Resource<LogLineSpec>> = [];
    let ordinal = 0;
    for (const line of body.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const [appPk, nanos, stream, ...message] = line.split("\t");
      const appId = ctx.identity.byNative("app", "pk", Number(appPk));
      if (appId === undefined) {
        continue;
      }
      const tsNanos = String(Math.round(Number(nanos) / 1e6) * 1e6);
      observed.push(
        resource<LogLineSpec>({
          id: id(
            "log-line",
            scope.namespace,
            appId.segments[1],
            tsNanos,
            String(ordinal++).padStart(5, "0"),
          ),
          spec: {
            namespace: scope.namespace,
            app: appId.segments[1],
            tsNanos,
            stream: STREAM_NAMES[stream] ?? "stdout",
            message: message.join("\t"),
          },
        }),
      );
    }
    return observed;
  },

  diff(desired, observed) {
    return defaultDiff("clickhouse", desired, observed);
  },

  async apply(
    ops: Operation<LogLineSpec>[],
    ctx: EngineContext,
  ): Promise<OpResult[]> {
    const writes = ops.filter((operation) => operation.type !== "delete");
    const deletes = ops.filter(
      (operation) => operation.type === "delete" || operation.type === "update",
    );
    try {
      if (deletes.length > 0) {
        const stamps = deletes
          .map(
            (operation) =>
              (operation.observed?.spec ?? operation.desired?.spec)?.tsNanos,
          )
          .filter((value): value is string => value !== undefined);
        const appPks = [
          ...new Set(
            deletes.map((operation) => {
              const spec = (operation.observed?.spec ??
                operation.desired?.spec) as LogLineSpec;
              return ctx.identity.requireNumber(
                id("app", spec.namespace, spec.app),
                "pk",
              );
            }),
          ),
        ];
        await ctx.clickhouse.query(
          `ALTER TABLE ${ctx.clickhouse.database}.app_logs DELETE
             WHERE app_id IN (${appPks.join(",")})
               AND toUnixTimestamp64Nano(timestamp) IN (${stamps.join(",")})
             SETTINGS mutations_sync = 2`,
          600_000,
        );
      }
      if (writes.length > 0) {
        const rows = writes.map((operation) => {
          const spec = (operation.desired as Resource<LogLineSpec>).spec;
          const appId = id("app", spec.namespace, spec.app);
          const native = ctx.identity.native(appId);
          return JSON.stringify({
            // DateTime64(9) parses a datetime literal, never a float: a
            // float is accepted by the HTTP layer and rejected by the
            // parser, which used to look like a successful insert.
            timestamp: nanosToDateTime(spec.tsNanos),
            app_id: ctx.identity.requireNumber(appId, "pk"),
            app_version_id: Number(native?.["activeVersionPk"] ?? 0),
            stream: STREAM_VALUES[spec.stream],
            message: spec.message,
            instance_id: "00000000-0000-4000-8000-000000000000",
            job_uid: "00000000-0000-4000-8000-000000000000",
          });
        });
        await ctx.clickhouse.query(
          `INSERT INTO ${ctx.clickhouse.database}.app_logs FORMAT JSONEachRow\n${rows.join("\n")}`,
        );
      }
      return ops.map((operation, index) =>
        ok(operation.id, index === 0 ? { logLines: writes.length } : undefined),
      );
    } catch (err) {
      return ops.map((operation) => failed(operation.id, err));
    }
  },
};

/** `1755540269123000000` -> `2026-08-18 17:44:29.123000000`. */
export function nanosToDateTime(nanos: string): string {
  const value = BigInt(nanos);
  const seconds = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, "0");
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ")}.${fraction}`;
}

function managedAppPks(ctx: EngineContext, scope: Scope): number[] {
  const pks: number[] = [];
  for (const entry of ctx.identity.toJSON()) {
    if (!entry.key.startsWith(`app:${scope.namespace}/`)) {
      continue;
    }
    const pk = entry.native["pk"];
    if (typeof pk === "number") {
      pks.push(pk);
    }
  }
  return pks;
}
