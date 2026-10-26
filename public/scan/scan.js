const tokenForm = document.getElementById("token-form");
const scanControls = document.getElementById("scan-controls");
const cameraError = document.getElementById("camera-error");
const manualForm = document.getElementById("manual-form");
const manualCodeInput = document.getElementById("manual-code");
const resultEl = document.getElementById("result");
const nextBtn = document.getElementById("next-btn");
const audioStatus = document.getElementById("audio-status");
const audioEnableBtn = document.getElementById("audio-enable");

let staffToken = sessionStorage.getItem("staffToken") || "";
let scanner = null;
let audioContext = null;
let awaitingNext = false;

async function enableAudio() {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) {
    audioStatus.textContent = "Geluid niet beschikbaar; controleer ook de melding op het scherm.";
    audioEnableBtn.hidden = true;
    return false;
  }

  try {
    audioContext ||= new AudioContextConstructor();
    if (audioContext.state !== "running") await audioContext.resume();
    const enabled = audioContext.state === "running";
    audioStatus.textContent = enabled ? "Geluid aan" : "Tik op Geluid aanzetten voor geluid.";
    audioEnableBtn.hidden = enabled;
    return enabled;
  } catch (err) {
    audioStatus.textContent = "Tik op Geluid aanzetten voor geluid.";
    audioEnableBtn.hidden = false;
    return false;
  }
}

function playFeedbackSound(valid) {
  if (!audioContext || audioContext.state !== "running") return;

  const start = audioContext.currentTime;
  const tones = valid
    ? [
        { frequency: 660, offset: 0, duration: 0.14, type: "sine" },
        { frequency: 880, offset: 0.12, duration: 0.2, type: "sine" },
      ]
    : [
        { frequency: 190, offset: 0, duration: 0.18, type: "sawtooth" },
        { frequency: 135, offset: 0.22, duration: 0.22, type: "sawtooth" },
      ];

  for (const tone of tones) {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const toneStart = start + tone.offset;
    oscillator.type = tone.type;
    oscillator.frequency.setValueAtTime(tone.frequency, toneStart);
    gain.gain.setValueAtTime(0.0001, toneStart);
    gain.gain.exponentialRampToValueAtTime(valid ? 0.16 : 0.11, toneStart + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, toneStart + tone.duration);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(toneStart);
    oscillator.stop(toneStart + tone.duration);
  }
}

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
    playFeedbackSound(data.valid);
  } catch (err) {
    showResult(false, "Kon niet verifiëren, controleer verbinding.");
    playFeedbackSound(false);
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

audioEnableBtn.addEventListener("click", enableAudio);

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
  const audioReady = enableAudio();
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
  await audioReady;
  await startScanner();
});

if (staffToken) {
  checkToken(staffToken).then(async (ok) => {
    if (ok) {
      tokenForm.hidden = true;
      await enableAudio();
      startScanner();
    } else {
      sessionStorage.removeItem("staffToken");
      staffToken = "";
    }
  });
}
