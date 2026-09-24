require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");

const { transact, read } = require("./db");
const { generateQrDataUrl } = require("./qr");
const { generatePaymentQrDataUrl } = require("./payment-qr");
const { sendTicketsEmail, sendPaymentInstructionsEmail } = require("./email");
const {
  MAX_TICKETS,
  EARLY_BIRD_CAP,
  MAX_QTY_PER_ORDER,
  PENDING_ORDER_TTL_HOURS,
  EVENT,
  getCurrentTier,
  getNextTier,
  formatPrice,
} = require("./pricing");

const app = express();
app.set("trust proxy", 1); // nodig achter Render's reverse proxy, anders werkt rate-limiting per IP niet goed
app.use(helmet({ contentSecurityPolicy: false })); // CSP uit: blokkeert anders de inline scripts/CDN-libs die de pagina's gebruiken
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// Algemene rem op alle API-verkeer per IP, tegen simpele flood/DoS-pogingen.
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false });
app.use("/api", generalLimiter);

// Striktere limieten op de gevoeligste endpoints.
const orderLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: "Te veel pogingen, probeer het later opnieuw." } });
const verifyLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { valid: false, message: "Te veel scans, even wachten." } });
const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: "Te veel pogingen, probeer het later opnieuw." } });

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

// Telt alleen écht bevestigde tickets (betaald of al gescand); een niet-bevestigde
// reservering telt dus nog niet mee voor de teller, tot jij 'm in /admin bevestigt.
function countSoldTickets(data, tierId) {
  return data.tickets.filter(
    (t) => (t.status === "paid" || t.status === "used") && (!tierId || t.tierId === tierId)
  ).length;
}

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Ongeldige admin-toegangscode." });
  }
  next();
}

function requireStaff(req, res, next) {
  const token = req.headers["x-staff-token"];
  if (!process.env.STAFF_TOKEN || token !== process.env.STAFF_TOKEN) {
    return res.status(401).json({ valid: false, message: "Ongeldige staff-toegangscode." });
  }
  next();
}

app.get("/api/status", (req, res) => {
  const data = read();
  const now = new Date();
  const dateTier = getCurrentTier(now);
  const totalSold = countSoldTickets(data);
  const totalRemaining = Math.max(0, MAX_TICKETS - totalSold);

  // Helemaal uitverkocht (450/450 bevestigd): niets meer te koop, ongeacht datum.
  if (totalRemaining <= 0) {
    return res.json({ onSale: false, soldOut: true, remaining: 0, message: "Uitverkocht." });
  }

  if (!dateTier) {
    const next = getNextTier(now);
    return res.json({
      onSale: false,
      soldOut: false,
      remaining: totalRemaining,
      message: next ? "Ticketverkoop is nog niet gestart." : "Ticketverkoop is gesloten.",
      nextTierStart: next ? next.start : null,
    });
  }

  // Early Bird heeft een eigen sub-limiet van 100 tickets, los van de einddatum.
  if (dateTier.id === "earlybird") {
    const earlybirdSold = countSoldTickets(data, "earlybird");
    const earlybirdRemaining = Math.max(0, EARLY_BIRD_CAP - earlybirdSold);

    if (earlybirdRemaining <= 0) {
      const next = getNextTier(now);
      return res.json({
        onSale: false,
        soldOut: false,
        remaining: totalRemaining,
        message: "Early Bird is uitverkocht! Reguliere tickets starten binnenkort.",
        nextTierStart: next ? next.start : null,
      });
    }

    return res.json({
      onSale: true,
      soldOut: false,
      remaining: earlybirdRemaining,
      tier: { id: dateTier.id, label: dateTier.label, priceCents: dateTier.priceCents, priceFormatted: formatPrice(dateTier.priceCents) },
      event: EVENT,
      maxQtyPerOrder: MAX_QTY_PER_ORDER,
    });
  }

  res.json({
    onSale: true,
    soldOut: false,
    remaining: totalRemaining,
    tier: { id: dateTier.id, label: dateTier.label, priceCents: dateTier.priceCents, priceFormatted: formatPrice(dateTier.priceCents) },
    event: EVENT,
    maxQtyPerOrder: MAX_QTY_PER_ORDER,
  });
});

