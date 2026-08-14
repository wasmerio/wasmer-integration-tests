// Minimal YAML-subset reader, replacing js-yaml (D-7: the YAML dialect left
// this repo's own declarations; what remains is *external* YAML — GitHub
// workflow files, wasmopticon app.yaml files, backend-generated configs).
// Supported: block maps/sequences, flow collections (JSON included), quoted
// and plain scalars, `|`/`>` block scalars with chomping, comments. Not
// supported (throws): anchors/aliases, tags, directives, multi-document
// streams, multi-line plain scalars. Writers use JSON.stringify — JSON is
// valid YAML.

export class YamlError extends Error {
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = "YamlError";
  }
}

interface Row {
  indent: number;
  text: string; // content without indent, comments kept (stripped later)
  num: number; // 1-based source line
}

const BOOLS: Record<string, boolean> = { true: true, false: false };

function inferScalar(text: string): unknown {
  if (text === "" || text === "~" || text === "null") {
    return null;
  }
  if (text in BOOLS) {
    return BOOLS[text];
  }
  if (/^[+-]?\d+$/.test(text)) {
    return Number(text);
  }
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
    return Number(text);
  }
  return text;
}

/** Index of the first ` #` comment marker outside quotes; -1 if none. */
function commentStart(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === "\\" && quote === '"') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || text[i - 1] === " ")) {
      return i;
    }
  }
  return -1;
}

function stripComment(text: string): string {
  const at = commentStart(text);
  return (at === -1 ? text : text.slice(0, at)).trimEnd();
}

function parseQuoted(
  text: string,
  num: number,
): { value: string; rest: string } {
  const quote = text[0];
  if (quote === '"') {
    for (let i = 1; i < text.length; i++) {
      if (text[i] === "\\") {
        i++;
      } else if (text[i] === '"') {
        try {
          return {
            value: JSON.parse(text.slice(0, i + 1)) as string,
            rest: text.slice(i + 1),
          };
        } catch {
          throw new YamlError(`bad double-quoted scalar: ${text}`, num);
        }
      }
    }
  } else {
    // Single quotes: '' escapes a quote, nothing else is special.
    for (let i = 1; i < text.length; i++) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") {
          i++;
          continue;
        }
        return {
          value: text.slice(1, i).replaceAll("''", "'"),
          rest: text.slice(i + 1),
        };
      }
    }
  }
  throw new YamlError(`unterminated quoted scalar: ${text}`, num);
}

class Parser {
  private rows: Row[] = [];
  private raw: string[];
  private pos = 0;

