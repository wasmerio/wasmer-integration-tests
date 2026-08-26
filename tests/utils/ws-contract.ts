import WebSocket from "ws";

import { TestEnv } from "../../src/env";

// Shared, implementation-agnostic assertions for the WebSocket half of the
// fixture contract (fixtures/asyncapi.yaml). The real contract is the
// AsyncAPI document, not any single fixture: each language's test file
// deploys its own fixture app and passes the resulting URL in here — the
// assertions only ever see the URL, so the implementation behind it is
// fully abstracted away. This mirrors tests/utils/fixture-contract.ts,
// which covers the HTTP half (fixtures/openapi.yaml).
//
// Every assertion is idempotent per app: request ids are freshly random per
// call and no server-side state is touched, so the same contract can be
// re-validated against a long-lived deployment.

export const BINARY_HEADER_BYTES = 16;
export const MAX_BINARY_PAYLOAD = 65536;
export const UNKNOWN_REQUEST_ID = "unknown";

const DEFAULT_MESSAGE_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 60_000;

export type ErrorCode =
  "requested_failure" | "unknown_message_type" | "invalid_payload";

export interface EchoResponse {
  type: "echo.response";
  requestId: string;
  value: unknown;
}

export interface NotificationEvent {
  type: "notification.event";
  requestId: string;
  message: string;
}

export interface ErrorResponse {
  type: "error.response";
  requestId: string;
  code: ErrorCode;
  message: string;
}

export type ServerMessage = EchoResponse | NotificationEvent | ErrorResponse;

export interface WsContractTarget {
  env: TestEnv;
  /** Base URL of the deployed app, e.g. `https://<name>.<domain>`. */
  appUrl: string;
}

export function targetFromAppUrl(
  env: TestEnv,
  appUrl: string,
): WsContractTarget {
  return { env, appUrl: appUrl.replace(/\/+$/, "") };
}

/**
 * Request id inside the contract's `^[A-Za-z0-9-]{1,16}$` bound. The prefix
 * makes failures readable; the random tail keeps ids unique within a
 * connection so replies can never be cross-matched.
 */
export function randomRequestId(prefix: string): string {
  let tail = "";
  for (let i = 0; i < 6; i++) {
    tail += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  }
  return `${prefix}-${tail}`.slice(0, 16);
}

/** Frame a binary request: 16-byte space-padded ASCII id, then the payload. */
export function encodeBinaryFrame(requestId: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(BINARY_HEADER_BYTES, 0x20);
  header.write(requestId, 0, "ascii");
  return Buffer.concat([header, payload]);
}

export function decodeBinaryFrame(frame: Buffer): {
  requestId: string;
  payload: Buffer;
} {
  return {
    requestId: frame
      .subarray(0, BINARY_HEADER_BYTES)
      .toString("ascii")
      .trimEnd(),
    payload: frame.subarray(BINARY_HEADER_BYTES),
  };
}

/**
 * Route a WebSocket connection the way env.fetchAppUrlThroughEdge routes an
 * HTTP one: dial the configured Edge server directly and carry the app's
 * host in a header, so the contract also runs on the local platform where
 * the canonical app URL is not resolvable.
 */
function dialTarget(
  env: TestEnv,
  appUrl: string,
): { url: string; headers: Record<string, string> } {
  const direct = new URL(appUrl);
  const headers: Record<string, string> = { Host: direct.host };

  if (!env.edgeServer) {
    const target = new URL(direct.toString());
    target.protocol = direct.protocol === "https:" ? "wss:" : "ws:";
    target.pathname = "/ws";
    return { url: target.toString(), headers };
  }

  const target = new URL(env.edgeServer);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  target.pathname = "/ws";
  headers["X-Forwarded-Proto"] = direct.protocol.replace(/:$/, "");
  return { url: target.toString(), headers };
}

