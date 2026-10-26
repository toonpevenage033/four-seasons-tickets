const tokenForm = document.getElementById("token-form");
const scanControls = document.getElementById("scan-controls");
const cameraError = document.getElementById("camera-error");
const manualForm = document.getElementById("manual-form");
const manualCodeInput = document.getElementById("manual-code");
const resultEl = document.getElementById("result");
const nextBtn = document.getElementById("next-btn");

let staffToken = sessionStorage.getItem("staffToken") || "";
let scanner = null;
let awaitingNext = false;

function showResult(valid, message, extra) {
  resultEl.hidden = false;
  resultEl.replaceChildren();
  const main = document.createElement("div");
  main.className = "result-main";
  main.textContent = message;
  resultEl.append(main);
  if (extra) {
    const details = document.createElement("div");
    details.className = "result-extra";
    details.textContent = extra;
    resultEl.append(details);
  }
  resultEl.className = "result-banner " + (valid ? "result-valid" : "result-invalid");
  nextBtn.hidden = false;
  awaitingNext = true;
}

async function verifyTicket(code) {
  if (awaitingNext) return; // pas weer scannen na klikken op "Volgende"
  const cleanCode = code.trim();
  if (!cleanCode) return;
  awaitingNext = true; // direct blokkeren, voorkomt dubbele scans tijdens het wachten op het antwoord
  manualCodeInput.disabled = true;
  cameraError.hidden = true;

  try {
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Staff-Token": staffToken },
      body: JSON.stringify({ code: cleanCode }),
    });
    const data = await res.json();
    const extra = data.valid
      ? [data.name, data.tier].filter(Boolean).join(" · ")
      : "";
    showResult(data.valid, data.message || "Ticket kon niet worden gecontroleerd.", extra);
  } catch (err) {
    showResult(false, "Kon niet verifiëren, controleer verbinding.");
  }
}

async function startScanner() {
  scanControls.hidden = false;
  try {
    scanner = new Html5Qrcode("reader");
    await scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 250 },
      (decodedText) => verifyTicket(decodedText)
    );
    cameraError.hidden = true;
  } catch (err) {
    cameraError.textContent = "Camera niet beschikbaar. Voer de code hierboven handmatig in.";
    cameraError.hidden = false;
    manualCodeInput.focus();
  }
}

manualForm.addEventListener("submit", (event) => {
  event.preventDefault();
  verifyTicket(manualCodeInput.value);
});

nextBtn.addEventListener("click", () => {
  resultEl.hidden = true;
  nextBtn.hidden = true;
  awaitingNext = false;
  manualCodeInput.value = "";
  manualCodeInput.disabled = false;
  manualCodeInput.focus();
});

async function checkToken(token) {
  try {
    const res = await fetch("/api/staff/ping", { headers: { "X-Staff-Token": token } });
    return res.ok;
  } catch (err) {
    return false;
  }
}

tokenForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const tokenError = document.getElementById("token-error");
  const submitBtn = tokenForm.querySelector("button");
  submitBtn.disabled = true;

  const candidate = tokenForm.token.value;
  const ok = await checkToken(candidate);

  if (!ok) {
    tokenError.hidden = false;
    submitBtn.disabled = false;
    return;
  }

  staffToken = candidate;
  sessionStorage.setItem("staffToken", staffToken);
  tokenForm.hidden = true;
  await startScanner();
});

if (staffToken) {
  checkToken(staffToken).then((ok) => {
    if (ok) {
      tokenForm.hidden = true;
      startScanner();
    } else {
      sessionStorage.removeItem("staffToken");
      staffToken = "";
    }
  });
}
