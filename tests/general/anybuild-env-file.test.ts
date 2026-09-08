import { createZip } from "stackmachine";

import { randomAppName, TestEnv } from "../../src";

jest.setTimeout(600_000);

interface AppEnvironmentResponse {
  node: {
    envVars: {
      edges: Array<{
        node: { name: string; value: string | null; runtime: boolean };
      }>;
    };
  };
}

test("autobuild imports dotenv variables and warns without overwriting app variables", async () => {
  const env = TestEnv.fromEnv();
  const client = await env.stackmachineSdk();
  const uploadUrl = await client.uploadFile(
    await createZip({
      "index.html": "<html>environment import</html>",
      ".env": "ENV_IMPORT_NEW=from-file\nENV_IMPORT_EXISTING=from-file\n",
    }),
  );
  const messages: string[] = [];
  const build = await client.deployApp({
    appName: randomAppName(),
    owner: env.namespace,
    uploadUrl,
    waitForScreenshotGeneration: false,
    secrets: [{ name: "ENV_IMPORT_EXISTING", value: "keep-original" }],
  });
  build.subscribeToProgress((event) => {
    if (
      typeof event === "object" &&
      event !== null &&
      "message" in event &&
      typeof event.message === "string"
    ) {
      messages.push(event.message);
    }
  });
  const version = await build.finish();
  const app = version.app as { id: string };
  try {
    const response = await env.backend.gqlQuery<AppEnvironmentResponse>(
      `query ImportedEnvironment($id: ID!) {
        node(id: $id) {
          ... on DeployApp {
            envVars { edges { node { name value runtime } } }
          }
        }
      }`,
      { id: app.id },
    );
    const variables = response.data?.node.envVars.edges.map(({ node }) => node);
    expect(variables).toEqual(
      expect.arrayContaining([
        { name: "ENV_IMPORT_NEW", value: "from-file", runtime: true },
        { name: "ENV_IMPORT_EXISTING", value: "keep-original", runtime: true },
      ]),
    );
    const collisionWarnings = messages.filter(
      (message) =>
        /warning/i.test(message) && message.includes("ENV_IMPORT_EXISTING"),
    );
    expect(collisionWarnings.length).toBeGreaterThan(0);
    for (const message of collisionWarnings) {
      expect(message).not.toContain("from-file");
      expect(message).not.toContain("keep-original");
    }
  } finally {
    await client.deleteApp({ id: app.id });
  }
});
