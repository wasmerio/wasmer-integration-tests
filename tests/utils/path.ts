import path from "node:path";

// Anchor to the repository layout rather than process cwd, which some tests mutate.
export const projectRoot = path.resolve(__dirname, "..", "..");
