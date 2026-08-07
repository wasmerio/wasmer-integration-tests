// Barmin — composes the integration-test quality assessment and posts it to
// Slack. Runs in the provide-quality-assessment job after all test jobs
// completed and their test-run-* artifacts were downloaded into
// TEST_RUNS_DIR.
//
// The message answers, in order: did anything NEW break (untracked
// failures)? what is still broken but tracked (known issues, linked to
// Linear via known-issues.jsonc, baked into the run summaries by the jest
// reporter)? did the environment itself fail (failed jobs without
// test-level failures)? and where to debug (test-run-* artifacts).
//
// Env contract (set by integration-test-workflow.yaml):
//   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SERVER_URL,
//   GITHUB_SHA, GITHUB_REF, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH,
//   GITHUB_STEP_SUMMARY
//   SLACK_WEBHOOK_URL   optional — compose-only when absent
//   TEST_RUNS_DIR       default "test-runs"
//   TESTED_REGISTRY     environment label (e.g. wasmer.wtf)
//   RELEASE_URL         optional release that triggered the run

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

const KnownIssueSchema = z.object({
  ticket: z.string(),
  url: z.string(),
  note: z.string().optional(),
});

const RunRecordSchema = z.object({
  startedAt: z.string(),
  completedAt: z.string(),
  numTotalTests: z.number(),
  numPassedTests: z.number(),
  numFailedTests: z.number(),
  numPendingTests: z.number(),
  tests: z.array(
    z.object({
      file: z.string(),
      fullName: z.string(),
      status: z.string(),
      durationMs: z.number().nullable().optional(),
      knownIssue: KnownIssueSchema.optional(),
    }),
  ),
  suiteErrors: z.array(
    z.object({
      file: z.string(),
      message: z.string(),
      knownIssue: KnownIssueSchema.optional(),
    }),
  ),
});

const SuiteManifestSchema = z.array(
  z.object({ id: z.string(), display_id: z.string().optional() }).passthrough(),
);

interface Finding {
  suite: string;
  file: string;
  name: string;
  ticket?: string;
  url?: string;
  note?: string;
}

interface FailedJob {
  name: string;
  url: string;
  suite: string | null;
}

interface Classification {
  untracked: Finding[];
  known: Finding[];
  fixedKnown: Finding[];
  infraJobs: FailedJob[];
  failedJobCount: number;
}

interface CommitInfo {
  sha: string;
  ref: string;
  url: string;
  author: string;
  email: string;
  message: string;
  mergedPrLine: string;
}

const SLACK_USERNAME_BY_EMAIL: Record<string, string> = {
  "me@syrusakbary.com": "syrus",
  "artem.yarulin@kapteko.com": "artem",
  "m.amin.rayej@gmail.com": "amin",
  "chris@theduke.at": "christoph",
};

const SELF_JOB_NAMES = new Set([
  "Provide quality assessment",
  "provide-quality-assessment",
  "Notify quality assessment",
  "notify-quality-assessment",
]);

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

async function gh<T>(apiPath: string): Promise<T> {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    headers: {
      Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API ${apiPath} failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

interface JobsResponse {
  jobs: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    html_url: string;
  }>;
}

// Maps a job display name ("Run apps tests", "Run templates (1/6) tests")
// back to the suite id ("apps", "templates-1-of-6") via the manifest.
function buildJobNameToSuiteMap(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const manifest = SuiteManifestSchema.parse(
      JSON.parse(
        fs.readFileSync(".github/integration-test-suites.json", "utf-8"),
      ),
    );
    for (const suite of manifest) {
      map.set(`Run ${suite.display_id ?? suite.id} tests`, suite.id);
    }
  } catch (error) {
    console.error(`barmin: could not read suite manifest: ${error}`);
  }
  return map;
}

function readRunRecords(
  testRunsDir: string,
): Map<string, z.infer<typeof RunRecordSchema>[]> {
  const bySuite = new Map<string, z.infer<typeof RunRecordSchema>[]>();
  if (!fs.existsSync(testRunsDir)) {
    console.error(`barmin: ${testRunsDir} does not exist; no summaries`);
    return bySuite;
  }
  for (const dir of fs.readdirSync(testRunsDir)) {
    const suite = dir.replace(/^test-run-/, "");
    const file = path.join(testRunsDir, dir, ".jest-run-summary.jsonl");
    if (!fs.existsSync(file)) {
      continue;
    }
    const records: z.infer<typeof RunRecordSchema>[] = [];
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        records.push(RunRecordSchema.parse(JSON.parse(line)));
      } catch (error) {
        console.error(`barmin: skipping bad record in ${file}: ${error}`);
      }
    }
    bySuite.set(suite, records);
  }
  return bySuite;
}

