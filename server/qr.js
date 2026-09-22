const QRCode = require("qrcode");

// Genereert een PNG (als base64 data URL) die de unieke ticketcode bevat.
async function generateQrDataUrl(code) {
  return QRCode.toDataURL(code, { errorCorrectionLevel: "H", margin: 2, width: 320 });
}

module.exports = { generateQrDataUrl };
