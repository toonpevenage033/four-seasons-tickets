import { token } from "./auth.js";

async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Providerverzoek mislukt (HTTP ${response.status}).`);
  return response.json();
}

export function createPayments(config, db) {
  if (config.PAYMENT_PROVIDER === "disabled") {
    const unavailable = async () => { throw new Error("Betalingen zijn uitgeschakeld; configureer eerst een betaalprovider."); };
    return { create: unavailable, get: unavailable };
  }
  if (config.PAYMENT_PROVIDER === "mock") {
    return {
      async create(order) {
        const id = `mock_${token()}`;
        const { rows: [payment] } = await db.query(
          `INSERT INTO mock_payments(id,order_id,amount_cents) VALUES($1,$2,$3)
           ON CONFLICT(order_id) DO UPDATE SET order_id=excluded.order_id RETURNING *`,
          [id, order.id, order.amount_cents]
        );
        return { id: payment.id, checkoutUrl: `${config.BASE_URL}/dev-payment.html#${payment.id}` };
      },
      async get(id) {
        const { rows: [payment] } = await db.query(
          `UPDATE mock_payments SET status=CASE WHEN status='open' AND expires_at<now() THEN 'expired' ELSE status END
           WHERE id=$1 RETURNING *`, [id]
        );
        if (!payment) throw new Error("Onbekende mockbetaling.");
        return { id, status: payment.status, amountCents: payment.amount_cents, currency: "EUR", orderId: payment.order_id, mode: "test", reversed: false };
      }
    };
  }
  const headers = { Authorization: `Bearer ${config.MOLLIE_API_KEY}`, "Content-Type": "application/json" };
  return {
    async create(order, accessToken) {
      const payment = await request("https://api.mollie.com/v2/payments", {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": order.id },
        body: JSON.stringify({
          amount: { currency: "EUR", value: (order.amount_cents / 100).toFixed(2) },
          method: "ideal",
          description: `KOORTS-EVENTS ${order.id}`,
          redirectUrl: `${config.BASE_URL}/bestelling.html#${accessToken}`,
          webhookUrl: `${config.BASE_URL}/api/payments/webhook`,
          metadata: { orderId: order.id }
        })
      });
      if (!payment.id || !payment._links?.checkout?.href) throw new Error("Ongeldig antwoord van Mollie.");
      return { id: payment.id, checkoutUrl: payment._links.checkout.href };
    },
    async get(id) {
      const payment = await request(`https://api.mollie.com/v2/payments/${encodeURIComponent(id)}`, { headers });
      return {
        id: payment.id,
        status: payment.status,
        amountCents: Math.round(Number(payment.amount?.value) * 100),
        currency: payment.amount?.currency,
        orderId: payment.metadata?.orderId,
        mode: payment.mode,
        reversed: Number(payment.amountRefunded?.value || 0) > 0 || Number(payment.amountChargedBack?.value || 0) > 0
      };
    }
  };
}

export function createMailer(config) {
  return {
    async send(order, html) {
      if (config.MAIL_PROVIDER === "preview") return;
      const response = await request("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `tickets-${order.id}`
        },
        body: JSON.stringify({
          from: config.EMAIL_FROM,
          to: [order.buyer_email],
          subject: `${order.is_test ? "[TEST] " : ""}Je tickets voor ${order.title}`,
          html,
          reply_to: "koortsevents@gmail.com"
        })
      });
      if (!response.id) throw new Error("Resend bevestigde de verzending niet.");
    }
  };
}
