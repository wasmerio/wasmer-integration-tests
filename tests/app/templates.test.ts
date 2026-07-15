// Test for app templates.

import { TestEnv } from "../../src/index";

import {
  deployAndValidateTemplate,
  filterTemplates,
  shardTemplates,
} from "../utils/template-deploy";

// NOTE: The list of templates is dynamically generated in jest-global-setup.ts!
// eslint-disable-next-line @typescript-eslint/no-require-imports
const templates = require("../generated-templates.json");

describe("app templates deploy", () => {
  const selectedTemplates = shardTemplates(
    filterTemplates(templates),
    process.env.TEMPLATE_SHARD_INDEX,
    process.env.TEMPLATE_SHARD_COUNT,
  );

  for (const tpl of selectedTemplates) {
    test.concurrent("Template remote build: " + tpl.slug, async () => {
      const env = TestEnv.fromEnv();
      console.info(`Starting template test for '${tpl.slug}'`);
      await deployAndValidateTemplate(env, tpl, {
        formatFailureOutput: true,
      });
    });
  }
});
