# ASS setup contract

You are setting up a machine to run **ass** (Anti Slop Shield), the declarative
failure-reproduction harness in this repository. This file states the end state
you must reach. It does not script you: how you get there depends on the
machine, and you can see the machine.

**The convergence test is `pnpm ass doctor`. Iterate until it exits 0.**

Run it first — it tells you exactly what is missing, what that costs, and a
suggested fix per item. Then fix, re-run, repeat. Nothing below is worth doing
if doctor is already green. (Doctor itself is TypeScript, so on a machine with
no `node_modules` it says so and points at `make setup`; that is the one item
you may have to fix before doctor can report the rest.)

## End state

| Capability             | Why it is needed                                                   | Required                     |
| ---------------------- | ------------------------------------------------------------------ | ---------------------------- |
| Node 22 or newer       | the harness and the Jest workloads                                 | yes                          |
| pnpm                   | the package manager this repo uses (`make setup` runs the install) | yes                          |
| `node_modules` present | `pnpm install` has been run at least once                          | yes                          |
| Python 3.12+           | the local-platform CLI that boots the disposable stack             | for `--env local` runs       |
| Docker + compose v2    | the disposable local platform runs in containers                   | for `--env local` runs       |
| `gh` authenticated     | pinned `github-release:` components download release assets        | for pinned scenarios         |
| `wasmer`               | `raw-wasmer` workloads                                             | for those scenarios          |
| `go`, `cargo`, …       | native baselines (D10): the differential half of a reproduction    | per scenario that names them |

Missing optional tools degrade one capability each — they never block the
harness itself, and doctor still exits 0. Be careful reading that as "ready":
local is the only target the engine runs today, so a machine without Docker or
Python 3.12+ cannot run _any_ scenario until remote targeting lands. A machine
with no Go, by contrast, simply cannot run a Go baseline.

## Hints, not instructions

- **Nix** — this repo ships a `flake.nix`. `nix develop` is the shortest path
  to the whole toolchain; prefer it when `nix` is present.
- **Debian/Ubuntu** — distro Node is usually too old. Use nodesource, `fnm`,
  `nvm`, or nix. Docker from `docker.io` may lack the compose v2 plugin; the
  plugin package is `docker-compose-plugin` (Docker's own repository).
- **macOS** — Homebrew for `node`, `pnpm`, `gh`, `go`; Docker Desktop or Colima
  for the container runtime.
- **pnpm** — `corepack enable pnpm` is enough on Node 22; no global install
  needed.
- **Docker permissions** — if `docker compose version` works but a run fails on
  socket permissions, the user is not in the `docker` group. Say so; do not
  silently `sudo` around it.

## Known failure modes

- **Rootful Docker writes root-owned cache entries.** ass wipes those through a
  container, so nothing needs `sudo`. If you find yourself reaching for `sudo
rm -rf` under `.local-platform/`, stop — that is the harness's job.
- **`gh` authenticated but release downloads 404.** The token needs read access
  to `wasmerio/edge` and `wasmerio/backend` releases; being logged in is not
  the same as having access.
- **A port is already allocated.** An interrupted run can leave containers
  behind. `make local-platform-down` is the supported teardown.
- **`local.env`.** Developer-local settings live here and ass appends its pins
  to a backed-up copy for the duration of a run. A stray `local.env.ass-bak`
  means a run died hard; restore it with `mv local.env.ass-bak local.env`.

## Rules for you, the agent

1. **Do not modify the repository.** Setup changes the machine, never the
   checked-out code. If a repository change looks necessary, report it instead
   of making it.
2. **Do not weaken the harness to make doctor pass.** Editing the capability
   table or faking a version is not convergence.
3. **Ask before anything destructive or system-wide** — package removals,
   Docker resets, changes to another tool's configuration.
4. **Report what you changed.** End with the list of installs and configuration
   changes you made, and the final `pnpm ass doctor` output.

## Then

```bash
pnpm ass list                # every known scenario
pnpm ass run wax-600         # the reference reproduction (boots a local stack)
```

`ass run` on a cold machine downloads pinned Edge and backend releases; the
first run is slow and every one after it hits the caches.
