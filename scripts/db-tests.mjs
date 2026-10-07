import { spawnSync } from "node:child_process";
if (!process.env.DATABASE_URL) {
  const { readFile } = await import("node:fs/promises");
  const { parseEnv } = await import("node:util");
  try {
    Object.assign(
      process.env,
      parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8")),
    );
  } catch {
    console.error(
      "Set DATABASE_URL to a dedicated test database. See docs/TESTING.md.",
    );
    process.exit(1);
  }
}
const result = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run"],
  {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "test", RUN_DB_TESTS: "true" },
  },
);
process.exit(result.status ?? 1);
