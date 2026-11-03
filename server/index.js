import { loadConfig } from "./config.js";
import { openDatabase, migrate } from "./db.js";
import { createPayments, createMailer } from "./providers.js";
import { createApp } from "./app.js";

const config = loadConfig();
const db = await openDatabase(config);
await migrate(db);
const { app, service } = createApp({ db, config, payments: createPayments(config, db), mailer: createMailer(config) });
const server = app.listen(config.PORT, process.env.HOST || (config.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"), () => {
  console.log(`KOORTS-EVENTS: ${config.BASE_URL} | ${config.PAYMENT_MODE} | ${config.PAYMENT_PROVIDER} | mail: ${config.MAIL_PROVIDER}`);
});
let running = false;
let currentTick = Promise.resolve();
const tick = () => {
  if (running) return;
  running = true;
  currentTick = service.tick().catch(error => console.error("Achtergrondtaak mislukt:", error.message)).finally(() => { running = false; });
};
const interval = setInterval(tick, 15000);
tick();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  await new Promise(resolve => server.close(resolve));
  await currentTick;
  await db.close();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
