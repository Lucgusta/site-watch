import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
const config = loadConfig();
const db = createDatabase(config.databaseUrl);
const app = await createApp({ db, config, logger: true });
await app.listen({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
});
const shutdown = async () => {
  await app.close();
  await db.$disconnect();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
