require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

const { transact, read } = require("./db");
const { generateQrDataUrl } = require("./qr");
const { sendTicketsEmail, sendPaymentInstructionsEmail } = require("./email");
const {
  MAX_TICKETS,
  MAX_QTY_PER_ORDER,
  PENDING_ORDER_TTL_HOURS,
  EVENT,
  getCurrentTier,
  getNextTier,
  formatPrice,
} = require("./pricing");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

function generateTicketCode() {
  // Niet te raden, want gebruikt bij de deur om fraude te voorkomen.
  return crypto.randomBytes(9).toString("base64url");
}

// Korte, makkelijk over te typen referentie voor bij de bankoverschrijving.
function generateReference(existingRefs) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // zonder verwarrende tekens (0/O, 1/I)
  let ref;
  do {
    ref = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  } while (existingRefs.has(ref));
  return ref;
}

// Telt tickets die al betaald zijn + orders die nog binnen hun betaaltermijn kunnen slagen.
function countActiveTickets(data) {
  const now = Date.now();
  const ttlMs = PENDING_ORDER_TTL_HOURS * 60 * 60 * 1000;
  let count = data.tickets.filter((t) => t.status === "paid").length;
  for (const order of data.orders) {
    if (order.status === "awaiting_payment" && now - new Date(order.createdAt).getTime() < ttlMs) {
      count += order.quantity;
    }
  }
  return count;
}

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Ongeldige admin-toegangscode." });
  }
  next();
}

app.get("/api/status", (req, res) => {
  const data = read();
  const now = new Date();
  const tier = getCurrentTier(now);
  const sold = countActiveTickets(data);
  const remaining = Math.max(0, MAX_TICKETS - sold);

  if (!tier) {
    const next = getNextTier(now);
    return res.json({
      onSale: false,
      soldOut: remaining <= 0,
      remaining,
      message: next ? "Ticketverkoop is nog niet gestart." : "Ticketverkoop is gesloten.",
      nextTierStart: next ? next.start : null,
    });
  }

  res.json({
    onSale: remaining > 0,
    soldOut: remaining <= 0,
    remaining,
    tier: { id: tier.id, label: tier.label, priceCents: tier.priceCents, priceFormatted: formatPrice(tier.priceCents) },
    event: EVENT,
    maxQtyPerOrder: MAX_QTY_PER_ORDER,
  });
});

app.post("/api/orders", async (req, res) => {
  try {
    const { name, email, quantity } = req.body;
    const qty = Number(quantity);

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Naam is verplicht." });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Geldig e-mailadres is verplicht." });
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ORDER) {
      return res.status(400).json({ error: `Aantal tickets moet tussen 1 en ${MAX_QTY_PER_ORDER} zijn.` });
    }

    const tier = getCurrentTier();
    if (!tier) {
      return res.status(400).json({ error: "Ticketverkoop is momenteel niet open." });
    }

    const orderId = crypto.randomUUID();
    const amountCents = tier.priceCents * qty;

    const created = await transact(async (data) => {
      const sold = countActiveTickets(data);
      if (sold + qty > MAX_TICKETS) {
        return { error: "Niet genoeg tickets meer beschikbaar." };
      }
      const reference = generateReference(new Set(data.orders.map((o) => o.reference)));
      const order = {
        id: orderId,
        reference,
        name: name.trim(),
        email: email.trim(),
        quantity: qty,
        tierId: tier.id,
        priceCents: tier.priceCents,
        amountCents,
        status: "awaiting_payment",
        createdAt: new Date().toISOString(),
      };
      data.orders.push(order);
      return { ok: true, order };
    });

    if (created.error) {
      return res.status(409).json({ error: created.error });
    }

    const paymentInfo = {
      reference: created.order.reference,
      amountFormatted: formatPrice(amountCents),
      iban: process.env.PAYMENT_IBAN,
      accountHolder: process.env.PAYMENT_ACCOUNT_HOLDER,
    };

    // De betaalinfo staat sowieso al op het scherm; een mislukte mail mag de bestelling niet blokkeren.
    try {
      await sendPaymentInstructionsEmail({
        to: created.order.email,
        name: created.order.name,
        tier,
        quantity: qty,
        ...paymentInfo,
      });
    } catch (err) {
      console.error("Fout bij versturen betaalinstructie-e-mail:", err);
    }

    res.json(paymentInfo);
  } catch (err) {
    console.error("Fout bij aanmaken order:", err);
    res.status(500).json({ error: "Er ging iets mis, probeer het later opnieuw." });
  }
});

// Admin: overzicht van bestellingen die wachten op handmatige betaalbevestiging.
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const data = read();
  const orders = [...data.orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders });
});

