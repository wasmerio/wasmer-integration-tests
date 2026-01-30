// Test for app templates.

import { TestEnv } from "../../src/index";

import {
  deployAndValidateTemplate,
  filterTemplates,
} from "../utils/template-deploy";

// NOTE: The list of templates is dynamically generated in jest-global-setup.ts!
// eslint-disable-next-line @typescript-eslint/no-require-imports
const templates = require("../generated-templates.json");

describe("app templates deploy", () => {
  for (const tpl of filterTemplates(templates)) {
    test.concurrent("Template remote build: " + tpl.slug, async () => {
      const env = TestEnv.fromEnv();
      process.stdout.write(`Starting template test for '${tpl.slug}'\n`);
      await deployAndValidateTemplate(env, tpl, {
        formatFailureOutput: true,
      });
    });
  }
});
