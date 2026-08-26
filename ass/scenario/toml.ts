// Shared TOML entry point for every declaration ASS reads (D-7): one parse
// wrapper with file/line error context, one extension gate, one scalar
// grammar for `--set` values.

import path from "node:path";
import { parse, TomlError } from "smol-toml";

export class TomlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlParseError";
  }
}

/** Parse TOML, mapping smol-toml's error (line/column codeblock included)
 * onto the source path the caller named. */
export function parseToml(raw: string, sourcePath: string): unknown {
  try {
    return parse(raw);
  } catch (err) {
    const detail = err instanceof TomlError ? err.message : String(err);
    throw new TomlParseError(`${sourcePath}: invalid TOML: ${detail}`);
  }
}

/** Declarations are TOML-only; any other extension is refused by name. */
export function assertTomlExtension(filePath: string, what: string): void {
  if (path.extname(filePath).toLowerCase() !== ".toml") {
    throw new TomlParseError(
      `${filePath}: ${what} must be a .toml file — declarations are ` +
        "TOML-only (YAML support was removed)",
    );
  }
}

/** One `--set`/CLI scalar: TOML value grammar first (numbers, booleans,
 * quoted strings, arrays, inline tables), bare words fall back to strings. */
export function parseTomlScalar(text: string): unknown {
  try {
    return (parse(`v = ${text}`) as Record<string, unknown>)["v"];
  } catch {
    return text;
  }
}
