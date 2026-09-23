const tokenForm = document.getElementById("token-form");
const readerEl = document.getElementById("reader");
const resultEl = document.getElementById("result");
const nextBtn = document.getElementById("next-btn");

let staffToken = sessionStorage.getItem("staffToken") || "";
let scanner = null;
let awaitingNext = false;

function showResult(valid, message, extra) {
  resultEl.hidden = false;
  const details = extra ? `<div class="result-extra">${extra}</div>` : "";
  resultEl.innerHTML = `<div class="result-main">${message}</div>${details}`;
  resultEl.className = "result-banner " + (valid ? "result-valid" : "result-invalid");
  nextBtn.hidden = false;
  awaitingNext = true;
}

async function onScanSuccess(code) {
  if (awaitingNext) return; // pas weer scannen na klikken op "Volgende"
  awaitingNext = true; // direct blokkeren, voorkomt dubbele scans tijdens het wachten op het antwoord

  try {
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Staff-Token": staffToken },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    const extra = data.valid
      ? [data.name, data.tier].filter(Boolean).join(" · ")
      : "";
    showResult(data.valid, data.message, extra);
  } catch (err) {
    showResult(false, "Kon niet verifiëren, controleer verbinding.");
  }
}

function startScanner() {
  readerEl.hidden = false;
  scanner = new Html5Qrcode("reader");
  scanner.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: 250 },
    (decodedText) => onScanSuccess(decodedText)
  );
}

nextBtn.addEventListener("click", () => {
  resultEl.hidden = true;
  nextBtn.hidden = true;
  awaitingNext = false;
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
  startScanner();
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
