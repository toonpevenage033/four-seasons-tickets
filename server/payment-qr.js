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

module.exports = { generatePaymentQrDataUrl };
