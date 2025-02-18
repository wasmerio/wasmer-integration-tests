import { randomAppName } from "./src/app/index.ts";
import { TestEnv } from "./src/env.ts";

Deno.test("app-wordpress", {}, async (t) => {
  const appName = randomAppName();
  const env = TestEnv.fromEnv();
});
