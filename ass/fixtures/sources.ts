// App/probe fixture source grammar (QA-635, docs/anti-slop-shield-v1.md §4):
// template:<slug> | fixture:<scenario-relative dir> | package:<ident or dir> |
// backup:<ref> (recognized here, resolvable only when BE-666 lands, Phase 5).

export type AppSource =
  | { kind: "template"; slug: string }
  | { kind: "fixture"; path: string }
  | { kind: "package"; ref: string }
  | { kind: "backup"; ref: string };

export class SourceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceParseError";
  }
}

const KNOWN_KINDS_HELP =
  "known source kinds: template:<slug>, fixture:<scenario-relative dir>, " +
  "package:<registry ident or ./dir>, backup:<ref> (Phase 5, BE-666)";

export function parseAppSource(fixtureName: string, source: string): AppSource {
  const colon = source.indexOf(":");
  const kind = colon > 0 ? source.slice(0, colon) : "";
  const rest = colon > 0 ? source.slice(colon + 1) : "";
  if (rest.length === 0) {
    throw new SourceParseError(
      `fixture "${fixtureName}": source "${source}" has no value after the ` +
        `kind prefix; ${KNOWN_KINDS_HELP}`,
    );
  }
  switch (kind) {
    case "template":
      return { kind: "template", slug: rest };
    case "fixture": {
      if (rest.startsWith("/") || rest.split("/").includes("..")) {
        throw new SourceParseError(
          `fixture "${fixtureName}": fixture: paths must stay inside the ` +
            `scenario directory (relative, no ..): got "${rest}"`,
        );
      }
      return { kind: "fixture", path: rest };
    }
    case "package":
      return { kind: "package", ref: rest };
    case "backup":
      return { kind: "backup", ref: rest };
    default:
      throw new SourceParseError(
        `fixture "${fixtureName}": unknown source kind "${kind}" in ` +
          `"${source}"; ${KNOWN_KINDS_HELP}`,
      );
  }
}
