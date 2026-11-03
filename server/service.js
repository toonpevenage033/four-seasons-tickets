import { hash, token, uuid } from "./auth.js";

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new HttpError(status, code, message); };
const eventView = e => ({
  id: e.id, title: e.title, startsAt: new Date(e.starts_at).toISOString(),
  location: e.location, priceCents: e.price_cents, capacity: e.capacity,
  isTest: e.is_test, published: e.published, scanningEnabled: e.scanning_enabled
});
const escapeHtml = s => String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

export function createService(db, config, payments, mailer) {
  async function events(staff = false) {
    const { rows } = await db.query(
      staff ? "SELECT * FROM events ORDER BY starts_at" :
        "SELECT * FROM events WHERE published=true AND is_test=false AND starts_at>now() ORDER BY starts_at"
    );
    return (staff || config.LIVE_SALES_ENABLED ? rows : []).map(eventView);
  }

  async function ensurePayment(order) {
    if (order.payment_id) return order;
    if (Date.now() - new Date(order.created_at).getTime() > 23 * 60 * 60 * 1000) {
      throw new Error("Betaalsetup ouder dan 23 uur: controleer de provider handmatig voordat je opnieuw een betaling aanmaakt.");
    }
    const payment = await payments.create(order, order.access_token);
    const { rows: [saved] } = await db.query(
      `UPDATE orders SET payment_id=$2,checkout_url=$3 WHERE id=$1 AND payment_id IS NULL RETURNING *`,
      [order.id, payment.id, payment.checkoutUrl]
    );
    if (saved) return saved;
    const { rows: [existing] } = await db.query("SELECT * FROM orders WHERE id=$1", [order.id]);
    return existing;
  }

  async function issueTickets(tx, order) {
    for (let i = 0; i < order.quantity; i++) {
      await tx.query("INSERT INTO tickets(id,order_id,event_id,code) VALUES($1,$2,$3,$4)", [uuid(), order.id, order.event_id, token()]);
    }
  }

  async function reserveOrder(input, isAdmin, manualTest = false) {
    const inputHash = hash(JSON.stringify([input.eventId, input.name, input.email, input.quantity]));
    return db.transaction(async tx => {
      const { rows: [event] } = await tx.query("SELECT * FROM events WHERE id=$1 FOR UPDATE", [input.eventId]);
      if (!event) fail(404, "EVENT_NOT_FOUND", "Evenement niet gevonden.");
      if (manualTest && (!isAdmin || !event.is_test || event.published || config.PAYMENT_MODE !== "test" || config.LIVE_SALES_ENABLED)) {
        fail(403, "TEST_ONLY", "QR-testtickets zonder betaling zijn alleen toegestaan bij privé-testevenementen in testmodus.");
      }
      const { rows: [existing] } = await tx.query("SELECT * FROM orders WHERE request_id=$1", [input.requestId]);
      if (existing) {
        if (existing.input_hash !== inputHash || existing.manual_test !== manualTest) fail(409, "REQUEST_CONFLICT", "Deze aanvraagcode hoort bij een andere bestelling.");
        if (existing.is_test && !isAdmin) fail(403, "TEST_PRIVATE", "Testbestellingen zijn alleen beschikbaar via beheer.");
        return existing;
      }
      if (event.is_test && (!isAdmin || config.PAYMENT_MODE !== "test")) fail(403, "TEST_PRIVATE", "Testbestellingen zijn alleen beschikbaar via beheer in testmodus.");
      if (!event.is_test && (!config.LIVE_SALES_ENABLED || !event.published || config.PAYMENT_MODE !== "live")) {
        fail(403, "SALES_CLOSED", "De ticketverkoop is nog niet geopend.");
      }
      if (new Date(event.starts_at) <= new Date()) fail(409, "EVENT_STARTED", "De ticketverkoop voor dit evenement is gesloten.");
      const { rows: [stock] } = await tx.query(
        "SELECT coalesce(sum(quantity),0)::integer AS reserved FROM orders WHERE event_id=$1 AND status NOT IN ('failed','canceled','expired')", [event.id]
      );
      if (stock.reserved + input.quantity > event.capacity) fail(409, "SOLD_OUT", "Er zijn niet genoeg tickets beschikbaar.");
      const access = token();
      const { rows: [created] } = await tx.query(
        `INSERT INTO orders(id,event_id,buyer_name,buyer_email,quantity,amount_cents,is_test,access_hash,access_token,request_id,input_hash,manual_test)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [uuid(), event.id, input.name, input.email, input.quantity, event.price_cents * input.quantity,
          event.is_test, hash(access), access, input.requestId, inputHash, manualTest]
      );
      if (manualTest) {
        await issueTickets(tx, created);
        // "paid" is the existing redeemable state; manual_test distinguishes it from a payment.
        await tx.query("UPDATE orders SET status='paid' WHERE id=$1", [created.id]);
      }
      return created;
    });
  }

  async function manualTestTickets(input) {
    const order = await reserveOrder(input, true, true);
    return { orderUrl: `/bestelling.html#${order.access_token}`, isTest: true };
  }

  async function checkout(input, isAdmin = false) {
    if (config.PAYMENT_PROVIDER === "disabled") {
      fail(503, "PAYMENTS_DISABLED", "Betalingen zijn nog niet aangesloten. Er is geen bestelling aangemaakt.");
    }
    const order = await reserveOrder(input, isAdmin);
    try {
      const saved = await ensurePayment(order);
      return { checkoutUrl: saved.checkout_url, orderToken: saved.access_token, isTest: saved.is_test };
    } catch (error) {
      console.error("Betaling aanmaken mislukt; reservering blijft behouden:", order.id, error.message);
      fail(503, "PAYMENT_UNAVAILABLE", "De betaalprovider is tijdelijk niet bereikbaar. Probeer dezelfde bestelling opnieuw; de plaatsen blijven gereserveerd.");
    }
  }

  async function reconcile(paymentId) {
    if (config.PAYMENT_PROVIDER === "disabled") {
      fail(503, "PAYMENTS_DISABLED", "Betaalverwerking is uitgeschakeld.");
    }
    const { rows: [known] } = await db.query("SELECT * FROM orders WHERE payment_id=$1", [paymentId]);
    // Unknown notifications never create orders or tickets.
    if (!known) return;
    const payment = await payments.get(paymentId);
    if (payment.id !== known.payment_id || payment.orderId !== known.id || payment.amountCents !== known.amount_cents ||
        payment.currency !== "EUR" || payment.mode !== (known.is_test ? "test" : "live")) {
      throw new Error(`Betaalcontrole afgewezen voor bestelling ${known.id}.`);
    }
    await db.transaction(async tx => {
      await tx.query("SELECT id FROM events WHERE id=$1 FOR UPDATE", [known.event_id]);
      const { rows: [order] } = await tx.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [known.id]);
      if (payment.reversed) {
        await tx.query("UPDATE orders SET status='refunded',next_payment_check_at=now()+interval '5 minutes' WHERE id=$1", [order.id]);
        return;
      }
      // Never restore refunded/chargeback tickets or downgrade paid on an older notification.
      if (["refunded", "chargeback"].includes(order.status)) return;
      if (payment.status === "paid" && order.status !== "paid") {
        if (order.status !== "pending") throw new Error(`Onverwachte late betaling voor ${order.id}; handmatige controle nodig.`);
        await tx.query("UPDATE orders SET status='paid',paid_at=now(),next_payment_check_at=now()+interval '5 minutes' WHERE id=$1", [order.id]);
        await issueTickets(tx, order);
        await tx.query("INSERT INTO mail_jobs(order_id) VALUES($1) ON CONFLICT DO NOTHING", [order.id]);
      } else if (order.status === "pending" && ["failed", "canceled", "expired"].includes(payment.status)) {
        await tx.query("UPDATE orders SET status=$2 WHERE id=$1", [order.id, payment.status]);
      }
      await tx.query(
        "UPDATE orders SET next_payment_check_at=now()+CASE WHEN status='pending' THEN interval '30 seconds' ELSE interval '5 minutes' END WHERE id=$1",
        [order.id]
      );
    });
  }

  async function orderStatus(access) {
    const { rows: [order] } = await db.query(
      `SELECT o.*,e.title,e.starts_at,e.location,m.status AS mail_status FROM orders o
       JOIN events e ON e.id=o.event_id LEFT JOIN mail_jobs m ON m.order_id=o.id WHERE access_hash=$1`, [hash(access)]
    );
    if (!order) fail(404, "ORDER_NOT_FOUND", "Bestelling niet gevonden.");
    const { rows: tickets } = order.status === "paid" ? await db.query(
      "SELECT code,scanned_at FROM tickets WHERE order_id=$1 ORDER BY created_at,id", [order.id]
    ) : { rows: [] };
    return {
      status: order.status, event: eventView({ ...order, id: order.event_id }), quantity: order.quantity,
      amountCents: order.amount_cents, isTest: order.is_test,
      manualTest: order.manual_test,
      mailStatus: order.mail_status || "not_queued", tickets: tickets.map(t => ({ code: t.code, scannedAt: t.scanned_at }))
    };
  }

  async function scan(user, input) {
    const inputHash = hash(JSON.stringify([input.eventId, input.code]));
    return db.transaction(async tx => {
      await tx.query(
        "INSERT INTO scan_requests(user_id,request_id,input_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [user.id, input.requestId, inputHash]
      );
      const { rows: [request] } = await tx.query(
        "SELECT * FROM scan_requests WHERE user_id=$1 AND request_id=$2 FOR UPDATE", [user.id, input.requestId]
      );
      if (request.input_hash !== inputHash) fail(409, "REQUEST_CONFLICT", "Deze scanaanvraag hoort bij een andere code.");
      if (request.result) return request.result;
      const { rows: [event] } = await tx.query("SELECT * FROM events WHERE id=$1", [input.eventId]);
      if (!event || !event.scanning_enabled) fail(403, "SCANNING_CLOSED", "Scannen voor dit evenement is uitgeschakeld.");
      const { rows: [ticket] } = await tx.query(
        `SELECT t.*,o.status FROM tickets t JOIN orders o ON o.id=t.order_id
         WHERE t.code=$1 AND t.event_id=$2 FOR UPDATE OF t,o`, [input.code, input.eventId]
      );
      let result;
      if (!ticket || ticket.status !== "paid") {
        result = { status: "invalid", message: "Ongeldig ticket voor dit evenement.", scannedAt: null };
      } else if (ticket.scanned_at) {
        result = { status: "already_used", message: "Dit ticket is al gebruikt.", scannedAt: new Date(ticket.scanned_at).toISOString() };
      } else {
        const { rows: [used] } = await tx.query(
          "UPDATE tickets SET scanned_at=now(),scanned_by=$2 WHERE id=$1 RETURNING scanned_at", [ticket.id, user.id]
        );
        result = { status: "valid", message: `${event.is_test ? "TEST — " : ""}Ticket geldig. Toegang toegestaan.`, scannedAt: new Date(used.scanned_at).toISOString() };
      }
      await tx.query("UPDATE scan_requests SET result=$3 WHERE user_id=$1 AND request_id=$2", [user.id, input.requestId, JSON.stringify(result)]);
      return result;
    });
  }

  async function processMail() {
    const { rows } = await db.query("SELECT order_id FROM mail_jobs WHERE status='pending' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 10");
    for (const job of rows) {
      await db.transaction(async tx => {
        const { rows: [locked] } = await tx.query("SELECT * FROM mail_jobs WHERE order_id=$1 FOR UPDATE", [job.order_id]);
        if (locked.status !== "pending" || new Date(locked.next_attempt_at) > new Date()) return;
        const { rows: [order] } = await tx.query(
          "SELECT o.*,e.title FROM orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1", [job.order_id]
        );
        if (order.status !== "paid") return;
        const link = `${config.BASE_URL}/bestelling.html#${order.access_token}`;
        const html = `<h1>${order.is_test ? "TEST — " : ""}${escapeHtml(order.title)}</h1>
          <p>Hoi ${escapeHtml(order.buyer_name)}, je betaling is bevestigd.</p>
          <p><a href="${escapeHtml(link)}">Bekijk je ${order.quantity} ticket(s) en QR-codes</a>.</p>
          <p>Deel deze persoonlijke link niet. Vragen? koortsevents@gmail.com</p>`;
        try {
          await mailer.send(order, html);
          await tx.query(
            "UPDATE mail_jobs SET status=$2,sent_at=now(),last_error=NULL WHERE order_id=$1",
            [order.id, config.MAIL_PROVIDER === "preview" ? "preview" : "sent"]
          );
        } catch (error) {
          console.error("Ticketmail mislukt:", order.id, error.message);
          await tx.query(
            `UPDATE mail_jobs SET attempts=attempts+1,next_attempt_at=now()+interval '5 minutes',
             last_error='Mailprovider tijdelijk niet bereikbaar; controleer de serverlog.' WHERE order_id=$1`, [order.id]
          );
        }
      });
    }
  }

  async function tick() {
    const { rows } = config.PAYMENT_PROVIDER === "disabled" ? { rows: [] } : await db.query(
      `SELECT * FROM orders WHERE status IN ('pending','paid') AND manual_test=false AND next_payment_check_at<=now()
       ORDER BY next_payment_check_at LIMIT 20`
    );
    for (const order of rows) {
      try {
        const saved = await ensurePayment(order);
        await reconcile(saved.payment_id);
      } catch (error) {
        console.error("Betaalstatus synchroniseren mislukt:", order.id, error.message);
        await db.query("UPDATE orders SET next_payment_check_at=now()+interval '1 minute' WHERE id=$1", [order.id]);
      }
    }
    await processMail();
    await db.query("DELETE FROM sessions WHERE expires_at<now()");
    await db.query("DELETE FROM scan_requests WHERE created_at<now()-interval '7 days'");
  }

  return { events, checkout, manualTestTickets, reconcile, orderStatus, scan, tick, processMail };
}
