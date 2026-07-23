"""WASIX repro: timed waits on threading primitives never expire.

Matrix of threading primitives; the timed-wait ones (Event.wait,
Lock.acquire(timeout), Condition.wait, Queue.get(timeout)) hang
forever on WASIX python 3.13.0rc2 while their untimed siblings work.
faulthandler.dump_traceback_later is collateral (C-level timed wait).

Modes:
  - one-shot: `wasmer run python/python@3.13.5 --volume .:/work -- /work/repro.py`
  - HTTP (Edge deploy): serves the matrix result on GET / (PORT env)

Hang-safety: each check runs in a daemon thread watched by a
wall-clock guard using only primitives verified to work under WASIX
(sleep + flag polling), so the report always completes.
"""

import faulthandler
import os
import queue
import sys
import tempfile
import threading
import time


GUARD_SECONDS = 4.0
TIMEOUT = 1.0  # timeout passed to each timed primitive


def run_check(name, fn, expect):
    result = {}

    def target():
        t0 = time.time()
        try:
            value = fn()
            result["value"] = repr(value)
        except Exception as exc:  # noqa: BLE001 - report, don't die
            result["value"] = f"raised {type(exc).__name__}"
        result["elapsed"] = time.time() - t0

    threading.Thread(target=target, daemon=True).start()
    deadline = time.time() + GUARD_SECONDS
    while time.time() < deadline and "elapsed" not in result:
        time.sleep(0.05)

    if "elapsed" not in result:
        return f"FAIL {name}: HUNG >{GUARD_SECONDS:.0f}s (expected {expect})"
    return (
        f"ok   {name}: {result['value']} "
        f"in {result['elapsed']:.2f}s (expected {expect})"
    )


def check_faulthandler():
    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        path = tmp.name
    try:
        with open(path, "w") as fh:
            faulthandler.dump_traceback_later(1, repeat=False, file=fh)
            time.sleep(3)
            faulthandler.cancel_dump_traceback_later()
        size = os.path.getsize(path)
        if size > 0:
            return f"ok   faulthandler.dump_traceback_later: fired ({size} bytes)"
        return "FAIL faulthandler.dump_traceback_later: never fired in 3s (interval=1s)"
    finally:
        os.unlink(path)


def run_matrix():
    lines = [f"python {sys.version}", f"platform {sys.platform}"]

    held = threading.Lock()
    held.acquire()
    lines.append(
        run_check(
            "Lock.acquire(blocking=False) on held lock",
            lambda: held.acquire(blocking=False),
            "False instantly",
        )
    )

    gate = threading.Lock()
    gate.acquire()
    threading.Thread(
        target=lambda: (time.sleep(0.5), gate.release()), daemon=True
    ).start()
    lines.append(
        run_check(
            "Lock.acquire() woken by other thread",
            gate.acquire,
            "True in ~0.5s",
        )
    )

    lines.append(run_check("time.sleep(0.5)", lambda: time.sleep(0.5), "~0.5s"))

    lines.append(
        run_check(
            f"Event.wait(timeout={TIMEOUT})",
            lambda: threading.Event().wait(timeout=TIMEOUT),
            f"False in ~{TIMEOUT}s",
        )
    )
    lines.append(
        run_check(
            f"Lock.acquire(timeout={TIMEOUT}) on held lock",
            lambda: held.acquire(timeout=TIMEOUT),
            f"False in ~{TIMEOUT}s",
        )
    )

    def cond_wait():
        cond = threading.Condition()
        with cond:
            return cond.wait(timeout=TIMEOUT)

    lines.append(
        run_check(
            f"Condition.wait(timeout={TIMEOUT})",
            cond_wait,
            f"False in ~{TIMEOUT}s",
        )
    )
    lines.append(
        run_check(
            f"Queue.get(timeout={TIMEOUT})",
            lambda: queue.Queue().get(timeout=TIMEOUT),
            f"raised Empty in ~{TIMEOUT}s",
        )
    )

    lines.append(check_faulthandler())

    fails = sum(1 for l in lines if l.startswith("FAIL"))
    lines.append(
        f"verdict: {'REPRODUCED - ' + str(fails) + ' primitive(s) broken' if fails else 'all primitives OK'}"
    )
    # ASS probe contract (D11): one marker line the harness reads off a
    # declared channel. It rides in the body so a deployed probe reports over
    # HTTP, and is repeated on stderr for process runs; identical repeats are
    # one logical verdict, so both may be seen at once.
    lines.append(ass_verdict(fails))
    return "\n".join(lines) + "\n"


def ass_verdict(fails):
    if fails:
        return f"ASS-VERDICT: reproduced {fails} primitive(s) broken"
    return "ASS-VERDICT: not-reproduced all primitives ok"


def serve(port):
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/health":
                body = b"ok\n"
            else:
                body = run_matrix().encode()
                # Mirror the ASS-VERDICT line to stderr so the deployed
                # probe's {type: log} channel (Vector->Loki app logs)
                # carries the same verdict as the HTTP body.
                print(
                    body.decode().rstrip("\n").rsplit("\n", 1)[-1],
                    file=sys.stderr,
                    flush=True,
                )
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *args):
            print(f"http: {fmt % args}", flush=True)

    print(f"serving on :{port}", flush=True)
    HTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    # Default is HTTP mode (Edge does not set PORT; it routes to 8080).
    if "--once" in sys.argv:
        report = run_matrix()
        print(report, end="", flush=True)
        # stderr is the {type: log} channel: stdout is where a wrapper is
        # most likely to interleave or swallow output.
        print(report.rstrip("\n").rsplit("\n", 1)[-1], file=sys.stderr, flush=True)
    else:
        serve(int(os.environ.get("PORT", "8080")))
