import * as fs from "node:fs";
import * as pathModule from "node:path";

import { projectRoot } from "../utils/path";
import { parseYaml } from "../../src/yaml";
import { SELF_TEST_CHECKS } from "../utils/fixture-contract";
import {
  BINARY_HEADER_BYTES,
  MAX_BINARY_PAYLOAD,
  UNKNOWN_REQUEST_ID,
  randomRequestId,
} from "../utils/ws-contract";

// Guards the two fixture contract documents themselves. `fixtures` is in
// .prettierignore, so nothing else in CI so much as parses these files — a
// malformed spec would otherwise ship green and only surface as a confusing
// deploy failure much later.
//
// Beyond parsing, this pins the invariants that span the two documents and
// the assertions built on them: the /ws reservation only works if both specs
// agree on it, and tests/utils/ws-contract.ts hard-codes framing constants
// that must not drift from the AsyncAPI schema they came from.
//
// Deploys nothing and needs no environment, so it runs in milliseconds.

const FIXTURES_DIR = pathModule.join(projectRoot, "fixtures");

// Only the slices these assertions read are typed; the documents themselves
// are validated as whole documents by their own tooling, not here.
interface OpenApiSpec {
  openapi: string;
  info: { version: string };
  paths: Record<
    string,
    { get: { description: string; responses: Record<string, unknown> } }
  >;
}

interface AsyncApiSpec {
  asyncapi: string;
  info: { version: string };
  channels: {
    fixtureWebSocket: { address: string; messages: Record<string, unknown> };
  };
  operations: Record<string, { messages: { $ref: string }[] }>;
  components: {
    messages: Record<string, { summary: string }>;
    schemas: {
      requestId: { pattern: string };
      errorCode: { enum: string[] };
      errorRequestPayload: { properties: { code: { const: string } } };
      echoValue: { oneOf: { type?: string }[] };
      notificationRequestPayload: {
        properties: { delay_ms: { type: string; minimum: number } };
        required: string[];
      };
    };
  };
}

function loadSpec<T>(name: string): T {
  const raw = fs.readFileSync(pathModule.join(FIXTURES_DIR, name), "utf-8");
  return parseYaml(raw) as T;
}

const openapi = loadSpec<OpenApiSpec>("openapi.yaml");
const asyncapi = loadSpec<AsyncApiSpec>("asyncapi.yaml");

test("fixture specs are well-formed and declare the expected versions", () => {
  expect(openapi.openapi).toBe("3.1.0");
  expect(asyncapi.asyncapi).toBe("3.1.0");
  // The two documents are one contract split by protocol, so an
  // implementation can never satisfy a mismatched pair.
  expect(asyncapi.info.version).toBe(openapi.info.version);
});

test("the /ws channel address is reserved by both specs", () => {
  const channel = asyncapi.channels.fixtureWebSocket;
  expect(channel.address).toBe("/ws");

  // The HTTP spec must carve the same path out of its catch-all, otherwise
  // an implementation would legitimately echo and log WebSocket traffic.
  expect(Object.keys(openapi.paths)).toContain("/ws");
  expect(openapi.paths["/ws"].get.responses["426"]).toBeDefined();
  expect(openapi.paths["/{path}"].get.description).toContain("/ws");
});

test("the self-test operation reports both outcomes and the fixed checks", () => {
  const selfTest = openapi.paths["/self-test"];
  expect(selfTest).toBeDefined();
  // 200 all-green / 500 otherwise is what lets a plain status-code
  // validator (e.g. cloudprober's default) drive alerting.
  expect(selfTest.get.responses["200"]).toBeDefined();
  expect(selfTest.get.responses["500"]).toBeDefined();

  // The operation description is the only place the fixed check names are
  // stated; the shared assertions must not drift from it.
  for (const name of SELF_TEST_CHECKS) {
    expect(selfTest.get.description).toContain(`\`${name}\``);
  }
  // The self-test must never dial the instance itself (guest loopback is
  // not routable on Edge) nor any outside target.
  expect(selfTest.get.description).toContain("never opens a connection");
});

test("every channel message is carried by exactly one operation", () => {
  const declared = Object.keys(asyncapi.channels.fixtureWebSocket.messages);
  const used = Object.values(asyncapi.operations).flatMap((operation) =>
    operation.messages.map((message) => message.$ref.split("/").pop()),
  );
  expect(used.sort()).toEqual(declared.sort());
});

test("ws-contract constants match the AsyncAPI schema they came from", () => {
  const schemas = asyncapi.components.schemas;

  // Ids must fit the fixed-width binary header, which is what lets a binary
  // frame be correlated at all.
  expect(schemas.requestId.pattern).toBe("^[A-Za-z0-9-]{1,16}$");
  expect(BINARY_HEADER_BYTES).toBe(16);
  expect(UNKNOWN_REQUEST_ID.length).toBeLessThanOrEqual(BINARY_HEADER_BYTES);

  const idPattern = new RegExp(schemas.requestId.pattern);
  for (const prefix of ["echo", "bin", "note", "err", "mx-e", "alive"]) {
    expect(randomRequestId(prefix)).toMatch(idPattern);
  }
  expect(UNKNOWN_REQUEST_ID).toMatch(idPattern);

  // The binary summary is the only place the size ceiling is stated.
  expect(asyncapi.components.messages.binaryRequest.summary).toContain(
    String(MAX_BINARY_PAYLOAD),
  );
  expect(asyncapi.components.messages.binaryRequest.summary).toContain(
    `${BINARY_HEADER_BYTES}-byte header`,
  );
});

test("the error code enum matches what the assertions exercise", () => {
  expect(asyncapi.components.schemas.errorCode.enum).toEqual([
    "requested_failure",
    "unknown_message_type",
    "invalid_payload",
  ]);
  // Only the client-requested failure may be asked for by name.
  expect(
    asyncapi.components.schemas.errorRequestPayload.properties.code.const,
  ).toBe("requested_failure");
});

test("the echo value domain excludes floating-point numbers", () => {
  // Floats are the one JSON type whose text form differs per runtime, so
  // admitting them would make echo assertions test number formatting rather
  // than the transport.
  const types = asyncapi.components.schemas.echoValue.oneOf.map(
    (entry: { type?: string }) => entry.type,
  );
  expect(types).toContain("integer");
  expect(types).not.toContain("number");
});

test("notification requests carry a delay, so the push is unsolicited", () => {
  const properties =
    asyncapi.components.schemas.notificationRequestPayload.properties;
  expect(properties.delay_ms.type).toBe("integer");
  expect(properties.delay_ms.minimum).toBe(0);
  expect(
    asyncapi.components.schemas.notificationRequestPayload.required,
  ).toContain("delay_ms");
});
