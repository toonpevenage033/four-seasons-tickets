const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "db.json");

function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ orders: [], tickets: [] }, null, 2));
  }
}

function read() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function write(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Alle schrijfacties lopen serieel via deze queue om race conditions te voorkomen
// (bv. twee gelijktijdige bestellingen die allebei denken dat er nog plek is).
let queue = Promise.resolve();
function transact(mutator) {
  queue = queue.then(async () => {
    const data = read();
    const result = await mutator(data);
    write(data);
    return result;
  });
  return queue;
}

module.exports = { transact, read };