  constructor(text: string) {
    this.raw = text.split("\n");
    this.raw.forEach((line, index) => {
      const noTab = line.replace(/\t/g, "  ");
      const trimmed = noTab.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        return;
      }
      this.rows.push({
        indent: noTab.length - noTab.trimStart().length,
        text: trimmed,
        num: index + 1,
      });
    });
    // Tolerate a leading directive and/or document marker.
    while (this.rows.length > 0 && /^(%\S|---$)/.test(this.rows[0].text)) {
      this.rows.shift();
    }
  }

  parse(): unknown {
    if (this.rows.length === 0) {
      return null;
    }
    const value = this.parseBlock(this.rows[0].indent);
    if (this.pos < this.rows.length) {
      throw new YamlError(
        `unexpected content: ${this.rows[this.pos].text}`,
        this.rows[this.pos].num,
      );
    }
    return value;
  }

  private peek(): Row | null {
    return this.pos < this.rows.length ? this.rows[this.pos] : null;
  }

  private parseBlock(indent: number): unknown {
    const row = this.peek();
    if (row === null) {
      return null;
    }
    if (row.text === "-" || row.text.startsWith("- ")) {
      return this.parseSequence(row.indent);
    }
    if (this.keySplit(row) !== null) {
      return this.parseMap(row.indent);
    }
    // A lone scalar document/value.
    this.pos++;
    return this.parseFlowOrScalar(row.text, row.num, indent);
  }

  private parseSequence(indent: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      const row = this.peek();
      if (
        row === null ||
        row.indent !== indent ||
        !(row.text === "-" || row.text.startsWith("- "))
      ) {
        if (row !== null && row.indent > indent) {
          throw new YamlError(`bad indentation: ${row.text}`, row.num);
        }
        return out;
      }
      if (row.text === "-") {
        this.pos++;
        const next = this.peek();
        out.push(
          next !== null && next.indent > indent
            ? this.parseBlock(next.indent)
            : null,
        );
        continue;
      }
      // Re-home the item content as a deeper virtual row and recurse.
      const offset = row.text.length - row.text.slice(1).trimStart().length;
      this.rows[this.pos] = {
        indent: row.indent + offset,
        text: row.text.slice(offset),
        num: row.num,
      };
      out.push(this.parseBlock(row.indent + offset));
    }
  }

  /** Split "key: value" | "key:" — returns null when the row is no mapping
   * entry. Quoted keys supported; plain keys end at the first `: ` or `:`EOL. */
  private keySplit(row: Row): { key: string; rest: string } | null {
    const text = row.text;
    if (text.startsWith('"') || text.startsWith("'")) {
      const { value, rest } = parseQuoted(text, row.num);
      const after = rest.trimStart();
      if (!after.startsWith(":")) {
        return null;
      }
      return { key: value, rest: after.slice(1).trim() };
    }
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== ":") {
        continue;
      }
      if (i + 1 === text.length || text[i + 1] === " ") {
        const key = text.slice(0, i).trim();
        if (key === "" || key.includes("#")) {
          return null;
        }
        return { key, rest: text.slice(i + 1).trim() };
      }
    }
    return null;
  }

  private parseMap(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (;;) {
      const row = this.peek();
      if (row === null || row.indent !== indent) {
        if (row !== null && row.indent > indent) {
          throw new YamlError(`bad indentation: ${row.text}`, row.num);
        }
        return out;
      }
      const split = this.keySplit(row);
      if (split === null) {
        throw new YamlError(`expected "key: value", got: ${row.text}`, row.num);
      }
      this.pos++;
      const rest = stripComment(split.rest);
      if (rest === "") {
        const next = this.peek();
        if (next !== null && next.indent > indent) {
          out[split.key] = this.parseBlock(next.indent);
        } else if (
          // A sequence may sit at the key's own indent.
          next !== null &&
          next.indent === indent &&
          (next.text === "-" || next.text.startsWith("- "))
        ) {
          out[split.key] = this.parseSequence(indent);
        } else {
          out[split.key] = null;
        }
      } else if (rest.startsWith("|") || rest.startsWith(">")) {
        out[split.key] = this.parseBlockScalar(rest, row.num, indent);
      } else {
        out[split.key] = this.parseFlowOrScalar(split.rest, row.num, indent);
      }
    }
  }

  private parseBlockScalar(
    header: string,
    num: number,
    indent: number,
  ): string {
    const match = /^([|>])([+-]?)\s*$/.exec(stripComment(header));
    if (match === null) {
      throw new YamlError(`unsupported block scalar header: ${header}`, num);
    }
    const folded = match[1] === ">";
    const chomp = match[2];
    // Raw source lines (blank lines matter here) after the header line.
    const body: string[] = [];
    let blockIndent: number | null = null;
    let line = num; // num is 1-based; raw[num] is the next line
    for (; line < this.raw.length; line++) {
      const text = this.raw[line].replace(/\t/g, "  ");
      const lineIndent = text.length - text.trimStart().length;
      if (text.trim() === "") {
        body.push("");
        continue;
      }
      if (blockIndent === null) {
        if (lineIndent <= indent) {
          break;
        }
        blockIndent = lineIndent;
      }
      if (lineIndent < blockIndent && text.trim() !== "") {
        if (lineIndent <= indent) {
          break;
        }
        throw new YamlError(`bad block scalar indentation`, line + 1);
      }
      body.push(text.slice(blockIndent));
    }
    // Sync the row cursor past the consumed lines.
    while (this.pos < this.rows.length && this.rows[this.pos].num <= line) {
      this.pos++;
    }
    while (body.length > 0 && body[body.length - 1] === "") {
      body.pop();
    }
    let text: string;
    if (folded) {
      text = body
        .join("\n")
        .replace(/([^\n])\n(?=[^\n])/g, "$1 ")
        .replace(/\n\n/g, "\n");
    } else {
      text = body.join("\n");
    }
    if (chomp === "-") {
      return text;
    }
    if (chomp === "+") {
      return text + "\n";
    }
    return text === "" ? "" : text + "\n";
  }

  private parseFlowOrScalar(
    rest: string,
    num: number,
    indent: number,
  ): unknown {
    const text = rest.trim();
    if (text.startsWith("*") || text.startsWith("&") || text.startsWith("!")) {
      throw new YamlError(
        `anchors/aliases/tags are not supported: ${text}`,
        num,
      );
    }
    if (text.startsWith("[") || text.startsWith("{")) {
      return this.parseFlow(text, num, indent);
    }
    if (text.startsWith('"') || text.startsWith("'")) {
      const { value, rest: tail } = parseQuoted(text, num);
      if (stripComment(tail).trim() !== "") {
        throw new YamlError(`trailing content after quoted scalar`, num);
      }
      return value;
    }
    // Multi-line plain scalars fold onto one line.
    let joined = stripComment(text);
    for (;;) {
      const next = this.peek();
      if (
        next === null ||
        next.indent <= indent ||
        next.text.startsWith("- ") ||
        next.text === "-" ||
        this.keySplit(next) !== null
      ) {
        break;
      }
      joined += " " + stripComment(next.text);
      this.pos++;
    }
    return inferScalar(joined);
  }

  /** Flow collection, gathering continuation lines until brackets balance
   * (JSON documents written by this repo parse through here). */
  private parseFlow(first: string, num: number, indent: number): unknown {
    let text = stripComment(first);
    let line = num;
    while (!flowBalanced(text)) {
      if (line >= this.raw.length) {
        throw new YamlError(`unterminated flow collection`, num);
      }
      const next = stripComment(this.raw[line].replace(/\t/g, "  ").trim());
      line++;
      if (next !== "") {
        text += " " + next;
      }
    }
    while (this.pos < this.rows.length && this.rows[this.pos].num <= line) {
      if (this.rows[this.pos].num === num && line === num) {
        break; // single-line flow: rows cursor already advanced by caller
      }
      this.pos++;
    }
    const cursor = { text, at: 0, num };
    const value = readFlowValue(cursor);
    skipSpaces(cursor);
    if (cursor.at !== cursor.text.length) {
      throw new YamlError(`trailing content after flow collection`, num);
    }
    void indent;
    return value;
  }
}

