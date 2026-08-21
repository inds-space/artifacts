import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";

if (process.env.WORKERS_CI !== "1") {
  console.log("Skipping remote D1 migrations outside Workers Builds.");
  process.exit(0);
}

if (process.env.WORKERS_CI_BRANCH !== "main") {
  console.log(`Skipping remote D1 migrations for preview branch '${process.env.WORKERS_CI_BRANCH ?? "unknown"}'.`);
  process.exit(0);
}

const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const databaseId = config.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1];

if (!databaseId || databaseId === PLACEHOLDER_DATABASE_ID) {
  console.log("Skipping remote D1 migrations because wrangler.jsonc does not contain a configured database_id.");
  process.exit(0);
}

console.log("Applying pending remote D1 migrations before deployment...");
const result = spawnSync("wrangler", ["d1", "migrations", "apply", "DB", "--remote"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
