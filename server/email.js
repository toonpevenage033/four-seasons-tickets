const { Resend } = require("resend");
const { EVENT, formatPrice } = require("./pricing");

let resend = null;
function getResend() {
  if (!resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY ontbreekt in .env");
    }
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

function ticketBlockHtml(ticket) {
  return `
    <div style="border:1px solid #e2e2e2;border-radius:12px;padding:20px;margin:16px 0;text-align:center;">
      <p style="margin:0 0 8px;font-size:14px;color:#666;">Ticketcode</p>
      <p style="margin:0 0 16px;font-family:monospace;font-size:16px;letter-spacing:1px;">${ticket.code}</p>
      <img src="${ticket.qrDataUrl}" alt="QR-code ticket" width="220" height="220" />
      <p style="margin:16px 0 0;font-size:13px;color:#888;">Laat deze QR-code scannen bij de ingang.</p>
    </div>
  `;
}

async function sendTicketsEmail({ to, name, tier, tickets, orderId }) {
  const client = getResend();
  const ticketsHtml = tickets.map(ticketBlockHtml).join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#222;">
      <h1 style="font-size:22px;">Je tickets voor ${EVENT.name} 🎉</h1>
      <p>Hoi ${name || ""},</p>
      <p>Bedankt voor je aankoop! Hieronder vind je ${tickets.length === 1 ? "je ticket" : "je " + tickets.length + " tickets"}.</p>
      <ul style="padding-left:18px;">
        <li><strong>Locatie:</strong> ${EVENT.address}</li>
        <li><strong>Datum:</strong> 31 oktober, 21:00 - 02:00</li>
        <li><strong>Tarief:</strong> ${tier.label} (€${formatPrice(tier.priceCents)} per ticket)</li>
        <li><strong>Bestelnummer:</strong> ${orderId}</li>
      </ul>
      ${ticketsHtml}
      <div style="background:#fdeaea;border:2px solid #b3261e;border-radius:10px;padding:16px;margin:16px 0;color:#7a1913;">
        <strong>Belangrijke voorwaarden:</strong>
        <ul style="padding-left:18px;margin:8px 0 0;">
          <li>Minimumleeftijd 15 jaar. Jonger? Dan kom je niet binnen.</li>
          <li>Neem een geldig ID mee, dit wordt bij de deur gecontroleerd.</li>
          <li><strong>Verkleedplicht</strong> (Halloween-thema) — kom je niet verkleed, dan word je geweigerd.</li>
          <li>Geen restitutie, ook niet bij weigering aan de deur.</li>
        </ul>
      </div>
      <p style="font-size:13px;color:#888;">Elke QR-code is uniek en kan maar één keer gescand worden bij de ingang. Bewaar deze e-mail goed.</p>
    </div>
  `;

  const result = await client.emails.send({
    from: process.env.EMAIL_FROM,
    to,
    subject: `Je ${tickets.length > 1 ? "tickets" : "ticket"} voor ${EVENT.name}`,
    html,
  });
  if (result.error) throw new Error(result.error.message || "Resend gaf een fout terug.");
  return result;
}

async function sendPaymentInstructionsEmail({ to, name, tier, quantity, reference, amountFormatted, iban, accountHolder, paymentQrDataUrl }) {
  const client = getResend();

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#222;">
      <h1 style="font-size:22px;">Bijna klaar — rond je betaling af 🎟️</h1>
      <p>Hoi ${name || ""},</p>
      <p>Je hebt ${quantity} ticket${quantity > 1 ? "s" : ""} (${tier.label}) gereserveerd voor ${EVENT.name}. Maak het bedrag hieronder over, dan bevestigen wij je bestelling en ontvang je je ticket(s) met QR-code.</p>
      <div style="border:1px solid #e2e2e2;border-radius:12px;padding:20px;margin:16px 0;">
        <p style="margin:0 0 8px;"><strong>Bedrag:</strong> € ${amountFormatted}</p>
        <p style="margin:0 0 8px;"><strong>IBAN:</strong> ${iban}</p>
        <p style="margin:0 0 8px;"><strong>T.n.v.:</strong> ${accountHolder}</p>
        <p style="margin:0;"><strong>Omschrijving (verplicht!):</strong> ${reference}</p>
      </div>
      <div style="background:#fff3cd;border:1px solid #e0b84c;border-radius:10px;padding:14px;margin:16px 0;">
        <strong>Belangrijk:</strong> dit is alleen de QR-code om te betalen. Dit is nog niet je toegangsticket.
        Je ontvangt de echte ticket-QR pas nadat je betaling door ons is gecontroleerd en bevestigd.
      </div>
      <p><strong>Scan deze betaal-QR met je bankapp:</strong></p>
      <p><img src="${paymentQrDataUrl}" alt="Betaal-QR-code" width="240" height="240" /></p>
      <p><strong>Controleer vóór het betalen:</strong> het bedrag, IBAN en vooral referentiecode <span style="font-family:monospace;">${reference}</span> moeten zichtbaar zijn in je bankapp.</p>
      <p style="font-size:13px;color:#888;">Vermeld altijd de omschrijving hierboven, anders kunnen we je betaling niet koppelen aan je bestelling. Reserveringen zonder betaling binnen ${require("./pricing").PENDING_ORDER_TTL_HOURS} uur vervallen automatisch.</p>
      <div style="background:#fdeaea;border:2px solid #b3261e;border-radius:10px;padding:16px;margin:16px 0;color:#7a1913;">
        <strong>Belangrijke voorwaarden:</strong>
        <ul style="padding-left:18px;margin:8px 0 0;">
          <li>Maak <strong>exact</strong> het bedrag hierboven over. Een afwijkend bedrag betekent geen ticket en geen restitutie.</li>
          <li>Minimumleeftijd 15 jaar. Jonger? Dan kom je niet binnen.</li>
          <li>Neem een geldig ID mee, dit wordt bij de deur gecontroleerd.</li>
          <li><strong>Verkleedplicht</strong> (Halloween-thema) — kom je niet verkleed, dan word je geweigerd.</li>
          <li>Geen restitutie, in geen enkel geval.</li>
        </ul>
      </div>
      <p style="font-size:13px;color:#888;"><strong>Locatie:</strong> ${EVENT.address}<br /><strong>Datum:</strong> 31 oktober, 21:00 - 02:00</p>
    </div>
  `;

  const result = await client.emails.send({
    from: process.env.EMAIL_FROM,
    to,
    subject: `Rond je betaling af voor ${EVENT.name} — ref. ${reference}`,
    html,
  });
  if (result.error) throw new Error(result.error.message || "Resend gaf een fout terug.");
  return result;
}

module.exports = { sendTicketsEmail, sendPaymentInstructionsEmail };
