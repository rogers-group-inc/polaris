import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// `prisma generate` never connects, but env() throws when DATABASE_URL is unset — which made
// `npm install` / `npm ci` (postinstall runs generate) fail in any checkout without a `.env`:
// a fresh worktree, a CI step, a contributor's first clone. Give generate alone a well-formed
// placeholder; every command that does connect (migrate, db, studio) still gets env()'s clear
// "Cannot resolve environment variable: DATABASE_URL" error.
const GENERATE_ONLY = process.argv.slice(2).includes("generate");
const GENERATE_PLACEHOLDER_URL = "postgresql://generate:generate@localhost:5432/generate";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "node --env-file=.env --import tsx/esm prisma/seed.ts",
  },
  datasource: {
    url: GENERATE_ONLY && !process.env.DATABASE_URL ? GENERATE_PLACEHOLDER_URL : env("DATABASE_URL"),
  },
});
