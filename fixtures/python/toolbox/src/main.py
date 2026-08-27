# Python implementation of the fixture contract (fixtures/openapi.yaml for
# HTTP, fixtures/asyncapi.yaml for the /ws WebSocket channel), served by
# FastAPI/uvicorn. The pg8000/PyMySQL drivers are imported lazily inside the
# /results handler so every other endpoint works without them.

import asyncio
import json
import os
import random
import re
import ssl
import string
import sys
import time
from datetime import datetime

import httpx
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse, PlainTextResponse

app = FastAPI()

DATA_DIR = os.environ.get("DATA_DIR", "/data")
PORT = int(os.environ.get("PORT", "8000"))

# Replaced per deployment by the test harness, like the other fixtures.
UNIQUE_HASH = "__TEMPLATE__"

REQUIRED_DB_VARS = [
    "DB_HOST",
    "DB_PORT",
    "DB_USERNAME",
    "DB_PASSWORD",
    "DB_NAME",
]

COUNTER_NAME_RE = re.compile(r"^[a-z-]+$")


@app.get("/")
async def liveness():
    return {"message": "Hello World"}


# --- database-environment ---------------------------------------------------


def db_env_report():
    present = [name for name in REQUIRED_DB_VARS if os.environ.get(name) is not None]
    missing = [name for name in REQUIRED_DB_VARS if os.environ.get(name) is None]
    return {
        "present": present,
        "missing": missing,
        "host": os.environ.get("DB_HOST"),
        "port": os.environ.get("DB_PORT"),
        "name": os.environ.get("DB_NAME"),
        "username": os.environ.get("DB_USERNAME"),
        "hasPassword": os.environ.get("DB_PASSWORD") is not None,
        "hasDatabaseUrl": os.environ.get("DATABASE_URL") is not None,
        "hasDbEngine": os.environ.get("DB_ENGINE") is not None,
    }


@app.get("/db-env")
async def get_db_env_report():
    return JSONResponse(db_env_report())


# --- database-connectivity --------------------------------------------------


def db_engine():
    engine = os.environ.get("DB_ENGINE", "").lower()
    if "postgres" in engine or "pg" in engine:
        return "postgres"
    if "mysql" in engine or "maria" in engine:
        return "mysql"
    url = os.environ.get("DATABASE_URL", "")
    if url.startswith("postgres"):
        return "postgres"
    if url.startswith("mysql"):
        return "mysql"
    # Managed apps get neither DB_ENGINE nor DATABASE_URL, only DB_*.
    # Hostname contract: PostgreSQL endpoints live under psql.<region>,
    # MySQL under db.<region>/mysql.<region>.
    host = os.environ.get("DB_HOST", "")
    if host.startswith("psql."):
        return "postgres"
    if host.startswith(("db.", "mysql.")):
        return "mysql"
    if os.environ.get("DB_PORT") == "5432":
        return "postgres"
    if os.environ.get("DB_PORT") == "3306":
        return "mysql"
    # No engine signal (e.g. local platform: raw IP host, remapped port).
    return None


def connect_postgres(config):
    import pg8000.dbapi

    # TLS first (managed endpoints enforce sslmode=require), plaintext
    # fallback for TLS-less endpoints like the local platform.
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        conn = pg8000.dbapi.connect(**config, timeout=10, ssl_context=ctx)
        conn.close()
    except Exception as exc:
        if "ssl" not in str(exc).lower():
            raise
        conn = pg8000.dbapi.connect(**config, timeout=10)
        conn.close()


def connect_mysql(config):
    import pymysql

    conn = pymysql.connect(
        host=config["host"],
        port=config["port"],
        user=config["user"],
        password=config["password"],
        database=config["database"],
        connect_timeout=10,
    )
    conn.close()


def check_db_connection():
    missing = [name for name in REQUIRED_DB_VARS if os.environ.get(name) is None]
    if missing:
        return "Missing required SQL environment variables: " + ", ".join(missing)

    config = {
        "host": os.environ["DB_HOST"],
        "port": int(os.environ["DB_PORT"]),
        "user": os.environ["DB_USERNAME"],
        "password": os.environ["DB_PASSWORD"],
        "database": os.environ["DB_NAME"],
    }

    # When the engine is ambiguous, probe postgres first: pg8000 fails fast
    # against a MySQL server, while a MySQL client waits out its whole
    # connect timeout against PostgreSQL (both protocols expect the peer to
    # speak first).
    engine = db_engine()
    candidates = [engine] if engine else ["postgres", "mysql"]
    errors = []
    for candidate in candidates:
        try:
            if candidate == "postgres":
                connect_postgres(config)
            else:
                connect_mysql(config)
            return "OK"
        except Exception as exc:
            errors.append(f"{candidate}: {exc}")
    return "Connection failed: " + "; ".join(errors)


@app.get("/results")
async def check_db_connection_endpoint():
    return PlainTextResponse(await asyncio.to_thread(check_db_connection))


# --- durable-state ----------------------------------------------------------

# A per-counter asyncio lock serialises read-modify-write cycles inside this
# process. It says nothing about the other instances sharing the volume, so
# the write itself has to be atomic: see counter_value.
_counter_locks = {}


def _counter_lock(name):
    if name not in _counter_locks:
        _counter_locks[name] = asyncio.Lock()
    return _counter_locks[name]


async def counter_value(name, increment):
    async with _counter_lock(name):
        file = os.path.join(DATA_DIR, name)
        value = 0
        try:
            with open(file, "r", encoding="utf-8") as handle:
                raw = handle.read().strip()
            # A torn read must not look like a fresh counter, or the file gets
            # reset to 1 and every concurrent probe sees it go backwards.
            if not re.fullmatch(r"\d+", raw):
                raise ValueError(f"counter {name} holds a non-integer value: {raw!r}")
            value = int(raw)
        except FileNotFoundError:
            pass
        if increment:
            value += 1
            # Instances on other nodes read this file concurrently and replace
            # is atomic, so none of them can observe the truncated intermediate.
            tmp = f"{file}.{os.getpid()}.{time.monotonic_ns()}.tmp"
            with open(tmp, "w", encoding="utf-8") as handle:
                handle.write(str(value))
            os.replace(tmp, file)
        return value


async def handle_counter(name, increment):
    if not COUNTER_NAME_RE.fullmatch(name):
        return PlainTextResponse("Not Found", status_code=404)
    try:
        value = await counter_value(name, increment)
    except OSError:
        return PlainTextResponse(
            "Failed to access durable counter storage", status_code=500
        )
    return PlainTextResponse(str(value))


@app.get("/inc")
async def read_default_counter():
    return await handle_counter("counter", increment=False)


@app.post("/inc")
async def increment_default_counter():
    return await handle_counter("counter", increment=True)


@app.get("/inc/{name}")
async def read_named_counter(name: str):
    return await handle_counter(name, increment=False)


@app.post("/inc/{name}")
async def increment_named_counter(name: str):
    return await handle_counter(name, increment=True)


# --- outbound-http ----------------------------------------------------------


async def perform_request(method, target, timeout_ms, async_mode):
    timeout_s = timeout_ms / 1000
    start = time.monotonic()

    def elapsed():
        return int((time.monotonic() - start) * 1000)

    try:
        if async_mode:
            async with httpx.AsyncClient(timeout=timeout_s) as client:
                response = await client.request(method, target)
        else:
            # The blocking httpx client in a worker thread: still the
            # synchronous I/O path, without stalling the event loop (a
            # loopback target would otherwise deadlock the single process).
            response = await asyncio.to_thread(
                httpx.request, method, target, timeout=timeout_s
            )
        return {
            "body": response.text,
            "status_code": response.status_code,
            "elapsed_time_ms": elapsed(),
        }
    except Exception as exc:
        # httpx timeout exceptions stringify empty; the contract requires a
        # non-empty in-band reason.
        return {
            "error": str(exc) or type(exc).__name__,
            "status_code": 500,
            "elapsed_time_ms": elapsed(),
        }


async def proxy_endpoint(request: Request, async_mode: bool):
    payload = await request.json()
    return await perform_request(
        payload["method"], payload["target"], payload["timeout_ms"], async_mode
    )


@app.post("/async")
async def proxy_request_non_blocking(request: Request):
    return await proxy_endpoint(request, async_mode=True)


@app.post("/sync")
async def proxy_request_blocking(request: Request):
    return await proxy_endpoint(request, async_mode=False)


# --- websocket (fixtures/asyncapi.yaml) -------------------------------------

REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9-]{1,16}$")
BINARY_HEADER_BYTES = 16
UNKNOWN_REQUEST_ID = "unknown"
MAX_BINARY_PAYLOAD = 65536
SAFE_INTEGER = 9007199254740991


async def ws_send(socket, payload):
    try:
        await socket.send_text(json.dumps(payload))
    except RuntimeError:
        pass  # Socket already closed.


async def ws_error(socket, request_id, code, message):
    valid = isinstance(request_id, str) and REQUEST_ID_RE.fullmatch(request_id)
    await ws_send(
        socket,
        {
            "type": "error.response",
            "requestId": request_id if valid else UNKNOWN_REQUEST_ID,
            "code": code,
            "message": message,
        },
    )


