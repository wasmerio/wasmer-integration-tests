---
name: linear-ticket
description: Write and file Linear tickets in Wasmer's standard format — a two-sentence TL;DR, a handful of Context bullets, a minimal Reproduction, and images over prose. Use whenever asked to create, file, or draft a Linear ticket/issue for a bug, incident, or investigation finding, e.g. "create a ticket for this", "file this in team backend", "write this up in Linear".
license: Proprietary
compatibility: Uses the Linear MCP tools (list_teams, save_issue, prepare_attachment_upload, create_attachment_from_upload) when available; the format applies regardless of how the ticket is submitted.
---

# Linear ticket

Tickets must be approachable at a glance — a triager decides in seconds, and a wall of text buries the defect. Body order is always **TL;DR** → **Context** → **Reproduction**, with a total budget of ~150 words outside code blocks and images. If the draft runs long, cut the ticket, not the budget: deep detail belongs in a hivemind KB note that the ticket links.

## Title

Only the CORE of the issue — what a reader must know to care. No mechanism, no ID soup, no stacked clauses; aim for ≤60 characters. A severity prefix ("Breaking:", "Regression:") is welcome when earned.

- Good: `Breaking: rotated app db credentials absent from app`
- Bad: `App-DB credential changes never reach running apps: rotation leaves apps on revoked credentials, createAppDb injects nothing until redeploy` — that is the body's job.

## TL;DR

Exactly two sentences concentrating the issue: sentence one is what breaks, sentence two is the impact or cause. No links, no error dumps, no clause-stacking — if a sentence wants a semicolon or an em-dash chain, the overflow goes to Context or gets cut.

## Context

At most five bullets, one line each. Pick from: affected IDs + environment; the verbatim error (truncated) in backticks; root cause with a single `repo/path/file.ext:line`; the one key link (Sentry, dashboard, or KB note); a fix pointer naming viable options without prescribing steps. Anything that doesn't fit in five one-liners goes to a KB note, linked from here.

## Reproduction

The shortest command sequence a stranger can paste (≤10 lines, credentials via Doppler references, never inline secrets), followed by one line: `Expected: … Actual: …`. If reproduction isn't possible on demand, one line saying why, with the evidence link.

## Images first

If the problem is visible anywhere — dashboard state, a chart, terminal output — a screenshot showing exactly where the problem is beats paragraphs describing it. Capture (Playwright for UI), annotate the failing spot when it isn't obvious, upload via `prepare_attachment_upload` + `create_attachment_from_upload`, and embed in the body where the prose would have been. Keep secrets and tokens out of frame.

## Filing workflow

1. Draft body and title per above; trim to budget before filing.
2. Resolve the team with `list_teams` if unsure (backend code → Backend, edge → Edge, dashboard → Frontend, infra/incident → SRE, abuse → Trust & Safety, test flakiness → QA).
3. Create with `save_issue`: `team`, `title`, `description`, label when clear (`["Bug"]` for defects). Leave priority/assignee unset unless instructed.
4. Pass real newlines in `description`, not `\n` escapes.
5. Report the created identifier and URL back to the user.

## Validate

- The whole ticket reads in under a minute; body ≤~150 words outside code/images.
- Title ≤60 chars, core-only, no technical mechanism.
- TL;DR is exactly two sentences and stands alone for routing.
- Context has ≤5 bullets; every root-cause claim carries a file:line or query.
- Reproduction has no secrets and states Expected/Actual.
- Anything cut survives in a linked KB note, not in the ticket.

## Edge cases

- Feature requests / chores: same skeleton, rename Reproduction to a fitting section (e.g. "Acceptance").
- Cross-team findings: file where the primary fix lives; mention secondary fixes in a Context bullet.
- Updating an existing ticket: keep the format and the budget — add the new one-liner to Context rather than appending an "update" section; fold reporter screenshots/links into the body where they prove the point.