interface Waiter {
  match: (message: ServerMessage) => boolean;
  resolve: (message: ServerMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One WebSocket connection with a receive buffer. Frames are matched by
 * predicate rather than by arrival order, which is what the multiplexed
 * channel requires: the contract guarantees correlation by `requestId` and
 * says nothing about ordering.
 */
export class WsSession {
  private readonly socket: WebSocket;
  private readonly jsonInbox: ServerMessage[] = [];
  private readonly binaryInbox: Buffer[] = [];
  private readonly jsonWaiters: Waiter[] = [];
  private closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data, isBinary) => {
      const buffer = Buffer.from(data as Buffer);
      if (isBinary) {
        this.binaryInbox.push(buffer);
        return;
      }
      this.jsonInbox.push(
        JSON.parse(buffer.toString("utf-8")) as ServerMessage,
      );
      this.drainWaiters();
    });
    socket.on("error", () => {});
  }

  static async open(target: WsContractTarget): Promise<WsSession> {
    const { url, headers } = dialTarget(target.env, target.appUrl);
    const socket = new WebSocket(url, {
      headers,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new WsSession(socket);
  }

  private drainWaiters(): void {
    for (let w = this.jsonWaiters.length - 1; w >= 0; w--) {
      const waiter = this.jsonWaiters[w];
      const index = this.jsonInbox.findIndex(waiter.match);
      if (index === -1) {
        continue;
      }
      const [message] = this.jsonInbox.splice(index, 1);
      clearTimeout(waiter.timer);
      this.jsonWaiters.splice(w, 1);
      waiter.resolve(message);
    }
  }

  send(payload: unknown): void {
    this.socket.send(JSON.stringify(payload));
  }

  /** Send a frame verbatim, to exercise the malformed-input contract. */
  sendRaw(raw: string): void {
    this.socket.send(raw);
  }

  sendBinary(frame: Buffer): void {
    this.socket.send(frame, { binary: true });
  }

  /**
   * Await the first buffered or future JSON message matching `match`.
   * Consumes it, so two waiters never collapse onto one frame.
   */
  nextJson(
    match: (message: ServerMessage) => boolean,
    options: { timeoutMs?: number; description: string },
  ): Promise<ServerMessage> {
    const index = this.jsonInbox.findIndex(match);
    if (index !== -1) {
      return Promise.resolve(this.jsonInbox.splice(index, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.jsonWaiters.findIndex((w) => w.timer === timer);
        if (at !== -1) {
          this.jsonWaiters.splice(at, 1);
        }
        reject(
          new Error(
            `Timed out after ${options.timeoutMs ?? DEFAULT_MESSAGE_TIMEOUT_MS}ms ` +
              `waiting for ${options.description}. Buffered: ` +
              `${JSON.stringify(this.jsonInbox)}`,
          ),
        );
      }, options.timeoutMs ?? DEFAULT_MESSAGE_TIMEOUT_MS);
      this.jsonWaiters.push({ match, resolve, reject, timer });
    });
  }

  /** Await a binary reply carrying `requestId` in its header. */
  async nextBinary(
    requestId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<Buffer> {
    const deadline =
      Date.now() + (options.timeoutMs ?? DEFAULT_MESSAGE_TIMEOUT_MS);
    for (;;) {
      const index = this.binaryInbox.findIndex(
        (frame) => decodeBinaryFrame(frame).requestId === requestId,
      );
      if (index !== -1) {
        return this.binaryInbox.splice(index, 1)[0];
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for a binary reply with requestId ${requestId}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Send a ping and resolve with the pong's payload. */
  ping(
    payload: Buffer,
    timeoutMs = DEFAULT_MESSAGE_TIMEOUT_MS,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No pong within ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.socket.once("pong", (data: Buffer) => {
        clearTimeout(timer);
        resolve(Buffer.from(data));
      });
      this.socket.ping(payload);
    });
  }

  /** Close from the client side and resolve with the observed close code. */
  closeCleanly(timeoutMs = DEFAULT_MESSAGE_TIMEOUT_MS): Promise<number> {
    this.closed = true;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`Close handshake did not finish in ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.socket.once("close", (code: number) => {
        clearTimeout(timer);
        resolve(code);
      });
      this.socket.close(1000, "contract complete");
    });
  }

  dispose(): void {
    if (!this.closed) {
      this.socket.terminate();
    }
  }
}

/**
 * `GET /ws` without an upgrade is refused with 426, which is the HTTP
 * contract's half of the path reservation: it proves the channel address is
 * carved out of the catch-all rather than echoing like any other path.
 */
export async function assertUpgradeRequired(
  target: WsContractTarget,
): Promise<void> {
  const res = await target.env.fetchAppUrlThroughEdge(`${target.appUrl}/ws`, {
    acceptStatus: (status: number) => status === 426,
  });
  expect(res.status).toBe(426);
  const body = await res.text();
  expect(body).not.toContain("unique_hash");
}

/**
 * Echo returns every value in the contract's domain deep-equal and
 * correlated. The domain deliberately spans the cases that diverge between
 * runtimes — nested objects (key order), safe-range integers (width and
 * sign), empty containers — so a passing echo says something about the
 * engine rather than about JSON formatting.
 */
export async function assertEcho(session: WsSession): Promise<void> {
  const values: unknown[] = [
    { text: "Hello World", number: 42 },
    "plain string",
    true,
    null,
    0,
    -1,
    9007199254740991,
    -9007199254740991,
    [],
    {},
    { nested: { deep: [1, "two", false, null] }, other: -7 },
  ];

  for (const value of values) {
    const requestId = randomRequestId("echo");
    session.send({ type: "echo.request", requestId, value });
    const reply = (await session.nextJson(
      (m) => m.type === "echo.response" && m.requestId === requestId,
      { description: `echo.response for ${requestId}` },
    )) as EchoResponse;
    expect(reply.value).toEqual(value);
  }
}

/**
 * Binary frames round-trip byte-identically, header included, at both ends
 * of the size range the contract mandates. The payload deliberately holds
 * NUL and every high byte: a proxy or runtime that treats the frame as text
 * corrupts it here and nowhere else.
 */
export async function assertBinaryEcho(session: WsSession): Promise<void> {
  const payloads = [
    Buffer.alloc(0),
    Buffer.from([0x00, 0x01, 0x02, 0x03]),
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    Buffer.alloc(MAX_BINARY_PAYLOAD, 0xab),
  ];

  for (const payload of payloads) {
    const requestId = randomRequestId("bin");
    const frame = encodeBinaryFrame(requestId, payload);
    session.sendBinary(frame);
    const reply = await session.nextBinary(requestId, { timeoutMs: 60_000 });
    const decoded = decodeBinaryFrame(reply);
    expect(decoded.requestId).toBe(requestId);
    expect(decoded.payload.length).toBe(payload.length);
    expect(decoded.payload.equals(payload)).toBe(true);
  }
}

/**
 * A notification arrives unprompted, no earlier than the requested delay,
 * over a connection that is otherwise silent for the whole wait. That idle
 * window is the assertion that matters: it is where a proxy that closes or
 * buffers a quiet WebSocket gives itself away.
 */
export async function assertUnsolicitedNotification(
  session: WsSession,
): Promise<void> {
  const requestId = randomRequestId("note");
  const delayMs = 5_000;
  const message = `pushed-${requestId}`;

  const sentAt = Date.now();
  session.send({
    type: "notification.request",
    requestId,
    message,
    delay_ms: delayMs,
  });
  const event = (await session.nextJson(
    (m) => m.type === "notification.event" && m.requestId === requestId,
    { timeoutMs: delayMs + 30_000, description: "notification.event" },
  )) as NotificationEvent;

  expect(event.message).toBe(message);
  // A lower bound only: the contract promises the event is not early, never
  // that it is punctual.
  expect(Date.now() - sentAt).toBeGreaterThanOrEqual(delayMs);
}

/**
 * All three error codes come back on a connection that stays usable. The
 * trailing echo after each error is the real assertion — a recoverable
 * error must not cost the client its connection.
 */
export async function assertRecoverableErrors(
  session: WsSession,
): Promise<void> {
  const requested = randomRequestId("err");
  session.send({
    type: "error.request",
    requestId: requested,
    code: "requested_failure",
  });
  const requestedReply = (await session.nextJson(
    (m) => m.type === "error.response" && m.requestId === requested,
    { description: "error.response for a requested failure" },
  )) as ErrorResponse;
  expect(requestedReply.code).toBe("requested_failure");
  expect(requestedReply.message.length).toBeGreaterThan(0);
  await assertConnectionUsable(session);

  const unknownType = randomRequestId("bogus");
  session.send({ type: "fixture.bogus", requestId: unknownType });
  const unknownReply = (await session.nextJson(
    (m) => m.type === "error.response" && m.requestId === unknownType,
    { description: "error.response for an unknown message type" },
  )) as ErrorResponse;
  expect(unknownReply.code).toBe("unknown_message_type");
  await assertConnectionUsable(session);

  // Unparseable frame: no id is readable, so the reserved id comes back.
  session.sendRaw("{ this is not json");
  const malformed = (await session.nextJson(
    (m) => m.type === "error.response" && m.requestId === UNKNOWN_REQUEST_ID,
    { description: "error.response for an unparseable frame" },
  )) as ErrorResponse;
  expect(malformed.code).toBe("invalid_payload");
  await assertConnectionUsable(session);

  // Parseable JSON that violates the schema: a float is outside the echo
  // value domain, and the id is readable, so it must be echoed back.
  const badValue = randomRequestId("float");
  session.send({ type: "echo.request", requestId: badValue, value: 1.5 });
  const rejected = (await session.nextJson(
    (m) => m.type === "error.response" && m.requestId === badValue,
    { description: "error.response for an out-of-domain echo value" },
  )) as ErrorResponse;
  expect(rejected.code).toBe("invalid_payload");
  await assertConnectionUsable(session);
}

/** Round-trip one echo to prove the connection still carries traffic. */
async function assertConnectionUsable(session: WsSession): Promise<void> {
  const requestId = randomRequestId("alive");
  session.send({ type: "echo.request", requestId, value: "alive" });
  const reply = (await session.nextJson(
    (m) => m.type === "echo.response" && m.requestId === requestId,
    { description: "echo.response proving the connection survived" },
  )) as EchoResponse;
  expect(reply.value).toBe("alive");
}

/**
 * The whole point of the single-channel design: four message types in
 * flight at once on one connection, replies correlated by id alone. The
 * notification is requested first but delayed longest, so a correct client
 * must receive it last — an implementation that answers strictly in
 * receive order cannot pass this.
 */
export async function assertMultiplexing(session: WsSession): Promise<void> {
  const echoId = randomRequestId("mx-e");
  const binaryId = randomRequestId("mx-b");
  const notifyId = randomRequestId("mx-n");
  const errorId = randomRequestId("mx-x");
  const binaryPayload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

  session.send({
    type: "notification.request",
    requestId: notifyId,
    message: "last to arrive",
    delay_ms: 3_000,
  });
  session.send({ type: "echo.request", requestId: echoId, value: ["mux", 1] });
  session.sendBinary(encodeBinaryFrame(binaryId, binaryPayload));
  session.send({
    type: "error.request",
    requestId: errorId,
    code: "requested_failure",
  });

  const [echo, error, binary, notification] = await Promise.all([
    session.nextJson((m) => m.requestId === echoId, {
      description: "multiplexed echo.response",
    }),
    session.nextJson((m) => m.requestId === errorId, {
      description: "multiplexed error.response",
    }),
    session.nextBinary(binaryId),
    session.nextJson((m) => m.requestId === notifyId, {
      timeoutMs: 40_000,
      description: "multiplexed notification.event",
    }),
  ]);

  expect(echo.type).toBe("echo.response");
  expect((echo as EchoResponse).value).toEqual(["mux", 1]);
  expect(error.type).toBe("error.response");
  expect((error as ErrorResponse).code).toBe("requested_failure");
  expect(decodeBinaryFrame(binary).payload.equals(binaryPayload)).toBe(true);
  expect(notification.type).toBe("notification.event");
  expect((notification as NotificationEvent).message).toBe("last to arrive");
}

/**
 * RFC 6455 keepalive survives the trip through Edge: a ping is answered by
 * a pong carrying the identical payload. Proxies that terminate the
 * WebSocket themselves, or drop control frames, fail here.
 */
export async function assertPingPong(session: WsSession): Promise<void> {
  const payload = Buffer.from(`ping-${randomRequestId("p")}`);
  const pong = await session.ping(payload);
  expect(pong.equals(payload)).toBe(true);
}

/**
 * A client-initiated close is completed by the server and observed as 1000.
 * 1006 means the TCP connection was cut instead of the closing handshake
 * being forwarded — the classic signature of a proxy that does not
 * understand WebSocket close frames. Uses its own connection, since it ends
 * the one it is given.
 */
export async function assertCleanClose(
  target: WsContractTarget,
): Promise<void> {
  const session = await WsSession.open(target);
  try {
    await assertConnectionUsable(session);
    expect(await session.closeCleanly()).toBe(1000);
  } finally {
    session.dispose();
  }
}

/**
 * Validate the full WebSocket contract against a target, walking every
 * capability in fixtures/asyncapi.yaml. Everything except the close
 * handshake runs on a single long-lived connection, so a per-message
 * regression and a connection-lifetime regression stay distinguishable.
 */
export async function assertWsContract(
  target: WsContractTarget,
): Promise<void> {
  console.log("== ws contract: path reservation ==");
  await assertUpgradeRequired(target);

  const session = await WsSession.open(target);
  try {
    console.log("== ws contract: json echo ==");
    await assertEcho(session);

    console.log("== ws contract: binary echo ==");
    await assertBinaryEcho(session);

    console.log("== ws contract: unsolicited notification ==");
    await assertUnsolicitedNotification(session);

    console.log("== ws contract: recoverable errors ==");
    await assertRecoverableErrors(session);

    console.log("== ws contract: multiplexing ==");
    await assertMultiplexing(session);

    console.log("== ws contract: ping/pong ==");
    await assertPingPong(session);
  } finally {
    session.dispose();
  }

  console.log("== ws contract: clean close ==");
  await assertCleanClose(target);
}