app.post("/api/orders", orderLimiter, async (req, res) => {
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
      const totalSold = countSoldTickets(data);
      if (totalSold + qty > MAX_TICKETS) {
        return { error: "Niet genoeg tickets meer beschikbaar." };
      }
      if (tier.id === "earlybird") {
        const earlybirdSold = countSoldTickets(data, "earlybird");
        if (earlybirdSold + qty > EARLY_BIRD_CAP) {
          return { error: "Early Bird tickets zijn (bijna) uitverkocht, er zijn nog maar " + Math.max(0, EARLY_BIRD_CAP - earlybirdSold) + " over." };
        }
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
    paymentInfo.paymentQrDataUrl = await generatePaymentQrDataUrl({
      iban: paymentInfo.iban,
      accountHolder: paymentInfo.accountHolder,
      amountCents,
      reference: paymentInfo.reference,
    });

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
app.get("/api/admin/orders", adminLimiter, requireAdmin, (req, res) => {
  const data = read();
  const orders = [...data.orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const earlybirdSold = countSoldTickets(data, "earlybird");
  const totalSold = countSoldTickets(data);
  const stats = {
    totalSold,
    totalRemaining: Math.max(0, MAX_TICKETS - totalSold),
    maxTickets: MAX_TICKETS,
    earlybirdSold,
    earlybirdRemaining: Math.max(0, EARLY_BIRD_CAP - earlybirdSold),
    earlybirdCap: EARLY_BIRD_CAP,
  };

  res.json({ orders, stats });
});

// Lichte check om direct te valideren of een toegangscode klopt, zonder verdere gevolgen.
app.get("/api/admin/ping", adminLimiter, requireAdmin, (req, res) => res.json({ ok: true }));
app.get("/api/staff/ping", verifyLimiter, requireStaff, (req, res) => res.json({ ok: true }));

// Admin: bevestig dat de overschrijving binnen is -> genereert tickets + mailt QR-codes.
app.post("/api/admin/orders/:id/approve", adminLimiter, requireAdmin, async (req, res) => {
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
app.post("/api/admin/orders/:id/resend-email", adminLimiter, requireAdmin, async (req, res) => {
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

// Admin: annuleer een betaalde bestelling en maak de tickets ongeldig.
app.post("/api/admin/orders/:id/cancel", adminLimiter, requireAdmin, async (req, res) => {
  const result = await transact(async (data) => {
    const order = data.orders.find((o) => o.id === req.params.id);
    if (!order) return { error: "Bestelling niet gevonden." };
    if (order.status === "cancelled" || order.status === "rejected") {
      return { error: "Bestelling is al geannuleerd." };
    }

    const tickets = data.tickets.filter((ticket) => ticket.orderId === order.id);
    if (tickets.some((ticket) => ticket.status === "used")) {
      return { error: "Deze bestelling kan niet meer worden geannuleerd: een ticket is al gescand." };
    }

    order.status = order.status === "paid" ? "cancelled" : "rejected";
    order.cancelledAt = new Date().toISOString();
    for (const ticket of tickets) ticket.status = "cancelled";
    return { ok: true };
  });

  if (result.error) return res.status(409).json({ error: result.error });
  res.json({ ok: true });
});

// Admin: verwijder een bestelling volledig (bv. test-data of vergissingen), ongeacht status.
app.delete("/api/admin/orders/:id", adminLimiter, requireAdmin, async (req, res) => {
  const result = await transact(async (data) => {
    const orderIndex = data.orders.findIndex((o) => o.id === req.params.id);
    if (orderIndex === -1) return { error: "Bestelling niet gevonden." };
    data.orders.splice(orderIndex, 1);
    data.tickets = data.tickets.filter((ticket) => ticket.orderId !== req.params.id);
    return { ok: true };
  });

  if (result.error) return res.status(404).json({ error: result.error });
  res.json({ ok: true });
});

// Admin: wijs een bestelling af (bv. geen betaling ontvangen) zodat de plekken vrijkomen.
app.post("/api/admin/orders/:id/reject", adminLimiter, requireAdmin, async (req, res) => {
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
app.post("/api/verify", verifyLimiter, requireStaff, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ valid: false, message: "Geen code ontvangen." });

  const result = await transact(async (data) => {
    const ticket = data.tickets.find((t) => t.code === code.trim());
    if (!ticket) return { valid: false, message: "Onbekend ticket." };
    if (ticket.status === "used") {
      return { valid: false, message: `Al gescand op ${new Date(ticket.usedAt).toLocaleTimeString("nl-NL")}.` };
    }
    if (ticket.status !== "paid") {
      return { valid: false, message: "Ticket is niet betaald." };
    }
    ticket.status = "used";
    ticket.usedAt = new Date().toISOString();
    const order = data.orders.find((o) => o.id === ticket.orderId);
    const tierMeta = require("./pricing").TIERS.find((t) => t.id === ticket.tierId);
    return {
      valid: true,
      message: "Toegang verleend.",
      name: order ? order.name : null,
      tier: tierMeta ? tierMeta.label : null,
    };
  });

  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ticketserver draait op http://localhost:${PORT}`);
});
