import { TestEnv } from "../../src/index";
import { REMOTE_BUILD_TIMEOUT, deployNodeFixture } from "../utils/node-fixture";
import {
  assertCatchAllEcho,
  randomContractSuffix,
  targetFromUrl,
} from "../utils/fixture-contract";
import {
  WsSession,
  assertWsContract,
  randomRequestId,
  targetFromAppUrl,
} from "../utils/ws-contract";

// Validates the language-agnostic WebSocket contract (fixtures/asyncapi.yaml)
// against its Node implementation (fixtures/node), deployed through the
// remote-build (autobuild) pipeline from nothing but package.json + app.yaml.
//
// The contract assertions live in tests/utils/ws-contract.ts and are
// implementation-agnostic — this file only owns deploying the Node fixture
// and the cross-spec checks that need both halves of the contract at once.
//
// Coverage differs from tests/app/edge-2012-websocket-connection-header.test.ts
// on purpose: that test pins one Edge header regression at handshake time,
// this one asserts the whole message contract after the handshake succeeds.

test.concurrent(
  "node-fixture-ws-contract",
  async () => {
    const env = TestEnv.fromEnv();

    console.log("== Deploying the Node fixture via remote build ==");
    const app = await deployNodeFixture(env, "");

    try {
      // The contract only ever sees the deployed app's URL; the Node
      // implementation behind it is invisible to the assertions.
      await assertWsContract(targetFromAppUrl(env, app.url));
    } finally {
      await env.deleteApp(app);
    }
  },
  REMOTE_BUILD_TIMEOUT,
);

test.concurrent(
  "node-fixture-ws-channel-is-carved-out-of-the-catch-all",
  async () => {
    const env = TestEnv.fromEnv();

    console.log("== Deploying the Node fixture via remote build ==");
    const app = await deployNodeFixture(env, "");

    try {
      const httpTarget = targetFromUrl(env, app.url);
      const wsTarget = targetFromAppUrl(env, app.url);

      // The reservation only means something if the catch-all is otherwise
      // live: an unrelated path must still echo.
      console.log("== The catch-all still answers for every other path ==");
      await assertCatchAllEcho(httpTarget, {
        uniquePathSegment: randomContractSuffix(),
      });

      // A path that merely starts with the reserved one is not reserved.
      console.log("== Only /ws itself is reserved ==");
      const nested = await httpTarget.fetch("/ws-not-reserved");
      expect(nested.status).toBe(200);
      expect(await nested.json()).toMatchObject({ echo: "ws-not-reserved" });

      console.log("== An upgraded /ws connection carries fixture traffic ==");
      const session = await WsSession.open(wsTarget);
      try {
        const requestId = randomRequestId("carve");
        session.send({
          type: "echo.request",
          requestId,
          value: { carved: true },
        });
        const reply = await session.nextJson(
          (m) => m.type === "echo.response" && m.requestId === requestId,
          { description: "echo.response over the reserved channel" },
        );
        expect(reply).toMatchObject({ requestId, value: { carved: true } });
      } finally {
        session.dispose();
      }
    } finally {
      await env.deleteApp(app);
    }
  },
  REMOTE_BUILD_TIMEOUT,
);