async function classify(testRunsDir: string): Promise<Classification> {
  const [owner, repo] = env("GITHUB_REPOSITORY").split("/");
  const { jobs } = await gh<JobsResponse>(
    `/repos/${owner}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}/jobs?per_page=100`,
  );
  // Called as a reusable workflow, job names carry a "<caller job> / "
  // prefix — always match on the bare suffix.
  const bareName = (name: string): string => name.split(" / ").pop() ?? name;
  const failedJobs = jobs.filter(
    (job) =>
      job.conclusion === "failure" && !SELF_JOB_NAMES.has(bareName(job.name)),
  );

  const untracked: Finding[] = [];
  const known: Finding[] = [];
  const fixedKnown: Finding[] = [];
  const suitesWithTestFailures = new Set<string>();

  for (const [suite, records] of readRunRecords(testRunsDir)) {
    for (const record of records) {
      for (const test of record.tests) {
        const finding: Finding = {
          suite,
          file: test.file,
          name: test.fullName,
          ticket: test.knownIssue?.ticket,
          url: test.knownIssue?.url,
          note: test.knownIssue?.note,
        };
        if (test.status === "failed") {
          suitesWithTestFailures.add(suite);
          (test.knownIssue ? known : untracked).push(finding);
        } else if (test.status === "passed" && test.knownIssue) {
          fixedKnown.push(finding);
        }
      }
      for (const suiteError of record.suiteErrors) {
        suitesWithTestFailures.add(suite);
        (suiteError.knownIssue ? known : untracked).push({
          suite,
          file: suiteError.file,
          name: `suite failed to run (${suiteError.file})`,
          ticket: suiteError.knownIssue?.ticket,
          url: suiteError.knownIssue?.url,
        });
      }
    }
  }

  // A failed job whose suite reported no failing tests died outside jest:
  // bring-up, artifact upload, timeout, or a runner problem.
  const jobNameToSuite = buildJobNameToSuiteMap();
  const infraJobs: FailedJob[] = failedJobs
    .map((job) => ({
      name: job.name,
      url: job.html_url,
      suite: jobNameToSuite.get(bareName(job.name)) ?? null,
    }))
    .filter(
      (job) => job.suite === null || !suitesWithTestFailures.has(job.suite),
    );

  return {
    untracked,
    known,
    fixedKnown,
    infraJobs,
    failedJobCount: failedJobs.length,
  };
}

interface EventPayload {
  pull_request?: {
    number: number;
    merged?: boolean;
    html_url?: string;
    title?: string;
    head?: { sha?: string; ref?: string };
  };
  release?: { html_url?: string };
}

interface CommitResponse {
  commit: { author: { name: string; email: string }; message: string };
}

interface AssociatedPr {
  number: number;
  title: string;
  html_url: string;
  merged_at: string | null;
  base?: { ref?: string };
}

async function getCommitInfo(): Promise<CommitInfo> {
  const [owner, repo] = env("GITHUB_REPOSITORY").split("/");
  let payload: EventPayload = {};
  try {
    payload = JSON.parse(
      fs.readFileSync(env("GITHUB_EVENT_PATH"), "utf-8"),
    ) as EventPayload;
  } catch {
    // Payload is optional context; fall back to plain env vars.
  }
  const pr = payload.pull_request;
  const sha = pr?.head?.sha ?? env("GITHUB_SHA");
  const ref = (pr?.head?.ref ?? env("GITHUB_REF")).replace(
    /^refs\/(heads|tags)\//,
    "",
  );
  const url = `${env("GITHUB_SERVER_URL", "https://github.com")}/${owner}/${repo}/commit/${sha}`;

  let author = "unknown";
  let email = "";
  let message = "";
  try {
    const commit = await gh<CommitResponse>(
      `/repos/${owner}/${repo}/commits/${sha}`,
    );
    author = commit.commit.author.name;
    email = commit.commit.author.email;
    message = commit.commit.message;
  } catch (error) {
    console.error(`barmin: could not load commit ${sha}: ${error}`);
  }

  let mergedPrLine = "";
  if (pr?.merged === true && pr.html_url) {
    mergedPrLine =
      `*Merged PR:* <${pr.html_url}|#${pr.number}> ${pr.title ?? ""}`.trim();
  } else if (
    !pr &&
    env("GITHUB_EVENT_NAME") === "push" &&
    env("GITHUB_REF").startsWith("refs/heads/")
  ) {
    const branch = ref;
    try {
      const prs = await gh<AssociatedPr[]>(
        `/repos/${owner}/${repo}/commits/${sha}/pulls`,
      );
      const merged = prs
        .filter((p) => p.merged_at && p.base?.ref === branch)
        .sort((a, b) => Date.parse(b.merged_at!) - Date.parse(a.merged_at!));
      if (merged[0]) {
        mergedPrLine = `*Merged PR:* <${merged[0].html_url}|#${merged[0].number}> ${merged[0].title}`;
      }
    } catch (error) {
      console.error(`barmin: could not load PRs for ${sha}: ${error}`);
    }
  }

  return { sha, ref, url, author, email, message, mergedPrLine };
}

