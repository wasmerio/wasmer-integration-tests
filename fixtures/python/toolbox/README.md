# Python Toolbox

Python implementation of the language-agnostic fixture contract — HTTP in
[`../../openapi.yaml`](../../openapi.yaml), WebSocket in
[`../../asyncapi.yaml`](../../asyncapi.yaml). FastAPI + uvicorn, built and
served through the Anybuild config in `Anybuild`; the database drivers are
the pure-Python `pg8000` and `PyMySQL` needed by `/results`, imported
lazily so every other endpoint runs without them.

Contract notes specific to this implementation:

- `/sync` runs the blocking `httpx` client in a worker thread (still the
  synchronous I/O path, without stalling the event loop); `/async` uses
  `httpx.AsyncClient` on the loop.
- Counter atomicity comes from a per-counter `asyncio.Lock` (single
  process) rather than file locks.
- `__TEMPLATE__` in `src/main.py` is the per-deployment unique hash
  placeholder, replaced by the test harness like in the other fixtures.
- `/self-test` runs the contract's inside-verifiable checks and answers
  200/500 with the aggregate report, for uptime probes. It never opens a
  connection back to the instance: guest loopback is not routable on
  Edge, and any other target would tie the probe to something outside
  the node.

Run locally:

```bash
uv sync
DATA_DIR=/tmp/data PORT=8000 uv run uvicorn src.main:app --port 8000
```
