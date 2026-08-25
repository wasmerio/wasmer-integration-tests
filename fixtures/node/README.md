# Node fixture

Node implementation of the language-agnostic fixture contract — HTTP in
[`../openapi.yaml`](../openapi.yaml), WebSocket in
[`../asyncapi.yaml`](../asyncapi.yaml). Zero-framework `node:http` server;
the dependencies are the pure-JS database drivers (`pg`, `mysql2`) needed
by `/results`, loaded lazily so every other endpoint runs without
`node_modules`, plus `ws` for the `/ws` channel.

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
- `/ws` runs on a `noServer` `WebSocketServer` driven from the HTTP
  server's `upgrade` event, so a plain `GET /ws` still reaches the router
  and answers `426`. Ping/pong and the closing handshake are handled by
  `ws` itself; the contract asserts them anyway, because a proxy in front
  of the app is what usually breaks them.
- `/self-test` runs the contract's inside-verifiable checks and answers
  200/500 with the aggregate report, for uptime probes. It never opens a
  connection back to the instance: guest loopback is not routable on
  Edge, and any other target would tie the probe to something outside
  the node.

Run locally:

```bash
DATA_DIR=/tmp/data PORT=8080 node src/main.js
```
