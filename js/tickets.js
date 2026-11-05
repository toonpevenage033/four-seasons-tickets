// === TICKABLE TICKETSHOP ===
// Plak hier de Tickable-shoplink zodra de verkoop live mag, bijvoorbeeld:
//   const TICKET_SHOP_URL = "https://shop.tickable.nl/koorts";
// Zolang dit leeg is ("") toont de site "Tickets binnenkort beschikbaar".
const TICKET_SHOP_URL = "";

const euro = cents => new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" }).format(cents / 100);
const statusElement = document.querySelector("#page-status");
const text = (tag, content, className) => {
  const el = document.createElement(tag);
  el.textContent = content;
  if (className) el.className = className;
  return el;
};
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options.headers }, signal: AbortSignal.timeout(20000) });
  if (response.status === 204) return null;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || "Verzoek mislukt.");
  return result;
}

function applyTicketShop() {
  // Vervangt de "binnenkort"-badge door een echte koopknop zodra TICKET_SHOP_URL is ingevuld.
  const badge = document.querySelector("#upcoming-events .badge-soon");
  if (!badge || !TICKET_SHOP_URL) return;
  const link = text("a", "🎟️ Koop tickets", "btn btn-primary");
  link.href = TICKET_SHOP_URL;
  link.rel = "noopener";
  badge.replaceWith(link);
}

async function loadEventCards() {
  const container = document.querySelector("#upcoming-events");
  if (!container) return;
  // Verkoop via Tickable: de eigen backend-verkoop wordt dan niet meer geladen.
  if (TICKET_SHOP_URL) return;
  try {
    const { events } = await api("/api/events");
    if (!events.length) return;
    container.replaceChildren(...events.map(event => {
      const card = document.createElement("article");
      card.className = "event-card";
      card.append(text("h3", event.title), text("p", `${new Date(event.startsAt).toLocaleString("nl-NL")} · ${event.location}`), text("p", euro(event.priceCents)));
      const link = text("a", "Koop tickets", "btn btn-primary");
      link.href = `tickets.html?event=${encodeURIComponent(event.id)}`;
      card.append(link);
      return card;
    }));
  } catch (error) {
    container.append(text("p", `Ticketverkoop kon niet worden geladen: ${error.message}`, "notice error"));
  }
}

async function checkoutPage() {
  const form = document.querySelector("#checkout-form");
  if (!form) return;
  const { events } = await api("/api/events");
  const event = events.find(e => e.id === new URLSearchParams(location.search).get("event"));
  if (!event) throw new Error("Dit evenement is niet beschikbaar voor ticketverkoop.");
  statusElement.textContent = "Betalen via iDEAL. De prijs wordt gecontroleerd door onze server.";
  const details = document.querySelector("#ticket-details");
  details.append(text("h2", event.title), text("p", `${new Date(event.startsAt).toLocaleString("nl-NL")} · ${event.location}`));
  details.hidden = form.hidden = false;
  const updateTotal = () => { document.querySelector("#checkout-total").textContent = `Totaal: ${euro(event.priceCents * Number(form.elements.quantity.value))}`; };
  form.elements.quantity.addEventListener("input", updateTotal);
  updateTotal();
  let pending = null;
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const button = form.querySelector("button");
    const errorEl = document.querySelector("#checkout-error");
    button.disabled = true;
    errorEl.hidden = true;
    const values = { eventId: event.id, name: form.elements.name.value, email: form.elements.email.value, quantity: Number(form.elements.quantity.value) };
    const fingerprint = JSON.stringify(values);
    if (!pending) {
      try { pending = JSON.parse(sessionStorage.getItem("koorts-checkout")); }
      catch (error) { console.warn("Opgeslagen betaalpoging kon niet worden gelezen:", error.message); }
    }
    if (!pending || pending.fingerprint !== fingerprint) {
      pending = { fingerprint, requestId: crypto.randomUUID() };
      try { sessionStorage.setItem("koorts-checkout", JSON.stringify(pending)); }
      catch (error) { console.warn("Betaalpoging kon niet lokaal worden bewaard:", error.message); }
    }
    try {
      const result = await api("/api/orders", { method: "POST", body: JSON.stringify({ ...values, requestId: pending.requestId }) });
      try { sessionStorage.removeItem("koorts-checkout"); }
      catch (error) { console.warn("Lokale betaalpoging kon niet worden opgeruimd:", error.message); }
      location.assign(result.checkoutUrl);
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
      button.disabled = false;
    }
  });
}

