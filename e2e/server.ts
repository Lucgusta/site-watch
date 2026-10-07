// Dedicated test harness. Production entrypoints never import this file.
// Authentication/CSRF/database are real; only website I/O is a controlled fixture.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Pool } from "pg";
import { createApp } from "../apps/server/src/app.js";
import { hashPassword } from "../apps/server/src/auth.js";
import { createDatabase } from "../apps/server/src/db.js";
import { MonitorWorker } from "../apps/server/src/worker.js";
import "../apps/server/src/config.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "Set TEST_DATABASE_URL or run npm run setup before browser tests.",
  );
const schema = `sitewatch_e2e_${randomUUID().replaceAll("-", "")}`;
const pool = new Pool({ connectionString: databaseUrl });
const connection = await pool.connect();
try {
  await connection.query(`CREATE SCHEMA "${schema}"`);
  await connection.query(`SET search_path TO "${schema}"`);
  await connection.query(
    await readFile(
      new URL(
        "../apps/server/prisma/migrations/20261006000000_initial/migration.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
} finally {
  connection.release();
}
const db = createDatabase(databaseUrl, schema);
const username = "e2e-admin";
const password = `e2e-${randomUUID()}`;
await mkdir(resolve(".runtime"), { recursive: true });
await writeFile(
  resolve(".runtime/e2e-login.json"),
  JSON.stringify({ username, password }),
  { mode: 0o600 },
);
const app = await createApp({
  db,
  config: {
    databaseUrl,
    origin: "http://127.0.0.1:4173",
    production: false,
    username,
    passwordHash: await hashPassword(password),
    sessionSecret: randomUUID() + randomUUID(),
  },
  staticDir: resolve("apps/web/dist"),
});
const worker = new MonitorWorker({
  db,
  databaseUrl,
  transport: async () => ({
    success: true,
    httpStatus: 200,
    responseTimeMs: 142,
    elapsedMs: 142,
    errorCategory: null,
    errorMessage: null,
  }),
});
await worker.start();
let activeTick: Promise<void> | null = null;
const timer = setInterval(() => {
  if (activeTick) return;
  activeTick = worker
    .tick()
    .catch(() => console.error("Controlled worker tick failed."))
    .finally(() => {
      activeTick = null;
    });
}, 250);
await app.listen({ host: "127.0.0.1", port: 4173 });
console.log(
  "Browser fixture ready: real login/database, controlled HTTP observations.",
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  if (activeTick) await activeTick;
  await worker.close();
  await app.close();
  await db.$disconnect();
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
}
process.once("SIGINT", () => {
  void close();
});
process.once("SIGTERM", () => {
  void close();
});
