#!/bin/sh
# `make ass` — the whole of ass's bootstrap script (docs/anti-slop-shield-v1.md
# §7). Setup is agent-driven, not script-driven: distro package managers, nix
# vs FHS, rootless Docker and half-installed toolchains are exactly the terrain
# where imperative bootstrap scripts rot. So this script only ever *detects*
# and *hands off*. It installs nothing and changes no configuration; the agent
# it summons reads ass/bootstrap/SETUP.md and converges on `ass doctor`.
#
# POSIX sh with no dependencies on purpose: it runs before Node, pnpm or
# python exist on the machine.
#
# Test seams (unset in normal use):
#   ASS_BOOTSTRAP_DRY_RUN=1     print the launch command, do not run it
#   ASS_BOOTSTRAP_HARNESSES=…   override the "<state dir>:<command>" table

set -u

PROMPT="Follow ass/bootstrap/SETUP.md in this repository to completion: bring this machine to the described end state, then run \`pnpm ass doctor\` and iterate until it exits 0."

HARNESSES=${ASS_BOOTSTRAP_HARNESSES:-".claude:claude .codex:codex .cursor:cursor-agent .gemini:gemini .aider:aider"}

say() {
	printf '%s\n' "$*"
}

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd) || exit 1
cd "$repo_root" || exit 1

# 1. Platform hints. Recorded for the agent to read, never acted upon.
platform=$(uname -s 2>/dev/null || echo unknown)
package_managers=""
for tool in nix brew apt-get dnf pacman zypper apk; do
	if command -v "$tool" >/dev/null 2>&1; then
		package_managers="$package_managers $tool"
	fi
done

say "ass bootstrap — detect and hand off (installs nothing itself)"
say "  repo:     $repo_root"
if [ -n "$package_managers" ]; then
	say "  platform: $platform (package managers:$package_managers )"
else
	say "  platform: $platform (no known package manager on PATH)"
fi

# 2. Which agentic harness does this developer actually use? Rank the state
#    directories that exist by recency (`ls -dt`), then take the first whose
#    command is on PATH.
home=${HOME:-}
candidates=""
for entry in $HARNESSES; do
	dir=${entry%%:*}
	if [ -n "$home" ] && [ -d "$home/$dir" ]; then
		candidates="$candidates $home/$dir"
	fi
done

command_for() {
	base=$(basename -- "$1")
	for pair in $HARNESSES; do
		if [ "${pair%%:*}" = "$base" ]; then
			printf '%s\n' "${pair#*:}"
			return 0
		fi
	done
	return 1
}

harness_cmd=""
harness_dir=""
uninstalled=""
if [ -n "$candidates" ]; then
	# shellcheck disable=SC2086 # word splitting is the list here
	for dir in $(ls -dt $candidates 2>/dev/null); do
		cmd=$(command_for "$dir") || continue
		if command -v "$cmd" >/dev/null 2>&1; then
			harness_cmd=$cmd
			harness_dir=$dir
			break
		fi
		uninstalled="$uninstalled $cmd"
	done
fi

quick_path() {
	say "  Manual quick path (the full contract is ass/bootstrap/SETUP.md):"
	if command -v nix >/dev/null 2>&1; then
		say "      nix develop        # this repo's flake.nix provides the toolchain"
	fi
	say "      make setup         # node 22+ check + pnpm install"
	say "      pnpm ass doctor    # iterate until this exits 0"
}

if [ -z "$harness_cmd" ]; then
	if [ -n "$uninstalled" ]; then
		say "  harness:  state found for$uninstalled, but no such command on PATH"
	else
		say "  harness:  none detected"
	fi
	say ""
	say "No agentic harness to hand off to. Either:"
	say "  1. Install one (claude, codex, cursor-agent, gemini) and re-run: make ass"
	say "  2. Set it up yourself:"
	quick_path
	exit 0
fi

say "  harness:  $harness_cmd (most recently used: $harness_dir)"
say ""
# The command is printed before it runs so the magic stays legible and
# re-runnable by hand.
say "Handing off to your agent (interactive — you watch and approve):"
say "  $harness_cmd \"$PROMPT\""
say ""

if [ "${ASS_BOOTSTRAP_DRY_RUN:-0}" = "1" ]; then
	exit 0
fi

"$harness_cmd" "$PROMPT"
status=$?
# 126/127 mean the command could not be run at all; any other code is the
# agent session's own result and belongs to the user, not to us.
if [ $status -eq 126 ] || [ $status -eq 127 ]; then
	say ""
	say "Could not launch $harness_cmd. Run the command above yourself, or:"
	quick_path
fi
exit $status
