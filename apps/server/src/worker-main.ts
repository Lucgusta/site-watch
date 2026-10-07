import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createEmailSender } from "./mailer.js";
import { MonitorWorker } from "./worker.js";
const config = loadConfig();
const db = createDatabase(config.databaseUrl);
const worker = new MonitorWorker({
  db,
  databaseUrl: config.databaseUrl,
  sender: createEmailSender(config.smtp),
  log: (message) => console.log(new Date().toISOString(), message),
});
process.once("SIGINT", () => worker.requestStop());
process.once("SIGTERM", () => worker.requestStop());
try {
  await worker.run();
} finally {
  await db.$disconnect();
}
