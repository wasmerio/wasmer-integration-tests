// `ass present` puts a chained program's output behind the ass table. Its
// contract is what a dev loop depends on: quiet when nothing happened, the
// full frame the moment something does, and never a half-open table.

import { Readable } from "node:stream";
import { runPresent } from "../../ass/report/stream";

function sink(): {
  lines: string[];
  io: { out(l: string): void; err(l: string): void };
} {
  const lines: string[] = [];
  return {
    lines,
    io: { out: (line) => lines.push(line), err: () => undefined },
  };
}

function input(text: string): Readable & { isTTY?: boolean } {
  return Readable.from([text]) as Readable & { isTTY?: boolean };
}

/** The table's prose, with frame and wrapping taken out. */
function prose(lines: string[]): string {
  return lines
    .map((line) => line.replace(/^\s*\S*\s*│\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

describe("ass present", () => {
  it("collapses to one line when the program says nothing notable", async () => {
    const { lines, io } = sink();
    await runPresent({
      id: "local-dev",
      title: "platform",
      step: "platform=booting",
      collapse: "local-dev · platform ready",
      color: false,
      io,
      input: input("[site] [vite] connected.\n[docs] ✓ Ready in 1958ms\n"),
    });
    expect(lines).toEqual(["local-dev · platform ready"]);
  });

  it("opens the frame as soon as a line survives the filter", async () => {
    const { lines, io } = sink();
    await runPresent({
      id: "local-dev",
      title: "platform",
      step: "platform=booting",
      collapse: "local-dev · platform ready",
      color: false,
      io,
      input: input("quiet\nERROR the port is already allocated\n"),
    });
    // The banner and step were buffered, not lost: they flush with the line
    // that earned them.
    expect(lines[1]).toContain("ass  local-dev  platform");
    expect(prose(lines)).toContain("the port is already allocated");
    expect(lines.at(-1)).toContain("┴");
    expect(lines).not.toContain("local-dev · platform ready");
  });

  it("shows every line under verbose", async () => {
    const { lines, io } = sink();
    await runPresent({
      title: "servers",
      step: "servers",
      verbose: true,
      color: false,
      io,
      input: input("[site] [vite] connected.\n"),
    });
    expect(prose(lines)).toContain("[site] [vite] connected.");
  });

  it("promotes highlighted lines even when quiet", async () => {
    const { lines, io } = sink();
    await runPresent({
      title: "servers",
      step: "servers",
      highlight: "ready in",
      color: false,
      io,
      input: input("[site] [vite] connected.\n[docs] ✓ Ready in 1958ms\n"),
    });
    const text = prose(lines);
    expect(text).toContain("Ready in 1958ms");
    expect(text).not.toContain("[vite] connected");
  });

  it("renders blocks as rows and closes the frame", async () => {
    const { lines, io } = sink();
    await runPresent({
      id: "local-dev",
      title: "dev servers",
      blocks: ["sign in=http://localhost:8082/signin\naccount: u / p"],
      step: "servers",
      color: false,
      io,
      input: input(""),
    });
    const text = prose(lines);
    expect(text).toContain("http://localhost:8082/signin");
    expect(text).toContain("account: u / p");
    expect(lines.at(-1)).toContain("┴");
  });

  it("renders and exits when nothing is piped", async () => {
    const { lines, io } = sink();
    const tty = Readable.from([]) as Readable & { isTTY?: boolean };
    tty.isTTY = true;
    await runPresent({
      id: "local-dev",
      title: "seeded environment",
      blocks: ["sign in=http://localhost:8082/signin"],
      color: false,
      io,
      input: tty,
    });
    expect(prose(lines)).toContain("http://localhost:8082/signin");
    expect(lines.at(-1)).toContain("┴");
  });
});
