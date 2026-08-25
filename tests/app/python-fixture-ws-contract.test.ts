import { TestEnv } from "../../src/index";
import {
  PYTHON_REMOTE_BUILD_TIMEOUT,
  deployPythonFixture,
} from "../utils/python-fixture";
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
// against its Python implementation (fixtures/python/toolbox), deployed
// through the remote-build (Anybuild) pipeline from the FastAPI sources.
//
// The contract assertions live in tests/utils/ws-contract.ts and are
// implementation-agnostic — this file only owns deploying the Python
// fixture and the cross-spec checks that need both halves of the contract
// at once. Mirrors tests/app/node-fixture-ws-contract.test.ts.

test.concurrent(
  "python-fixture-ws-contract",
  async () => {
    const env = TestEnv.fromEnv();

    console.log("== Deploying the Python fixture via remote build ==");
    const app = await deployPythonFixture(env, "");

    try {
      // The contract only ever sees the deployed app's URL; the Python
      // implementation behind it is invisible to the assertions.
      await assertWsContract(targetFromAppUrl(env, app.url));
    } finally {
      await env.deleteApp(app);
    }
  },
  PYTHON_REMOTE_BUILD_TIMEOUT,
);

test.concurrent(
  "python-fixture-ws-channel-is-carved-out-of-the-catch-all",
  async () => {
    const env = TestEnv.fromEnv();

    console.log("== Deploying the Python fixture via remote build ==");
    const app = await deployPythonFixture(env, "");

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
  PYTHON_REMOTE_BUILD_TIMEOUT,
);
