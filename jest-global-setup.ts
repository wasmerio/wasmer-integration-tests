import { TestEnv } from "./src/index";
import { writeFile } from "node:fs/promises";

export default async () => {
  // Fetch all available app templates and write to a file.
  // This file is then used in tests/app/templates.test.ts to create a test
  // for each template.
  //
  // This is needed because Jest does not support dynamic test generation.
  const env = TestEnv.fromEnv();
  const templates = await env.backend.getAllAppTemplates();
  const SKIPLIST = ["wordpress"];
  const filtered = templates.filter(
    (tpl) => !SKIPLIST.some((skip) => tpl.slug.includes(skip)),
  );
  await writeFile(
    "./tests/generated-templates.json",
    JSON.stringify(filtered, null, 2),
  );
};
