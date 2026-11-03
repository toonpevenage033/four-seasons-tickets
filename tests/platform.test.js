import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../server/config.js";
import { openDatabase, migrate } from "../server/db.js";
import { createApp } from "../server/app.js";
import { createMailer, createPayments } from "../server/providers.js";
import { passwordHash, resetPassword, uuid } from "../server/auth.js";

const config = loadConfig({
  NODE_ENV: "test", DB_DRIVER: process.env.TEST_DATABASE_URL ? "pg" : "pglite",
  DATABASE_URL: process.env.TEST_DATABASE_URL, PGLITE_PATH: ":memory:",
  PAYMENT_PROVIDER: "mock", PAYMENT_MODE: "test", MAIL_PROVIDER: "preview"
});
let db, service, server, origin, adminCookie, staffToken, eventId, staffId, payments;
const password = "test-only-password-123";
async function request(path, { method = "GET", body, cookie, bearer, ...options } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method, ...options,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...options.headers
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const content = response.headers.get("content-type") || "";
  const data = content.includes("application/json") ? await response.json() : await response.text();
  return { status: response.status, data, headers: response.headers };
}
const purchase = (quantity = 1, requestId = uuid()) => ({
  eventId, requestId, name: "Test Bezoeker", email: "test@example.invalid", quantity
});
async function paidOrder(quantity = 1) {
  const result = await service.checkout(purchase(quantity), true);
  const { rows: [order] } = await db.query("SELECT * FROM orders WHERE access_hash IS NOT NULL AND access_token=$1", [result.orderToken]);
  await db.query("UPDATE mock_payments SET status='paid' WHERE id=$1", [order.payment_id]);
  await service.reconcile(order.payment_id);
  return { ...order, access: result.orderToken };
}

before(async () => {
  db = await openDatabase(config);
  await migrate(db);
  await migrate(db);
  payments = createPayments(config, db);
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.close();
});
beforeEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  const built = createApp({ db, config, payments, mailer: createMailer(config) });
  service = built.service;
  server = built.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  await db.query("TRUNCATE users,events,orders,sessions,tickets,scan_requests,mail_jobs,mock_payments CASCADE");
  const adminId = uuid();
  staffId = uuid();
  const hashed = await passwordHash(password);
  await db.query("INSERT INTO users(id,username,password_hash,role) VALUES($1,'admin',$2,'admin'),($3,'staff',$2,'staff')", [adminId, hashed, staffId]);
  eventId = uuid();
  await db.query(
    "INSERT INTO events(id,title,starts_at,location,price_cents,capacity,is_test) VALUES($1,'Privé TEST',now()+interval '30 days','Testlocatie',1500,5,true)", [eventId]
  );
  const admin = await request("/api/admin/login", { method: "POST", body: { username: "admin", password } });
  assert.equal(admin.status, 200);
  adminCookie = admin.headers.get("set-cookie").split(";")[0];
  const staff = await request("/api/staff/login", { method: "POST", body: { username: "staff", password } });
  assert.equal(staff.status, 200);
  staffToken = staff.data.token;
});

test("configuration refuses unsafe production, live and mock combinations", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production", DB_DRIVER: "pglite" }), /HTTPS|PostgreSQL/);
  assert.throws(() => loadConfig({ DB_DRIVER: "pglite", PAYMENT_PROVIDER: "mock", BASE_URL: "https://example.com" }), /uitsluitend/);
  assert.throws(() => loadConfig({ DB_DRIVER: "pglite", PAYMENT_PROVIDER: "mollie", MOLLIE_API_KEY: "live_not-real" }), /PAYMENT_MODE/);
  assert.throws(() => loadConfig({ DB_DRIVER: "pglite", PAYMENT_PROVIDER: "mock", LIVE_SALES_ENABLED: "true" }), /Live verkoop/);
});

