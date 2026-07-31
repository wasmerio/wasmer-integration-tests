import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

// Prisma 7's driver-adapter engine ("client" engineType) is a wasm-bindgen
// module - every query below crosses the externref boundary edgejs is known
// to leak on (see loadtest/nextjs/README.md).
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter });
