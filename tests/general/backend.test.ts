// Tests for the BackendClient class.

import { TestEnv } from "../../src";

test("getAllAppTemplates returns an array of templates", async () => {
  const env = TestEnv.fromEnv();
  const backend = env.backend;
  const templates = await backend.getAllAppTemplates();

  expect(Array.isArray(templates)).toBe(true);
  // An empty template list would make the per-template checks below vacuous.
  expect(templates.length).toBeGreaterThan(0);

  // Validate structure of each template
  for (const template of templates) {
    expect(template).toHaveProperty("name");
    expect(template).toHaveProperty("slug");
    expect(typeof template.name).toBe("string");
    expect(typeof template.slug).toBe("string");
  }
});
