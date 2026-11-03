import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";

const probe = createServer();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const directory = await mkdtemp(join(tmpdir(), "koorts-pg-test-"));
const password = randomBytes(24).toString("hex");
const postgres = new EmbeddedPostgres({
  databaseDir: join(directory, "database"), user: "postgres", password, port,
  persistent: true, createPostgresUser: false,
  postgresFlags: ["-h", "127.0.0.1"],
  onLog: () => {}, onError: message => console.error("Test PostgreSQL:", message)
});
let started = false;
try {
  await postgres.initialise();
  await postgres.start();
  started = true;
  await postgres.createDatabase("koorts_test");
  const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "tests/platform.test.js", "tests/providers.test.js"], {
    stdio: "inherit",
    env: { ...process.env, TEST_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/koorts_test` }
  });
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
  process.exitCode = result;
} finally {
  if (started) await postgres.stop();
  // Only remove the exact temporary test directory created by this invocation.
  await rm(directory, { recursive: true, force: true });
}