async function orderPage() {
  const container = document.querySelector("#order-tickets");
  if (!container) return;
  const access = location.hash.slice(1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(access)) throw new Error("De persoonlijke bestellink ontbreekt of is ongeldig.");
  let timer;
  let attempts = 0;
  let busy = false;
  const refresh = async () => {
    if (busy) return;
    busy = true;
    clearTimeout(timer);
    try {
      const order = await api("/api/order", { headers: { "X-Order-Token": access } });
      const labels = {
        pending: "We wachten op bevestiging van je betaling. Je tickets verschijnen na bevestiging.",
        paid: "Betaling bevestigd. Hieronder staan je tickets.",
        failed: "De betaling is mislukt.", canceled: "De betaling is geannuleerd.", expired: "De betaling is verlopen.",
        refunded: "Deze bestelling is terugbetaald of teruggedraaid. De tickets zijn niet geldig.", chargeback: "Deze betaling is teruggedraaid. De tickets zijn niet geldig."
      };
      statusElement.textContent = order.manualTest
        ? "TEST — QR-testtickets zonder betaling. Alleen geldig voor dit privé-testevenement."
        : `${order.isTest ? "TEST — " : ""}${labels[order.status] || "Onbekende betaalstatus."}`;
      const details = document.querySelector("#order-details");
      details.replaceChildren(text("h2", order.event.title), text("p", order.manualTest
        ? `${order.quantity} testticket(s) · Geen betaling · Geen e-mail`
        : `${order.quantity} ticket(s) · ${euro(order.amountCents)}`));
      if (order.mailStatus === "preview") details.append(text("p", "Lokale preview: er is geen e-mail verstuurd.", "notice"));
      if (order.mailStatus === "pending") details.append(text("p", "Je ticketmail wordt verwerkt. Je tickets zijn hieronder al beschikbaar."));
      container.replaceChildren(...order.tickets.map((ticket, i) => {
        const card = document.createElement("article");
        card.className = "panel ticket-card";
        const img = document.createElement("img");
        img.src = ticket.qrDataUrl;
        img.alt = `QR-code voor ticket ${i + 1}`;
        img.width = img.height = 300;
        card.append(text("h3", `${order.isTest ? "TEST — " : ""}Ticket ${i + 1}`), img, text("p", ticket.scannedAt ? "Dit ticket is al gescand." : "Laat deze QR-code scannen bij de ingang."));
        return card;
      }));
      if (order.status === "pending" && ++attempts < 60) timer = setTimeout(refresh, 3000);
    } catch (error) {
      statusElement.textContent = `Status niet beschikbaar: ${error.message} Gebruik de knop om opnieuw te proberen.`;
    } finally { busy = false; }
  };
  document.querySelector("#refresh-order").addEventListener("click", refresh);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(timer);
    else refresh();
  });
  await refresh();
}

async function devPaymentPage() {
  const actions = document.querySelector("#dev-payment-actions");
  if (!actions) return;
  const id = location.hash.slice(1);
  if (!/^mock_[A-Za-z0-9_-]{43}$/.test(id)) throw new Error("Ongeldige lokale testbetaling.");
  const { orderToken, payment } = await api(`/api/dev/payments/${id}`);
  const link = document.querySelector("#dev-order-link");
  link.href = `bestelling.html#${orderToken}`;
  link.hidden = false;
  statusElement.textContent = `TEST — ${euro(payment.amountCents)} · status: ${payment.status}`;
  actions.hidden = payment.status !== "open";
  actions.addEventListener("click", async event => {
    const button = event.target.closest("[data-payment-status]");
    if (!button) return;
    actions.querySelectorAll("button").forEach(el => { el.disabled = true; });
    try {
      await api(`/api/dev/payments/${id}`, { method: "POST", body: JSON.stringify({ status: button.dataset.paymentStatus }) });
      location.assign(link.href);
    } catch (error) {
      statusElement.textContent = error.message;
      actions.querySelectorAll("button").forEach(el => { el.disabled = false; });
    }
  });
}

applyTicketShop();
Promise.all([loadEventCards(), checkoutPage(), orderPage(), devPaymentPage()]).catch(error => {
  if (statusElement) statusElement.textContent = error.message;
  else console.error("Ticketpagina laden mislukt:", error.message);
});
