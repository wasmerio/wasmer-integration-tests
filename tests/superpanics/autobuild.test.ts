import { TestEnv } from "../../src/index";

import {
  deployAndValidateTemplate,
  filterTemplates,
} from "../utils/template-deploy";

// NOTE: The list of templates is dynamically generated in jest-global-setup.ts!
// eslint-disable-next-line @typescript-eslint/no-require-imports
const templates = require("../generated-templates.json");

describe("autobuild template canary", () => {
  for (const tpl of filterTemplates(templates, ["fastapi-wasmer-starter"])) {
    test.concurrent(`deploy ${tpl.slug} template`, async () => {
      const env = TestEnv.fromEnv();
      await deployAndValidateTemplate(env, tpl);
    });
  }
});
