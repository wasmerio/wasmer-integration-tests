import path from "node:path";

// Jest runs with cwd at the project root; keep it simple and stable.
export const projectRoot = path.resolve(process.cwd());