def normalize_numbers(value):
    # JSON does not distinguish 1 from 1.0; JS runtimes parse both as the
    # integer. Mirror that here so integral floats stay in the echo domain.
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, list):
        return [normalize_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize_numbers(item) for key, item in value.items()}
    return value


# The contract's echo value domain: strings, booleans, null, safe integers,
# and arrays/objects of those. Floats are rejected because their text form
# is not stable across runtimes.
def is_echo_value(value):
    if value is None or isinstance(value, (str, bool)):
        return True
    if isinstance(value, float):
        return False
    if isinstance(value, int):
        return -SAFE_INTEGER <= value <= SAFE_INTEGER
    if isinstance(value, list):
        return all(is_echo_value(item) for item in value)
    if isinstance(value, dict):
        return all(is_echo_value(item) for item in value.values())
    return False


def has_exact_keys(payload, keys):
    return set(payload.keys()) == set(keys)


# Returns an error string, or None when the payload conforms.
def validate_ws_request(payload):
    request_id = payload.get("requestId")
    if not (isinstance(request_id, str) and REQUEST_ID_RE.fullmatch(request_id)):
        return "requestId must match ^[A-Za-z0-9-]{1,16}$"
    kind = payload.get("type")
    if kind == "echo.request":
        if not has_exact_keys(payload, ["type", "requestId", "value"]):
            return "echo.request accepts exactly type, requestId and value"
        if not is_echo_value(payload["value"]):
            return "value is outside the contract's echo value domain"
        return None
    if kind == "notification.request":
        if not has_exact_keys(payload, ["type", "requestId", "message", "delay_ms"]):
            return (
                "notification.request accepts exactly type, requestId, "
                "message and delay_ms"
            )
        if not isinstance(payload["message"], str):
            return "message must be a string"
        delay = payload["delay_ms"]
        if not (
            isinstance(delay, int)
            and not isinstance(delay, bool)
            and 0 <= delay <= 10000
        ):
            return "delay_ms must be an integer between 0 and 10000"
        return None
    if kind == "error.request":
        if not has_exact_keys(payload, ["type", "requestId", "code"]):
            return "error.request accepts exactly type, requestId and code"
        if payload["code"] != "requested_failure":
            return "code must be requested_failure"
        return None
    return None


async def send_delayed_notification(socket, request_id, message, delay_ms):
    await asyncio.sleep(delay_ms / 1000)
    await ws_send(
        socket,
        {
            "type": "notification.event",
            "requestId": request_id,
            "message": message,
        },
    )


async def handle_ws_text(socket, raw, tasks):
    try:
        payload = normalize_numbers(json.loads(raw))
    except ValueError:
        await ws_error(
            socket, UNKNOWN_REQUEST_ID, "invalid_payload", "Frame is not valid JSON"
        )
        return
    if not isinstance(payload, dict):
        await ws_error(
            socket,
            UNKNOWN_REQUEST_ID,
            "invalid_payload",
            "Frame is not a JSON object",
        )
        return

    kind = payload.get("type")
    if kind not in ("echo.request", "notification.request", "error.request"):
        await ws_error(
            socket,
            payload.get("requestId"),
            "unknown_message_type",
            f"Unsupported message type: {kind}",
        )
        return

    problem = validate_ws_request(payload)
    if problem:
        await ws_error(socket, payload.get("requestId"), "invalid_payload", problem)
        return

    if kind == "echo.request":
        await ws_send(
            socket,
            {
                "type": "echo.response",
                "requestId": payload["requestId"],
                "value": payload["value"],
            },
        )
    elif kind == "notification.request":
        task = asyncio.create_task(
            send_delayed_notification(
                socket,
                payload["requestId"],
                payload["message"],
                payload["delay_ms"],
            )
        )
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    elif kind == "error.request":
        await ws_error(
            socket,
            payload["requestId"],
            "requested_failure",
            "The client requested this error.",
        )


async def handle_ws_binary(socket, frame):
    if len(frame) < BINARY_HEADER_BYTES:
        await ws_error(
            socket,
            UNKNOWN_REQUEST_ID,
            "invalid_payload",
            f"Binary frame is shorter than the {BINARY_HEADER_BYTES}-byte header",
        )
        return
    if len(frame) - BINARY_HEADER_BYTES > MAX_BINARY_PAYLOAD:
        request_id = (
            frame[:BINARY_HEADER_BYTES].decode("ascii", "replace").rstrip(" ")
        )
        await ws_error(
            socket,
            request_id,
            "invalid_payload",
            f"Binary payload exceeds {MAX_BINARY_PAYLOAD} bytes",
        )
        return
    # Header and payload both go back byte-identical.
    try:
        await socket.send_bytes(frame)
    except RuntimeError:
        pass


