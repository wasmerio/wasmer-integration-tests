#!/usr/bin/env python3
"""Entry point for the local platform tooling (see localplatform/).

Usage: python3 local-platform/cli.py {up,down,local-test,prepare,logs,collect-logs}

Dependency-free by design: only the Python standard library. Python 3.12+
matches what CI runners and dev machines already have; raise deliberately if
newer syntax is ever needed.
"""

import sys

MINIMUM_VERSION = (3, 12)

if sys.version_info < MINIMUM_VERSION:
    sys.exit(
        "local-platform tooling requires Python "
        f"{'.'.join(map(str, MINIMUM_VERSION))}+ "
        f"(found {sys.version.split()[0]} at {sys.executable})"
    )

from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from localplatform.cli import main

if __name__ == "__main__":
    sys.exit(main())
