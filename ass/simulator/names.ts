// Deterministic, organic-looking app names. Drawn from the scenario's one
// PRNG stream (§4.1) so the same seed always yields the same portfolio;
// collision-proofed with an index suffix rather than a rejection loop so
// name N never depends on how many earlier draws collided.

import type { Random } from "./random";

const ADJECTIVES = [
  "amber",
  "brisk",
  "cedar",
  "coral",
  "dusty",
  "ember",
  "fluent",
  "gentle",
  "hazel",
  "ivory",
  "jade",
  "keen",
  "lunar",
  "mellow",
  "noble",
  "opal",
  "prime",
  "quiet",
  "rustic",
  "silver",
  "tidal",
  "urban",
  "vivid",
  "wistful",
] as const;

const NOUNS = [
  "anchor",
  "beacon",
  "canyon",
  "delta",
  "engine",
  "falcon",
  "garden",
  "harbor",
  "island",
  "jetty",
  "kite",
  "lantern",
  "meadow",
  "nebula",
  "orchid",
  "prairie",
  "quarry",
  "reef",
  "summit",
  "trail",
  "valley",
  "willow",
] as const;

export function appName(random: Random, index: number): string {
  return `${random.pick(ADJECTIVES)}-${random.pick(NOUNS)}-${index + 1}`;
}

export function appNames(random: Random, count: number): string[] {
  const stream = random.fork("app-names");
  return Array.from({ length: count }, (_, index) => appName(stream, index));
}
