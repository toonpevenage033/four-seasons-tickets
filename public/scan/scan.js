const tokenForm = document.getElementById("token-form");
const readerEl = document.getElementById("reader");
const resultEl = document.getElementById("result");

let staffToken = sessionStorage.getItem("staffToken") || "";
let scanner = null;
let processing = false;

function showResult(valid, message) {
  resultEl.hidden = false;
  resultEl.textContent = message;
  resultEl.className = "result-banner " + (valid ? "result-valid" : "result-invalid");
}

async function onScanSuccess(code) {
  if (processing) return;
  processing = true;

  try {
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Staff-Token": staffToken },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    showResult(data.valid, data.message);
  } catch (err) {
    showResult(false, "Kon niet verifiëren, controleer verbinding.");
  }

  setTimeout(() => { processing = false; }, 1500);
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

tokenForm.addEventListener("submit", (e) => {
  e.preventDefault();
  staffToken = tokenForm.token.value;
  sessionStorage.setItem("staffToken", staffToken);
  tokenForm.hidden = true;
  startScanner();
});

if (staffToken) {
  tokenForm.hidden = true;
  startScanner();
}
