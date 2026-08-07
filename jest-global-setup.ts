import { TestEnv } from "./src/index";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export default async () => {
  // Local runs: start each jest invocation with fresh run records so the
  // failure reporter never surfaces apps/results from a previous run. In CI
  // the workspace starts clean and multi-command suites (e.g. jobs) append
  // across invocations into one job artifact — truncating would drop the
  // earlier invocations' records.
  if (!process.env.CI) {
    await writeFile(path.join(process.cwd(), ".jest-deployed-apps.jsonl"), "");
    await writeFile(path.join(process.cwd(), ".jest-run-summary.jsonl"), "");
  }
  // Fetch all available app templates and write to a file.
  // This file is then used in tests/app/templates.test.ts to create a test
  // for each template.
  //
  // This is needed because Jest does not support dynamic test generation.
  const env = TestEnv.fromEnv();
  const templates = await env.backend.getAllAppTemplates();
  const SKIPLIST = ["wordpress"];
  const filtered = templates.filter(
    (tpl) => !SKIPLIST.some((skip) => tpl.slug.includes(skip)),
  );
  await writeFile(
    "./tests/generated-templates.json",
    JSON.stringify(filtered, null, 2),
  );
};
