import { readFile } from "node:fs/promises";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";

export async function openDatabase(config) {
  if (config.DB_DRIVER === "pglite") {
    const client = new PGlite(config.PGLITE_PATH === ":memory:" ? undefined : config.PGLITE_PATH);
    await client.waitReady;
    // PGlite has one connection: serialize whole transactions, not individual statements.
    let tail = Promise.resolve();
    function exclusive(fn) {
      const task = tail.then(fn);
      tail = task.catch(() => {});
      return task;
    }
    return {
      query: (sql, values) => exclusive(() => client.query(sql, values)),
      transaction: fn => exclusive(() => client.transaction(tx => fn(tx))),
      close: () => exclusive(() => client.close())
    };
  }
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: true } : false,
    max: 10,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000
  });
  pool.on("error", err => console.error("PostgreSQL poolfout:", err.message));
  return {
    query: (sql, values) => pool.query(sql, values),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end()
  };
}

export async function migrate(db) {
  const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await db.transaction(async tx => {
    if (!tx.exec) await tx.query("SELECT pg_advisory_xact_lock(687421001)");
    await tx.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)");
    const { rows } = await tx.query("SELECT version FROM schema_migrations WHERE version=1");
    if (!rows.length) {
      // pg accepts multiple statements without parameters; PGlite uses exec.
      if (tx.exec) await tx.exec(sql);
      else await tx.query(sql);
      await tx.query("INSERT INTO schema_migrations(version) VALUES(1)");
    }
    const { rows: manualTickets } = await tx.query("SELECT version FROM schema_migrations WHERE version=2");
    if (!manualTickets.length) {
      await tx.query(
        `ALTER TABLE orders ADD COLUMN manual_test boolean NOT NULL DEFAULT false
         CHECK (NOT manual_test OR (is_test AND payment_id IS NULL AND paid_at IS NULL))`
      );
      await tx.query("INSERT INTO schema_migrations(version) VALUES(2)");
    }
  });
}
