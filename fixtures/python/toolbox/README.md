# Python Toolbox

Python implementation of the language-agnostic fixture contract — HTTP in
[`../../openapi.yaml`](../../openapi.yaml), WebSocket in
[`../../asyncapi.yaml`](../../asyncapi.yaml). FastAPI + uvicorn, built and
served through the Anybuild config in `Anybuild`; the database drivers
needed by `/results` are imported lazily so every other endpoint runs
without them.

Contract notes specific to this implementation:

- `/sync` runs the blocking `httpx` client in a worker thread (still the
  synchronous I/O path, without stalling the event loop); `/async` uses
  `httpx.AsyncClient` on the loop.
- `/results` connects with the pure-Python `pg8000`/`PyMySQL` drivers in a
  worker thread. The asynchronous route to the same database is a separate
  concern with its own name: SQLAlchemy's asyncio layer over `asyncpg`
  (PostgreSQL) or `aiomysql` (MySQL), reached by the `query-async`
  self-test check and by `query.request` on `/ws`.
- That asyncio layer drives the DBAPI inside a greenlet, so it is the only
  fixture path loading a native greenlet build — a deliberate canary for
  wasix wheels that are published but cannot be linked (BE-1773). Keeping
  it out of `db-connect` is what makes the report say _which_ stack broke:
  a bad greenlet leaves `/results` and `db-connect` green and fails
  `query-async` alone.
- Counter atomicity comes from a per-counter `asyncio.Lock` (single
  process) rather than file locks.
- `query.request` on `/ws` runs that same asyncio path, dispatched as a
  task so the channel keeps answering while a query is in flight. A query that cannot run answers `query_failed` on the
  channel rather than closing it.
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