function findingLine(finding: Finding): string {
  if (finding.ticket && finding.url) {
    const note = finding.note ? ` — ${finding.note}` : "";
    return `• <${finding.url}|${finding.ticket}> ${finding.name} _(${finding.suite})_${note}`;
  }
  return `• ${finding.name} — \`${finding.file}\` _(${finding.suite})_`;
}

function composeMessage(
  classification: Classification,
  commit: CommitInfo,
): { text: string; failed: boolean } {
  const { untracked, known, fixedKnown, infraJobs, failedJobCount } =
    classification;
  const failed = failedJobCount > 0;
  const shortSha = commit.sha.slice(0, 7);
  const suspect =
    SLACK_USERNAME_BY_EMAIL[commit.email] ?? commit.email.split("@")[0];
  const runUrl = `${env("GITHUB_SERVER_URL", "https://github.com")}/${env("GITHUB_REPOSITORY")}/actions/runs/${env("GITHUB_RUN_ID")}`;
  const lines: string[] = ["──────────────────────────────────────────────"];

  if (!failed) {
    lines.push(
      `🎉 All green from update in *${env("GITHUB_REPOSITORY")}*! Good job *${commit.author}*! 🙌`,
    );
  } else if (untracked.length > 0) {
    lines.push(
      "*Uh-oh, what happened here?☝️ *",
      `${untracked.length} failure(s) nobody has diagnosed yet... Who dunit'?`,
      `Primary suspect: *<@${suspect}>*`,
    );
  } else if (known.length > 0) {
    lines.push(
      ":warning: *Tests are red, but nothing new broke.*",
      `All ${known.length} failing test(s) are known issues tracked in Linear (listed below).`,
    );
  } else {
    lines.push(
      ":construction: *Test job(s) failed without producing test results.*",
      "Likely an environment or bring-up failure rather than a test failure — check the job logs.",
    );
  }

  if (untracked.length > 0) {
    lines.push(
      "",
      `:fire: *UNTRACKED failures (${untracked.length}) — no Linear ticket on record:*`,
      ...untracked.map(findingLine),
      "_Diagnose and register via the file-known-issue skill (known-issues.jsonc)._",
    );
  }
  if (known.length > 0) {
    lines.push(
      "",
      `:warning: *Known issues (${known.length}):*`,
      ...known.map(findingLine),
    );
  }
  if (infraJobs.length > 0) {
    lines.push(
      "",
      `:construction: *Job failures without test-level data (${infraJobs.length}):*`,
      ...infraJobs.map((job) => `• <${job.url}|${job.name}>`),
    );
  }
  if (fixedKnown.length > 0) {
    lines.push(
      "",
      "*🎉 Known issues now passing — consider removing from known-issues.jsonc:*",
      ...fixedKnown.map(findingLine),
    );
  }

  lines.push(
    "",
    `*Environment:* ${env("TESTED_REGISTRY", "unknown")}`,
    `*Repository:* ${env("GITHUB_REPOSITORY")}`,
    `*Commit:* <${commit.url}|${shortSha}> (${commit.ref})`,
  );
  if (commit.mergedPrLine) {
    lines.push(commit.mergedPrLine);
  }
  if (env("RELEASE_URL")) {
    lines.push(`*Release:* ${env("RELEASE_URL")}`);
  }
  lines.push("", "*Commit message:*", "```", commit.message, "```");
  if (failed) {
    lines.push(
      "",
      `Debug: full jest output + deployed-app registry per suite in the <${runUrl}#artifacts|test-run-* artifacts>.`,
    );
  }
  if (untracked.length > 0) {
    lines.push(
      "",
      "*Investigate agentically — paste this into your hivemind agent:*",
      "```",
      `Investigate the wasmer integration test failures in ${runUrl} (load your integration-test-failure skill): download the test-run-* artifacts, root-cause each UNTRACKED failure, and for confirmed product bugs file a Linear ticket and register the test in known-issues.jsonc (file-known-issue skill).`,
      "```",
    );
  }

  return { text: lines.join("\n"), failed };
}

async function postToSlack(text: string): Promise<void> {
  const webhook = env("SLACK_WEBHOOK_URL");
  if (!webhook) {
    console.log("barmin: SLACK_WEBHOOK_URL not set; skipping Slack post");
    return;
  }
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(
      `Slack webhook failed: ${response.status} ${await response.text()}`,
    );
  }
}

async function main(): Promise<void> {
  const classification = await classify(env("TEST_RUNS_DIR", "test-runs"));
  const commit = await getCommitInfo();
  const { text, failed } = composeMessage(classification, commit);

  console.log(text);
  if (failed && env("GITHUB_STEP_SUMMARY")) {
    fs.appendFileSync(env("GITHUB_STEP_SUMMARY"), `${text}\n`);
  }
  await postToSlack(text);
}

main().catch((error) => {
  console.error(`barmin: ${error}`);
  process.exitCode = 1;
});
