import { test } from "node:test";
import assert from "node:assert/strict";
import { createPayments, createMailer } from "../server/providers.js";

test("disabled provider refuses creation and status without network calls", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network call"); });
  const provider = createPayments({ PAYMENT_PROVIDER: "disabled" });
  await assert.rejects(provider.create({}), /uitgeschakeld/);
  await assert.rejects(provider.get("tr_example"), /uitgeschakeld/);
});

test("Mollie integration uses server-side amount, stable idempotency and webhook", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({ id: "tr_example", _links: { checkout: { href: "https://checkout.mollie.com/test" } } });
  });
  const provider = createPayments({ PAYMENT_PROVIDER: "mollie", MOLLIE_API_KEY: "test_fake", BASE_URL: "https://tickets.example.com" });
  const order = { id: "unique-order", amount_cents: 2950 };
  await provider.create(order, "private-order-token");
  await provider.create(order, "private-order-token");
  assert.equal(calls[0].url, "https://api.mollie.com/v2/payments");
  assert.equal(calls[0].options.headers["Idempotency-Key"], calls[1].options.headers["Idempotency-Key"]);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.amount, { currency: "EUR", value: "29.50" });
  assert.equal(body.method, "ideal");
  assert.equal(body.webhookUrl, "https://tickets.example.com/api/payments/webhook");
  assert.equal(body.redirectUrl, "https://tickets.example.com/bestelling.html#private-order-token");
  assert.deepEqual(body.metadata, { orderId: order.id });
});

test("Mollie status maps currency, mode and reversals; HTTP errors are not success", async t => {
  const stub = t.mock.method(globalThis, "fetch", async () => Response.json({
    id: "tr_example", mode: "test", status: "paid", amount: { currency: "EUR", value: "29.50" },
    metadata: { orderId: "example" }, amountRefunded: { currency: "EUR", value: "1.00" }
  }));
  const provider = createPayments({ PAYMENT_PROVIDER: "mollie", MOLLIE_API_KEY: "test_fake" });
  const result = await provider.get("tr_example");
  assert.equal(result.amountCents, 2950);
  assert.equal(result.reversed, true);
  assert.equal(result.mode, "test");
  assert.equal(result.currency, "EUR");
  stub.mock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(provider.get("tr_example"), /HTTP 503/);
});

test("Resend sends a stable idempotency key and preview never calls the network", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json({ id: "mail_example" });
  });
  const order = { id: "example", title: "Test", buyer_email: "test@example.invalid", is_test: true };
  await createMailer({ MAIL_PROVIDER: "preview" }).send(order, "<p>Example</p>");
  assert.equal(calls.length, 0);
  await createMailer({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "fake", EMAIL_FROM: "Tickets <tickets@example.com>" }).send(order, "<p>Ticketlink</p>");
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].options.headers["Idempotency-Key"], "tickets-example");
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.to, ["test@example.invalid"]);
  assert.match(body.subject, /^\[TEST\]/);
  assert.equal(body.reply_to, "koortsevents@gmail.com");
});
