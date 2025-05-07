import * as path from "node:path";
import * as fs from "node:fs";

import { buildStaticSiteApp, TestEnv } from "../src/index";
import assertEquals from "node:assert/strict";

async function updateStaticSiteLoop() {
  const env = TestEnv.fromEnv();
  const spec = buildStaticSiteApp();

  const info1 = await env.deployApp(spec);
  const indexPath = path.join(info1.dir, "public/index.html");

  let i = 0;
  while (true) {
    i += 1;
    const content = `hello-${i}`;
    await fs.promises.writeFile(indexPath, content);
    await env.deployAppDir(info1.dir);

    const res = await env.fetchApp(info1, "/");
    const body = await res.text();
    assertEquals(body.trim(), content);
  }
}

updateStaticSiteLoop();