// Admin: bevestig dat de overschrijving binnen is -> genereert tickets + mailt QR-codes.
app.post("/api/admin/orders/:id/approve", requireAdmin, async (req, res) => {
  const result = await transact(async (data) => {
    const order = data.orders.find((o) => o.id === req.params.id);
    if (!order) return { error: "Bestelling niet gevonden." };
    if (order.status === "paid") return { error: "Bestelling is al bevestigd." };
    if (order.status === "rejected") return { error: "Bestelling was afgewezen." };

    order.status = "paid";
    order.confirmedAt = new Date().toISOString();
    const tickets = [];
    for (let i = 0; i < order.quantity; i++) {
      const ticket = {
        code: generateTicketCode(),
        orderId: order.id,
        tierId: order.tierId,
        status: "paid",
        createdAt: new Date().toISOString(),
        usedAt: null,
      };
      data.tickets.push(ticket);
      tickets.push(ticket);
    }
    return { order, tickets };
  });

  if (result.error) return res.status(409).json({ error: result.error });

  const tierMeta = require("./pricing").TIERS.find((t) => t.id === result.order.tierId);
  const ticketsWithQr = await Promise.all(
    result.tickets.map(async (t) => ({ ...t, qrDataUrl: await generateQrDataUrl(t.code) }))
  );

  // Ticket(s) zijn al aangemaakt; een mislukte mail mag dat niet ongedaan maken.
  let emailError = null;
  try {
    await sendTicketsEmail({
      to: result.order.email,
      name: result.order.name,
      tier: tierMeta,
      tickets: ticketsWithQr,
      orderId: result.order.id,
    });
  } catch (err) {
    console.error("Fout bij versturen ticket-e-mail:", err);
    emailError = "Ticket is aangemaakt, maar de e-mail kon niet worden verstuurd. Probeer het later opnieuw of stuur de tickets handmatig door.";
  }

  res.json({ ok: true, emailError });
});

// Admin: stuur de ticket-e-mail nogmaals (bv. na een eerdere mislukte poging).
app.post("/api/admin/orders/:id/resend-email", requireAdmin, async (req, res) => {
  const data = read();
  const order = data.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Bestelling niet gevonden." });
  if (order.status !== "paid") return res.status(409).json({ error: "Bestelling is nog niet bevestigd." });

  const tickets = data.tickets.filter((t) => t.orderId === order.id);
  if (tickets.length === 0) return res.status(404).json({ error: "Geen tickets gevonden voor deze bestelling." });

  const tierMeta = require("./pricing").TIERS.find((t) => t.id === order.tierId);
  try {
    const ticketsWithQr = await Promise.all(
      tickets.map(async (t) => ({ ...t, qrDataUrl: await generateQrDataUrl(t.code) }))
    );
    await sendTicketsEmail({
      to: order.email,
      name: order.name,
      tier: tierMeta,
      tickets: ticketsWithQr,
      orderId: order.id,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("Fout bij opnieuw versturen ticket-e-mail:", err);
    res.status(502).json({ error: "Versturen mislukte opnieuw: " + err.message });
  }
});

// Admin: wijs een bestelling af (bv. geen betaling ontvangen) zodat de plekken vrijkomen.
app.post("/api/admin/orders/:id/reject", requireAdmin, async (req, res) => {
  const result = await transact(async (data) => {
    const order = data.orders.find((o) => o.id === req.params.id);
    if (!order) return { error: "Bestelling niet gevonden." };
    if (order.status === "paid") return { error: "Bestelling was al bevestigd, kan niet meer afgewezen worden." };
    order.status = "rejected";
    return { ok: true };
  });

  if (result.error) return res.status(409).json({ error: result.error });
  res.json({ ok: true });
});

// Staff-only endpoint om tickets te scannen bij de ingang.
app.post("/api/verify", async (req, res) => {
  const token = req.headers["x-staff-token"];
  if (!process.env.STAFF_TOKEN || token !== process.env.STAFF_TOKEN) {
    return res.status(401).json({ valid: false, message: "Ongeldige staff-toegangscode." });
  }

  const { code } = req.body;
  if (!code) return res.status(400).json({ valid: false, message: "Geen code ontvangen." });

  const result = await transact(async (data) => {
    const ticket = data.tickets.find((t) => t.code === code.trim());
    if (!ticket) return { valid: false, message: "Onbekend ticket." };
    if (ticket.status === "used") {
      return { valid: false, message: `Al gescand op ${ticket.usedAt}.` };
    }
    if (ticket.status !== "paid") {
      return { valid: false, message: "Ticket is niet betaald." };
    }
    ticket.status = "used";
    ticket.usedAt = new Date().toISOString();
    return { valid: true, message: "Toegang verleend." };
  });

  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ticketserver draait op http://localhost:${PORT}`);
});
