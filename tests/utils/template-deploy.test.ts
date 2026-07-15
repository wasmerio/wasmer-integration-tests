import type { AppTemplate } from "../../src/backend";

import { shardTemplates } from "./template-deploy";

function templates(...slugs: string[]): AppTemplate[] {
  return slugs.map((slug) => ({ name: slug, slug }));
}

describe("shardTemplates", () => {
  test("returns all templates when sharding is disabled", () => {
    const input = templates("b", "a");

    expect(shardTemplates(input)).toBe(input);
  });

  test("partitions templates deterministically without gaps or overlap", () => {
    const input = templates(
      "m",
      "a",
      "f",
      "c",
      "l",
      "d",
      "j",
      "b",
      "k",
      "e",
      "i",
      "g",
      "h",
    );

    const shards = Array.from({ length: 6 }, (_, index) =>
      shardTemplates(input, String(index + 1), "6"),
    );
    const assignedSlugs = shards.flat().map((template) => template.slug);

    expect(shards.map((shard) => shard.length)).toEqual([3, 2, 2, 2, 2, 2]);
    expect(new Set(assignedSlugs).size).toBe(input.length);
    expect(assignedSlugs.sort()).toEqual(
      input.map((template) => template.slug).sort(),
    );
    expect(shards[0].map((template) => template.slug)).toEqual(["a", "g", "m"]);
  });

  test.each([
    ["1", undefined, "must be set together"],
    [undefined, "6", "must be set together"],
    ["0", "6", "TEMPLATE_SHARD_INDEX must be a positive integer"],
    ["1", "nope", "TEMPLATE_SHARD_COUNT must be a positive integer"],
    ["7", "6", "must not exceed"],
  ])(
    "rejects invalid shard configuration index=%s count=%s",
    (index, count, message) => {
      expect(() => shardTemplates(templates("a"), index, count)).toThrow(
        message,
      );
    },
  );
});
