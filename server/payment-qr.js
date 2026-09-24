const QRCode = require("qrcode");

function createEpcPayload({ iban, accountHolder, amountCents, reference }) {
  const normalizedIban = String(iban || "").replace(/\s+/g, "").toUpperCase();
  const amount = `EUR${(amountCents / 100).toFixed(2)}`;

  return [
    "BCD",
    "002",
    "1",
    "SCT",
    "",
    accountHolder,
    normalizedIban,
    amount,
    "",
    reference,
  ].join("\n");
}

async function generatePaymentQrDataUrl(details) {
  return QRCode.toDataURL(createEpcPayload(details), {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 280,
  });
}

// Zelfde QR, maar als ruwe buffer voor een echte e-mailbijlage (cid) i.p.v. een
// data:-URL, want veel e-mailprogramma's blokkeren ingebedde data:-afbeeldingen.
async function generatePaymentQrBuffer(details) {
  return QRCode.toBuffer(createEpcPayload(details), {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 280,
  });
}

module.exports = { generatePaymentQrDataUrl, generatePaymentQrBuffer };