@app.websocket("/ws")
async def ws_channel(socket: WebSocket):
    # uvicorn's WebSocket protocol answers pings with a matching pong and
    # completes the closing handshake on its own; both are contract
    # obligations, so they are noted rather than reimplemented.
    await socket.accept()
    tasks = set()
    try:
        while True:
            message = await socket.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                await handle_ws_binary(socket, message["bytes"])
            elif message.get("text") is not None:
                await handle_ws_text(socket, message["text"], tasks)
    finally:
        for task in tasks:
            task.cancel()


@app.get("/ws")
async def websocket_upgrade_required():
    # Reserved by fixtures/asyncapi.yaml: refused without an upgrade, and
    # never logged, so it stays out of the catch-all entirely.
    return PlainTextResponse("Upgrade Required", status_code=426)


# --- self-test --------------------------------------------------------------

# Aggregate probe endpoint (openapi.yaml selfTest): every inside-runnable
# contract check in one report, 200 only when all pass. No check opens a
# connection back to the instance — guest loopback is not routable on Edge.


class CheckFailure(Exception):
    pass


def check_expect(condition, message):
    if not condition:
        raise CheckFailure(message)


async def run_check(name, fn):
    start = time.monotonic()

    def elapsed():
        return int((time.monotonic() - start) * 1000)

    try:
        await fn()
        return {"name": name, "ok": True, "elapsed_ms": elapsed()}
    except Exception as exc:
        return {"name": name, "ok": False, "elapsed_ms": elapsed(), "error": str(exc)}


async def check_db_env():
    report = db_env_report()
    check_expect(
        len(report["present"]) + len(report["missing"]) == len(REQUIRED_DB_VARS),
        "db-env report does not partition the required vars",
    )
    check_expect(
        not report["present"] or not report["missing"],
        "partial DB_* injection: missing " + ", ".join(report["missing"]),
    )


async def check_db_connect():
    result = await asyncio.to_thread(check_db_connection)
    if not db_env_report()["missing"]:
        check_expect(result == "OK", result)
    else:
        check_expect(
            result.startswith("Missing required SQL environment variables"), result
        )


# The shared counters cannot be asserted from a probe: every instance on the
# volume increments them concurrently, and the volume gives no cross-node read
# coherence, so no invariant over their value holds however the write is
# implemented. Sharing and restart durability stay in the contract suite,
# which controls the environment.
#
# A counter nobody else can name is enough to prove the volume round-trips a
# write: the second increment can only read 2 if the first one persisted and
# came back. Removed afterwards, so probing leaves nothing behind.
def probe_counter_name():
    return "self-test-" + "".join(
        random.choice(string.ascii_lowercase) for _ in range(12)
    )


async def check_durable_counter():
    name = probe_counter_name()
    try:
        first = await counter_value(name, increment=True)
        second = await counter_value(name, increment=True)
        check_expect(
            first == 1 and second == 2,
            f"durable counter did not round-trip: expected 1 then 2, "
            f"got {first} then {second}",
        )
    finally:
        try:
            os.remove(os.path.join(DATA_DIR, name))
        except OSError:
            pass


async def check_counter_invalid_name():
    check_expect(
        not COUNTER_NAME_RE.fullmatch("NOT-VALID")
        and COUNTER_NAME_RE.fullmatch("self-test"),
        "counter name validation does not enforce ^[a-z-]+$",
    )


async def check_echo():
    payload = echo_payload("/self-test/echo/")
    check_expect(
        payload["echo"] == "self-test/echo",
        "echo did not strip surrounding slashes: " + payload["echo"],
    )
    check_expect(
        isinstance(payload["unique_hash"], str) and payload["unique_hash"] != "",
        "unique_hash is empty",
    )


@app.get("/self-test")
async def self_test():
    checks = [
        await run_check("db-env", check_db_env),
        await run_check("db-connect", check_db_connect),
        await run_check("counter-durability", check_durable_counter),
        await run_check("counter-invalid-name", check_counter_invalid_name),
        await run_check("echo", check_echo),
    ]
    ok = all(check["ok"] for check in checks)
    return JSONResponse(
        {"ok": ok, "checks": checks, "unique_hash": UNIQUE_HASH},
        status_code=200 if ok else 500,
    )


# --- catch-all --------------------------------------------------------------


def echo_payload(pathname):
    return {"echo": pathname.strip("/"), "unique_hash": UNIQUE_HASH}


@app.get("/{path:path}")
async def echo_path(path: str, request: Request):
    url = request.url.path
    if request.url.query:
        url += "?" + request.url.query
    line = f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} - {url}"
    print(line, flush=True)
    print(line, file=sys.stderr, flush=True)
    return JSONResponse(echo_payload(request.url.path))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
