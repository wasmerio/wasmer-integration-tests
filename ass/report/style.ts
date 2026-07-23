// Terminal styling for the run summary. Color is a parameter, never an
// ambient assumption: the same formatter feeds a TTY, a piped log, and CI.

import process from "node:process";

/** The escape character, spelled out so no raw control byte lives in
 * the source. */
export const ESC = "\u001b";

export const CODES = {
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  cyan: 36,
  /** Bright blue: the table frame and keys. Plain blue (34) is unreadable on
   * dark terminals, and grey reads as muddy — this stays legible on both. */
  blue: 94,
} as const;

export type ColorName = keyof typeof CODES;

export interface Style {
  (text: string, ...codes: ColorName[]): string;
  enabled: boolean;
}

/** Honors NO_COLOR (any value) and FORCE_COLOR, else follows the stream. */
export function colorEnabled(
  stream: { isTTY?: boolean } = process.stdout,
): boolean {
  if (process.env["NO_COLOR"]) {
    return false;
  }
  const forced = process.env["FORCE_COLOR"];
  if (forced !== undefined && forced !== "" && forced !== "0") {
    return true;
  }
  return stream.isTTY === true;
}

export function makeStyle(enabled: boolean): Style {
  const style = ((text: string, ...codes: ColorName[]): string => {
    if (!enabled || codes.length === 0 || text.length === 0) {
      return text;
    }
    const prefix = codes.map((code) => `${ESC}[${CODES[code]}m`).join("");
    return `${prefix}${text}${ESC}[0m`;
  }) as Style;
  style.enabled = enabled;
  return style;
}

// Captured container logs carry their own SGR sequences; re-emitting them
// would fight our styling and smear color across the block.
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export type ColorDepth = "basic" | "256" | "truecolor";

/** Width of the key column, shared by the streaming presenter and the final
 * summary so a run renders as one continuous table. */
export const GUTTER = 10;

/** The fade runs from the frame blue to a dark neutral. Hand-picked palette
 * codes were tried first and looked wrong: xterm 75→69→63 gains saturation
 * (reads as *more* intense) and the jump from 59 (#5f5f5f) to 245 (#8a8a8a)
 * brightens by 43 luminance points mid-fade. Interpolating channels instead
 * makes luminance fall monotonically by construction. The dark endpoint
 * assumes a dark terminal, as a fade must resolve toward *some* background. */
const FADE_FROM: readonly [number, number, number] = [95, 175, 255];
const FADE_TO: readonly [number, number, number] = [58, 58, 58];

export function colorDepth(env: NodeJS.ProcessEnv = process.env): ColorDepth {
  const colorterm = env["COLORTERM"] ?? "";
  if (/truecolor|24bit/i.test(colorterm)) {
    return "truecolor";
  }
  if (colorterm || /256color/i.test(env["TERM"] ?? "")) {
    return "256";
  }
  return "basic";
}

/** Nearest xterm-256 colour: the 6×6×6 cube, or the finer grey ramp when the
 * channels are close enough to neutral for it to win. */
export function rgbTo256(red: number, green: number, blue: number): number {
  const levels = [0, 95, 135, 175, 215, 255];
  const nearest = (value: number): number =>
    levels.reduce((best, level) =>
      Math.abs(level - value) < Math.abs(best - value) ? level : best,
    );
  const [cubeR, cubeG, cubeB] = [red, green, blue].map(nearest);
  const cubeDistance =
    (cubeR - red) ** 2 + (cubeG - green) ** 2 + (cubeB - blue) ** 2;

  const average = Math.round((red + green + blue) / 3);
  const greyIndex = Math.max(0, Math.min(23, Math.round((average - 8) / 10)));
  const greyValue = 8 + greyIndex * 10;
  const greyDistance =
    (greyValue - red) ** 2 + (greyValue - green) ** 2 + (greyValue - blue) ** 2;

  if (greyDistance < cubeDistance) {
    return 232 + greyIndex;
  }
  return (
    16 +
    36 * levels.indexOf(cubeR) +
    6 * levels.indexOf(cubeG) +
    levels.indexOf(cubeB)
  );
}

/** Paint text an exact colour, degrading through the palettes. On a
 * 16-colour terminal the closest available idea of "dimmer blue" is plain
 * blue against the frame's bright blue. */
