# Experiments — drafts in flight

One directory per investigation: `experiments/<slug>/scenario.toml` plus
whatever payloads it needs. Run one with

```bash
pnpm ass try <slug>
```

Drafts are relaxed on purpose. Component selectors may float
(`resolve_prod`, `latest`, a local `path:`), the `verdict` block may be
missing entirely (the run then just surfaces logs and metrics), and a draft
never alerts and is never scheduled — a failed experiment is a fact about the
experiment, not a regression.

**Commit them anyway, working or not.** A half-triggering scenario is a
collaboration artifact: "check out this branch, I can't quite get it to fire —
can you?" is a pull and one command, not a page of instructions.

When a draft reliably reproduces, graduate it:

```bash
pnpm ass promote <slug>
```

Promotion pins the floating selectors to what the last recorded run actually
resolved, stamps `lifecycle = { state = "open" }`, generates a provenance README, and moves
the directory to `repros/<slug>/` for review. It refuses a draft with no
verdict, no baseline (or reasoned waiver), or no recorded reproducing run —
and refuses without moving anything.