test("password reset revokes sessions and preserves account role and activation", async () => {
  await resetPassword(db, "admin", "new-test-password-12345");
  assert.equal((await request("/api/admin/session", { cookie: adminCookie })).status, 401);
  assert.equal((await request("/api/staff/login", { method: "POST", body: { username: "admin", password } })).status, 401);
  const result = await request("/api/staff/login", {
    method: "POST", body: { username: "admin", password: "new-test-password-12345" }
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.user.role, "admin");
  await assert.rejects(resetPassword(db, "missing", "new-test-password-12345"), /Account niet gevonden/);
  await db.query("UPDATE users SET active=false WHERE username='staff'");
  await resetPassword(db, "staff", "new-test-password-12345");
  assert.equal((await db.query("SELECT active FROM users WHERE username='staff'")).rows[0].active, false);
});

test("hosted disabled payments permits login and scanning without creating reservations", async () => {
  const disabledConfig = loadConfig({
    NODE_ENV: "production", DB_DRIVER: "pg", DATABASE_URL: "postgresql://unused",
    BASE_URL: "https://four-seasons-tickets.onrender.com", PAYMENT_PROVIDER: "disabled"
  });
  const { createService } = await import("../server/service.js");
  const disabled = createService(db, disabledConfig, createPayments(disabledConfig), createMailer(disabledConfig));
  await assert.rejects(disabled.checkout(purchase(), true), { code: "PAYMENTS_DISABLED" });
  await assert.rejects(disabled.reconcile("tr_example"), { code: "PAYMENTS_DISABLED" });
  await disabled.tick();
  assert.equal((await db.query("SELECT * FROM orders")).rows.length, 0);
  assert.equal((await disabled.events(true)).length, 1);
  const scan = await disabled.scan({ id: staffId }, { eventId, code: "invalid", requestId: uuid() });
  assert.equal(scan.status, "invalid");
  assert.throws(() => loadConfig({
    NODE_ENV: "production", DB_DRIVER: "pg", DATABASE_URL: "postgresql://unused",
    BASE_URL: "https://example.com", PAYMENT_PROVIDER: "disabled", LIVE_SALES_ENABLED: "true"
  }), /Live verkoop/);
});

  test("private manual test tickets need no provider, issue exactly N and scan once", async () => {
    const { createService } = await import("../server/service.js");
    const forbiddenProvider = { create: () => { throw new Error("Provider must not be used"); }, get: () => { throw new Error("Provider must not be used"); } };
    const manual = createService(db, { ...config, PAYMENT_PROVIDER: "disabled" }, forbiddenProvider, {
      send: () => { throw new Error("No mail for manual test tickets"); }
    });
    const input = purchase(2);
    const [first, retry] = await Promise.all([manual.manualTestTickets(input), manual.manualTestTickets(input)]);
    assert.equal(first.orderUrl, retry.orderUrl);
    const access = first.orderUrl.split("#")[1];
    const order = await manual.orderStatus(access);
    assert.equal(order.manualTest, true);
    assert.equal(order.isTest, true);
    assert.equal(order.tickets.length, 2);
    assert.equal(order.mailStatus, "not_queued");
    const { rows: [stored] } = await db.query("SELECT * FROM orders");
    assert.equal(stored.payment_id, null);
    assert.equal(stored.paid_at, null);
    assert.equal((await db.query("SELECT * FROM mail_jobs")).rows.length, 0);
    await manual.tick();
    // Switching provider later must not create a payment or mail for this order.
    await createService(db, config, forbiddenProvider, { send: forbiddenProvider.create }).tick();
    const scanInput = { eventId, code: order.tickets[0].code, requestId: uuid() };
    assert.equal((await manual.scan({ id: staffId }, scanInput)).status, "valid");
    assert.equal((await manual.scan({ id: staffId }, { ...scanInput, requestId: uuid() })).status, "already_used");
    await assert.rejects(manual.manualTestTickets({ ...input, quantity: 1 }), { code: "REQUEST_CONFLICT" });
    await assert.rejects(service.checkout(input, true), { code: "REQUEST_CONFLICT" });
  });

  test("manual test route is admin-only, rejects live events and enforces stock", async () => {
    const input = { eventId, quantity: 2, requestId: uuid() };
    const path = "/api/admin/test-tickets";
    assert.equal((await request(path, { method: "POST", body: input })).status, 401);
    assert.equal((await request(path, { method: "POST", bearer: staffToken, body: input })).status, 401);
    assert.equal((await request(path, { method: "POST", cookie: adminCookie, body: { ...input, quantity: 0 } })).status, 400);
    const created = await request(path, { method: "POST", cookie: adminCookie, body: input });
    assert.equal(created.status, 201);
    const access = created.data.orderUrl.split("#")[1];
    const result = await request("/api/order", { headers: { "X-Order-Token": access } });
    assert.equal(result.data.manualTest, true);
    assert.equal(result.data.tickets.length, 2);
    assert.match(result.data.tickets[0].qrDataUrl, /^data:image\/png;base64,/);
    const orderId = (await db.query("SELECT id FROM orders")).rows[0].id;
    assert.equal((await request(`/api/admin/orders/${orderId}/retry-mail`, { method: "POST", cookie: adminCookie })).status, 409);
    const results = await Promise.all([
      request(path, { method: "POST", cookie: adminCookie, body: { ...input, quantity: 3, requestId: uuid() } }),
      request(path, { method: "POST", cookie: adminCookie, body: { ...input, quantity: 3, requestId: uuid() } })
    ]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.equal((await db.query("SELECT * FROM tickets")).rows.length, 5);
    assert.deepEqual((await request("/api/events")).data.events, []);
    await db.query("UPDATE events SET is_test=false WHERE id=$1", [eventId]);
    assert.equal((await request(path, { method: "POST", cookie: adminCookie, body: { ...input, requestId: uuid() } })).status, 403);
  });

  test("manual test tickets are refused in live mode without creating orders", async () => {
    const { createService } = await import("../server/service.js");
    const live = createService(db, { ...config, PAYMENT_MODE: "live", LIVE_SALES_ENABLED: true }, payments, createMailer(config));
    await assert.rejects(live.manualTestTickets(purchase()), { code: "TEST_ONLY" });
    assert.equal((await db.query("SELECT * FROM orders")).rows.length, 0);
  });
test("manual ticket migration preserves existing paid orders and is repeatable", async () => {
  const order = await paidOrder(2);
  await db.query("ALTER TABLE orders DROP COLUMN manual_test");
  await db.query("DELETE FROM schema_migrations WHERE version=2");
  await migrate(db);
  await migrate(db);
  const existing = await service.orderStatus(order.access);
  assert.equal(existing.manualTest, false);
  assert.equal(existing.status, "paid");
  assert.equal(existing.tickets.length, 2);
});

test("test event is private across listing, checkout, publication and static files", async () => {
  assert.deepEqual((await request("/api/events")).data.events, []);
  assert.equal((await request("/api/orders", { method: "POST", body: purchase() })).status, 403);
  assert.equal((await request(`/api/admin/events/${eventId}`, { method: "PATCH", cookie: adminCookie, body: { published: true } })).status, 403);
  assert.equal((await request("/api/admin/events")).status, 401);
  assert.equal((await request("/server/schema.sql")).status, 404);
  assert.equal((await request("/.env")).status, 404);
  const staff = await request("/api/staff/events", { bearer: staffToken });
  assert.equal(staff.data.events[0].isTest, true);
});

test("stock reservations are bounded and order retries are idempotent", async () => {
  const results = await Promise.allSettled([service.checkout(purchase(3), true), service.checkout(purchase(3), true)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.code, "SOLD_OUT");
  const input = purchase(2);
  const first = await service.checkout(input, true);
  const retry = await service.checkout(input, true);
  assert.equal(first.orderToken, retry.orderToken);
  assert.equal(first.checkoutUrl, retry.checkoutUrl);
  await assert.rejects(service.checkout({ ...input, quantity: 1 }, true), { code: "REQUEST_CONFLICT" });
  const { rows: [stock] } = await db.query("SELECT sum(quantity)::integer AS n FROM orders");
  assert.equal(stock.n, 5);
});

test("a failed payment releases stock; open payments never time out locally", async () => {
  const input = purchase(5);
  await service.checkout(input, true);
  await db.query("UPDATE orders SET created_at=now()-interval '2 hours'");
  await assert.rejects(service.checkout(purchase(), true), { code: "SOLD_OUT" });
  const { rows: [order] } = await db.query("SELECT * FROM orders");
  await db.query("UPDATE mock_payments SET status='failed' WHERE id=$1", [order.payment_id]);
  await service.reconcile(order.payment_id);
  await service.checkout(purchase(5), true);
});

test("verified paid webhooks issue exactly N tickets and one mail job", async () => {
  const order = await paidOrder(3);
  await Promise.all([service.reconcile(order.payment_id), service.reconcile(order.payment_id)]);
  assert.equal((await db.query("SELECT * FROM tickets")).rows.length, 3);
  assert.equal((await db.query("SELECT * FROM mail_jobs")).rows.length, 1);
  await service.processMail();
  const result = await request("/api/order", { headers: { "X-Order-Token": order.access } });
  assert.equal(result.data.status, "paid");
  assert.equal(result.data.mailStatus, "preview");
  assert.equal(result.data.tickets.length, 3);
  assert.equal(result.data.isTest, true);
  assert.equal(Object.hasOwn(result.data, "buyer_email"), false);
  assert.match(result.data.tickets[0].qrDataUrl, /^data:image\/png;base64,/);
  await db.query("UPDATE mock_payments SET status='open' WHERE id=$1", [order.payment_id]);
  await service.reconcile(order.payment_id);
  assert.equal((await service.orderStatus(order.access)).status, "paid");
});

test("provider amount/currency/order/mode checks reject forged confirmation", async () => {
  await service.checkout(purchase(), true);
  const { rows: [order] } = await db.query("SELECT * FROM orders");
  await db.query("UPDATE mock_payments SET status='paid',amount_cents=1 WHERE id=$1", [order.payment_id]);
  await assert.rejects(service.reconcile(order.payment_id), /Betaalcontrole/);
  assert.equal((await db.query("SELECT * FROM tickets")).rows.length, 0);
  assert.equal((await request("/api/payments/webhook", { method: "POST", body: { id: "mock_unknown" } })).status, 200);
});

test("simultaneous scans admit once; same request retry returns original result", async () => {
  const order = await paidOrder();
  const code = (await service.orderStatus(order.access)).tickets[0].code;
  const input = { eventId, code, requestId: uuid() };
  const call = body => request("/api/staff/scan", { method: "POST", bearer: staffToken, body });
  const [a, b] = await Promise.all([call(input), call({ ...input, requestId: uuid() })]);
  assert.deepEqual([a.data.status, b.data.status].sort(), ["already_used", "valid"]);
  const retry = await call(input);
  assert.deepEqual(retry.data, a.data);
  const conflict = await call({ ...input, code: "a-different-code" });
  assert.equal(conflict.status, 409);
  const invalid = await call({ ...input, code: "not-a-ticket", requestId: uuid() });
  assert.equal(invalid.data.status, "invalid");
});

test("wrong event, disabled scanning and refunded orders do not admit", async () => {
  const order = await paidOrder();
  const code = (await service.orderStatus(order.access)).tickets[0].code;
  const otherEvent = uuid();
  await db.query(
    "INSERT INTO events(id,title,starts_at,location,price_cents,capacity,is_test) VALUES($1,'Ander feest',now()+interval '30 days','Testlocatie',1500,5,true)", [otherEvent]
  );
  const wrongEvent = await service.scan({ id: staffId }, { eventId: otherEvent, code, requestId: uuid() });
  assert.equal(wrongEvent.status, "invalid");
  assert.equal((await db.query("SELECT scanned_at FROM tickets")).rows[0].scanned_at, null);
  await db.query("UPDATE orders SET status='refunded' WHERE id=$1", [order.id]);
  const input = { eventId, code, requestId: uuid() };
  const result = await service.scan({ id: staffId }, input);
  assert.equal(result.status, "invalid");
  await db.query("UPDATE events SET scanning_enabled=false WHERE id=$1", [eventId]);
  await assert.rejects(service.scan({ id: staffId }, { ...input, requestId: uuid() }), { code: "SCANNING_CLOSED" });
  assert.equal((await db.query("SELECT scanned_at FROM tickets")).rows[0].scanned_at, null);
});

test("failed mail remains retryable without changing payment or tickets", async () => {
  const order = await paidOrder();
  const { createService } = await import("../server/service.js");
  const failing = createService(db, { ...config, MAIL_PROVIDER: "resend" }, payments, { send: async () => { throw new Error("test-provider-unavailable"); } });
  await failing.processMail();
  const job = (await db.query("SELECT * FROM mail_jobs")).rows[0];
  assert.equal(job.status, "pending");
  assert.equal(job.attempts, 1);
  assert.equal((await service.orderStatus(order.access)).status, "paid");
  assert.equal((await request(`/api/admin/orders/${order.id}/retry-mail`, { method: "POST", cookie: adminCookie })).status, 204);
  await service.processMail();
  assert.equal((await db.query("SELECT status FROM mail_jobs")).rows[0].status, "preview");
});

test("staff management revokes sessions, logout revokes, CSRF is blocked", async () => {
  const denied = await request("/api/admin/events", {
    method: "POST", cookie: adminCookie, headers: { Origin: "https://attacker.invalid" }, body: {}
  });
  assert.equal(denied.status, 403);
  const changed = await request(`/api/admin/users/${staffId}`, { method: "PATCH", cookie: adminCookie, body: { active: false } });
  assert.equal(changed.status, 204);
  assert.equal((await request("/api/staff/events", { bearer: staffToken })).status, 401);
  await request("/api/admin/logout", { method: "POST", cookie: adminCookie });
  assert.equal((await request("/api/admin/session", { cookie: adminCookie })).status, 401);
});

test("input validation and staff/admin session separation", async () => {
  assert.equal((await request("/api/admin/test-orders", { method: "POST", cookie: adminCookie, body: { ...purchase(), quantity: 0 } })).status, 400);
  assert.equal((await request("/api/staff/events", { cookie: adminCookie })).status, 401);
  assert.equal((await request("/api/admin/session", { bearer: staffToken })).status, 401);
  assert.equal((await request("/api/order", { headers: { "X-Order-Token": "not-a-token" } })).status, 400);
  assert.equal((await request("/api/admin/login", { method: "POST", body: { username: "staff", password } })).status, 401);
});

test("thirty concurrent scan requests for the same ticket admit once", async () => {
  const order = await paidOrder();
  const code = (await service.orderStatus(order.access)).tickets[0].code;
  const results = await Promise.all(Array.from({ length: 30 }, async () => {
    const started = performance.now();
    const response = await request("/api/staff/scan", {
      method: "POST", bearer: staffToken, body: { eventId, code, requestId: uuid() }
    });
    assert.equal(response.status, 200);
    return { status: response.data.status, ms: performance.now() - started };
  }));
  assert.equal(results.filter(r => r.status === "valid").length, 1);
  assert.equal(results.filter(r => r.status === "already_used").length, 29);
  const sorted = results.map(r => r.ms).sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  assert.ok(p95 < 1000, `Lokale scan p95 ${p95.toFixed(0)}ms overschrijdt 1000ms.`);
  console.log(`Lokale scancontrole: 30 gelijktijdige verzoeken, p95 ${p95.toFixed(0)}ms (geen camerameting).`);
});

test("live public checkout uses server pricing and hides test/draft events", async () => {
  const liveConfig = loadConfig({
    NODE_ENV: "test", DB_DRIVER: "pglite", PGLITE_PATH: ":memory:", BASE_URL: "https://tickets.example.com",
    PAYMENT_MODE: "live", PAYMENT_PROVIDER: "mollie", MOLLIE_API_KEY: "live_fake",
    LIVE_SALES_ENABLED: "true", MAIL_PROVIDER: "resend", RESEND_API_KEY: "fake", EMAIL_FROM: "tickets@example.com"
  });
  let created;
  const livePayments = {
    async create(order) {
      created = order;
      return { id: "tr_live_example", checkoutUrl: "https://checkout.mollie.com/example" };
    },
    async get() {
      return { id: "tr_live_example", orderId: created.id, amountCents: created.amount_cents, currency: "EUR", mode: "live", status: "paid", reversed: false };
    }
  };
  await new Promise(resolve => server.close(resolve));
  const built = createApp({ db, config: liveConfig, payments: livePayments, mailer: { send: async () => {} } });
  server = built.app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const liveId = uuid();
  await db.query(
    "INSERT INTO events(id,title,starts_at,location,price_cents,capacity,is_test,published) VALUES($1,'Live voorbeeld',now()+interval '30 days','Locatie',1950,5,false,true)", [liveId]
  );
  const list = await request("/api/events");
  assert.equal(list.data.events.length, 1);
  assert.equal(list.data.events[0].id, liveId);
  const invalid = await request("/api/orders", { method: "POST", body: { ...purchase(), eventId: liveId, amountCents: 1 } });
  assert.equal(invalid.status, 400);
  const checkout = await request("/api/orders", { method: "POST", body: { ...purchase(2), eventId: liveId } });
  assert.equal(checkout.status, 201);
  assert.equal(created.amount_cents, 3900);
  await built.service.reconcile("tr_live_example");
  assert.equal((await built.service.orderStatus(checkout.data.orderToken)).tickets.length, 2);
  assert.equal((await request("/dev-payment.html")).status, 404);
});