export function tint(
  text: string,
  [red, green, blue]: readonly [number, number, number],
  options: { color: boolean; depth?: ColorDepth },
): string {
  if (!options.color || text.length === 0) {
    return text;
  }
  switch (options.depth ?? "256") {
    case "truecolor":
      return `${ESC}[38;2;${red};${green};${blue}m${text}${ESC}[0m`;
    case "256":
      return `${ESC}[38;5;${rgbTo256(red, green, blue)}m${text}${ESC}[0m`;
    case "basic":
      return `${ESC}[34m${text}${ESC}[0m`;
  }
}

/** Frame and keys are both explicit RGB rather than ANSI `94`, whose actual
 * colour the terminal theme picks — that made the intended contrast between
 * the two a lottery. Cool blue for the frame, a warm neutral for the keys:
 * differing in hue as well as luminance is what makes them separable at a
 * glance, where two blues were not. */
export const FRAME_RGB: readonly [number, number, number] = [95, 175, 255];
export const KEY_RGB: readonly [number, number, number] = [176, 156, 130];

/** `key: value · key: value` with only the keys tinted. Styling happens
 * after measuring, because `truncate` works on visible text and would strip
 * the escapes back off a pre-styled string. */
export function pairs(
  entries: Array<[string, string]>,
  options: { color: boolean; depth?: ColorDepth; width: number },
): string {
  const plain = entries.map(([key, value]) => `${key}: ${value}`).join(" · ");
  if (plain.length > options.width) {
    return truncate(plain, options.width);
  }
  return entries
    .map(([key, value]) => `${tint(key, KEY_RGB, options)}: ${value}`)
    .join(" · ");
}

/** A rule that fades out: the eye gets a clear boundary at the junction and
 * nothing competing further out. Degrades to two tones on a 16-colour
 * terminal, and to plain text where colour is off. */
export function fade(
  char: string,
  length: number,
  options: { color: boolean; depth?: ColorDepth },
): string {
  if (length <= 0) {
    return "";
  }
  if (!options.color) {
    return char.repeat(length);
  }
  const depth = options.depth ?? "256";
  if (depth === "basic") {
    const head = Math.min(5, length);
    const tail = length - head;
    return (
      `${ESC}[${CODES.blue}m${char.repeat(head)}${ESC}[0m` +
      (tail > 0 ? `${ESC}[90m${char.repeat(tail)}${ESC}[0m` : "")
    );
  }
  let out = "";
  for (let index = 0; index < length; index++) {
    const ratio = length === 1 ? 1 : index / (length - 1);
    const [red, green, blue] = FADE_FROM.map((from, channel) =>
      Math.round(from + (FADE_TO[channel] - from) * ratio),
    );
    out +=
      depth === "truecolor"
        ? `${ESC}[38;2;${red};${green};${blue}m${char}`
        : `${ESC}[38;5;${rgbTo256(red, green, blue)}m${char}`;
  }
  return `${out}${ESC}[0m`;
}

/** Wrap onto as many lines as the text needs, hanging-indenting the
 * continuations so they read as one message. Truncating is right for a
 * quotation we can point at elsewhere, but wrong for an error: cutting the
 * payload off is worst precisely when the payload is why the run failed. */
export function wrap(text: string, width: number, indent = 2): string[] {
  const plain = stripAnsi(text);
  if (plain.length <= width) {
    return [plain];
  }
  if (width <= indent + 1) {
    return [truncate(plain, width)];
  }
  const leading = /^[ \t]*/.exec(plain)?.[0] ?? "";
  const continuation = leading + " ".repeat(indent);
  const words = plain.slice(leading.length).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = leading;
  let prefix = leading.length;
  for (const word of words) {
    const spaced = current.length > prefix;
    if (current.length + (spaced ? 1 : 0) + word.length > width && spaced) {
      lines.push(current);
      current = continuation + word;
      prefix = continuation.length;
    } else {
      current += (spaced ? " " : "") + word;
    }
  }
  if (current.trim().length > 0) {
    lines.push(current);
  }
  // A single token longer than the column (a path, a URL) still has to break.
  return lines.flatMap((line) => {
    if (line.length <= width) {
      return [line];
    }
    const chunks: string[] = [];
    for (let at = 0; at < line.length; at += width) {
      chunks.push(line.slice(at, at + width));
    }
    return chunks;
  });
}

/** Truncate on visible characters; assumes `text` is not yet styled. */
export function truncate(text: string, width: number): string {
  const plain = stripAnsi(text);
  if (width <= 1 || plain.length <= width) {
    return plain;
  }
  return `${plain.slice(0, width - 1)}…`;
}
