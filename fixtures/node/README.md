# Node fixture

Node implementation of the language-agnostic fixture contract in
[`../openapi.yaml`](../openapi.yaml). Zero-framework `node:http` server;
the only dependencies are the pure-JS database drivers (`pg`, `mysql2`)
needed by `/results`, loaded lazily so every other endpoint runs without
`node_modules`.

Intended for remote builds: the platform builds from `package.json`
(`npm start` → `node src/main.js`) — no Wasmer manifest is checked in.

Contract notes specific to this implementation:

- `/sync` vs `/async`: Node has no blocking HTTP I/O, so the two
  endpoints exercise the two distinct native network stacks instead —
  the callback-based `node:http(s)` client and the promise-based global
  `fetch` (undici).
- Counter atomicity comes from a per-counter promise chain (single
  process) rather than file locks.
- `__TEMPLATE__` in `src/main.js` is the per-deployment unique hash
  placeholder, replaced by the test harness like in the other fixtures.

Run locally:

```bash
DATA_DIR=/tmp/data PORT=8080 node src/main.js
```
