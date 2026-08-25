# PHP fixture

PHP implementation of the language-agnostic fixture contract — HTTP in
[`../../openapi.yaml`](../../openapi.yaml). A single docroot `index.php`
served by the **phpix** engine (the production PHP runtime: a native
multi-threaded server with an in-process PHP worker pool); no framework,
no composer dependencies. phpix's clean-URL routing dispatches every
non-file path through `index.php`, which is what makes the single-router
shape work — that routing exists from `0.3.0-rc` on (ECO-419), so the
deploy pins that line rather than `*`, which resolves to the pre-fix
`0.2.2`.

HTTP-only on purpose: phpix does not hold upgraded WebSocket connections,
so the [`asyncapi.yaml`](../../asyncapi.yaml) channel is not implemented
(the spec frames it as optional per fixture). `/ws` still answers
`426 Upgrade Required` and stays out of the catch-all, which is the HTTP
contract's half of the path reservation. WS-through-Edge coverage rides on
the node and python fixtures.

Contract notes specific to this implementation:

- `/sync` vs `/async`: PHP's two distinct native network stacks — the
  blocking stream wrapper (`file_get_contents`) and curl's non-blocking
  multi interface.
- Counter atomicity comes from `flock` on the counter file: phpix runs a
  pool of PHP worker threads, and instances share the volume.
- The catch-all log line goes to stderr only; PHP's stdout is the
  response body.
- `__TEMPLATE__` in `index.php` is the per-deployment unique hash
  placeholder, replaced by the test harness like in the other fixtures.
- `/self-test` runs the contract's inside-verifiable checks and answers
  200/500 with the aggregate report, for uptime probes. It never opens a
  connection back to the instance: guest loopback is not routable on
  Edge, and any other target would tie the probe to something outside
  the node.

Run locally with plain `php -S` (whose index.php routing matches phpix's
clean-URL behavior):

```bash
DATA_DIR=/tmp/data php -S 127.0.0.1:8080 index.php
```