interface FlowCursor {
  text: string;
  at: number;
  num: number;
}

function flowBalanced(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === "\\" && quote === '"') {
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[" || ch === "{") {
      depth++;
    } else if (ch === "]" || ch === "}") {
      depth--;
    }
  }
  return depth <= 0 && quote === null;
}

function skipSpaces(cursor: FlowCursor): void {
  while (cursor.at < cursor.text.length && cursor.text[cursor.at] === " ") {
    cursor.at++;
  }
}

function readFlowValue(cursor: FlowCursor): unknown {
  skipSpaces(cursor);
  const ch = cursor.text[cursor.at];
  if (ch === "[") {
    cursor.at++;
    const out: unknown[] = [];
    skipSpaces(cursor);
    if (cursor.text[cursor.at] === "]") {
      cursor.at++;
      return out;
    }
    for (;;) {
      out.push(readFlowValue(cursor));
      skipSpaces(cursor);
      const sep = cursor.text[cursor.at];
      cursor.at++;
      if (sep === "]") {
        return out;
      }
      if (sep !== ",") {
        throw new YamlError(`expected "," or "]" in flow sequence`, cursor.num);
      }
      skipSpaces(cursor);
      if (cursor.text[cursor.at] === "]") {
        cursor.at++;
        return out;
      }
    }
  }
  if (ch === "{") {
    cursor.at++;
    const out: Record<string, unknown> = {};
    skipSpaces(cursor);
    if (cursor.text[cursor.at] === "}") {
      cursor.at++;
      return out;
    }
    for (;;) {
      skipSpaces(cursor);
      let key: string;
      if (cursor.text[cursor.at] === '"' || cursor.text[cursor.at] === "'") {
        const { value, rest } = parseQuoted(
          cursor.text.slice(cursor.at),
          cursor.num,
        );
        key = value;
        cursor.at = cursor.text.length - rest.length;
      } else {
        const colon = cursor.text.indexOf(":", cursor.at);
        if (colon === -1) {
          throw new YamlError(
            `expected "key: value" in flow mapping`,
            cursor.num,
          );
        }
        key = cursor.text.slice(cursor.at, colon).trim();
        cursor.at = colon;
      }
      skipSpaces(cursor);
      if (cursor.text[cursor.at] !== ":") {
        throw new YamlError(`expected ":" in flow mapping`, cursor.num);
      }
      cursor.at++;
      out[key] = readFlowValue(cursor);
      skipSpaces(cursor);
      const sep = cursor.text[cursor.at];
      cursor.at++;
      if (sep === "}") {
        return out;
      }
      if (sep !== ",") {
        throw new YamlError(`expected "," or "}" in flow mapping`, cursor.num);
      }
      skipSpaces(cursor);
      if (cursor.text[cursor.at] === "}") {
        cursor.at++;
        return out;
      }
    }
  }
  // Plain or quoted scalar until , ] }
  if (ch === '"' || ch === "'") {
    const { value, rest } = parseQuoted(
      cursor.text.slice(cursor.at),
      cursor.num,
    );
    cursor.at = cursor.text.length - rest.length;
    return value;
  }
  let end = cursor.at;
  while (end < cursor.text.length && !",]}".includes(cursor.text[end])) {
    end++;
  }
  const raw = cursor.text.slice(cursor.at, end).trim();
  cursor.at = end;
  return inferScalar(raw);
}

/** Parse a YAML document within the supported subset. */
export function parseYaml(text: string): unknown {
  return new Parser(text).parse();
}
