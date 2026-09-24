const QRCode = require("qrcode");

// Genereert een PNG (als base64 data URL) die de unieke ticketcode bevat.
async function generateQrDataUrl(code) {
  return QRCode.toDataURL(code, { errorCorrectionLevel: "H", margin: 2, width: 320 });
}

// Zelfde QR, maar als ruwe buffer voor een echte e-mailbijlage (cid) i.p.v. een
// data:-URL, want veel e-mailprogramma's blokkeren ingebedde data:-afbeeldingen.
async function generateQrBuffer(code) {
  return QRCode.toBuffer(code, { errorCorrectionLevel: "H", margin: 2, width: 320 });
}

module.exports = { generateQrDataUrl, generateQrBuffer };
