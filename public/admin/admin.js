const tokenForm = document.getElementById("token-form");
const app = document.getElementById("app");
const ordersBody = document.getElementById("orders-body");
const refreshBtn = document.getElementById("refresh-btn");
const adminNotice = document.getElementById("admin-notice");
const statsBox = document.getElementById("stats-box");
const searchInput = document.getElementById("search-input");
const socialTicketForm = document.getElementById("social-ticket-form");
const socialTicketList = document.getElementById("social-ticket-list");
const socialTicketPaid = document.getElementById("social-ticket-paid");
const socialTicketSubmit = document.getElementById("social-ticket-submit");
const socialTicketResult = document.getElementById("social-ticket-result");

let adminToken = sessionStorage.getItem("adminToken") || "";
let allOrders = [];

function formatCents(cents) {
  return (cents / 100).toFixed(2).replace(".", ",");
}

function showNotice(message, type = "success") {
  adminNotice.textContent = message;
  adminNotice.className = `admin-notice admin-notice-${type}`;
  adminNotice.hidden = false;
}

function parseSocialTicketList(value) {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 1 || lines.length > 30) {
    return { error: "Vul 1 tot 30 regels in." };
  }

  const seenEmails = new Set();
  const orders = [];
  for (const line of lines) {
    const fields = line.split(/[,;\t]/).map((field) => field.trim());
    const email = fields[0] || "";
    const quantity = Number(fields[1]);
    if (fields.length !== 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { error: `Controleer deze regel: ${line}` };
    }
    if (seenEmails.has(email.toLowerCase())) {
      return { error: `Dit e-mailadres staat dubbel in de lijst: ${email}.` };
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 6) {
      return { error: `Het aantal voor ${email} moet tussen 1 en 6 zijn.` };
    }
    seenEmails.add(email.toLowerCase());
    orders.push({ email, quantity });
  }
  return { orders, totalTickets: orders.reduce((total, order) => total + order.quantity, 0) };
}

socialTicketList.addEventListener("input", () => {
  const parsed = parseSocialTicketList(socialTicketList.value);
  if (parsed.error) {
    socialTicketResult.hidden = true;
    return;
  }
  socialTicketResult.textContent = `${parsed.orders.length} e-mailadressen, ${parsed.totalTickets} tickets, totaal € ${formatCents(parsed.totalTickets * 2500)}.`;
  socialTicketResult.className = "admin-notice admin-notice-pending";
  socialTicketResult.hidden = false;
});

socialTicketForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const parsed = parseSocialTicketList(socialTicketList.value);
  if (parsed.error) {
    socialTicketResult.textContent = parsed.error;
    socialTicketResult.className = "admin-notice admin-notice-error";
    socialTicketResult.hidden = false;
    return;
  }
  if (!socialTicketPaid.checked) {
    socialTicketResult.textContent = "Bevestig eerst dat alle tickets betaald zijn.";
    socialTicketResult.className = "admin-notice admin-notice-error";
    socialTicketResult.hidden = false;
    return;
  }
  const amount = formatCents(parsed.totalTickets * 2500);
  if (!confirm(`Maak ${parsed.totalTickets} betaalde tickets aan voor €25 per ticket (€${amount} totaal) en verstuur ze naar ${parsed.orders.length} adressen?`)) {
    return;
  }

  let batchId = sessionStorage.getItem("socialTicketBatchId");
  if (!batchId) {
    batchId = crypto.randomUUID();
    sessionStorage.setItem("socialTicketBatchId", batchId);
  }
  socialTicketSubmit.disabled = true;
  socialTicketSubmit.textContent = "Tickets aanmaken en versturen...";
  socialTicketResult.textContent = "Voorraad controleren en tickets verwerken...";
  socialTicketResult.className = "admin-notice admin-notice-pending";
  socialTicketResult.hidden = false;

  try {
    const res = await fetch("/api/admin/social-orders", {
      method: "POST",
      headers: { "X-Admin-Token": adminToken, "Content-Type": "application/json" },
      body: JSON.stringify({ batchId, orders: parsed.orders }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Socialtickets konden niet worden aangemaakt.");

    const results = [];
    for (let index = 0; index < data.orders.length; index++) {
      const order = data.orders[index];
      if (order.emailSentAt) {
        results.push({ email: order.email, status: "sent" });
        continue;
      }

      socialTicketResult.textContent = `Ticketmail ${index + 1} van ${data.orders.length}: ${order.email}`;
      try {
        const mailRes = await fetch(`/api/admin/social-orders/${order.id}/send`, {
          method: "POST",
          headers: { "X-Admin-Token": adminToken },
        });
        const mailData = await mailRes.json();
        if (!mailRes.ok) throw new Error(mailData.error || "E-mail versturen is mislukt.");
        results.push({ email: order.email, status: "sent" });
      } catch (err) {
        results.push({ email: order.email, status: "failed", error: err.message });
      }
    }

    const failed = results.filter((result) => result.status === "failed");
    socialTicketResult.textContent = failed.length
      ? `${data.totalTickets} tickets geregistreerd. E-mail niet bevestigd voor: ${failed.map((result) => result.email).join(", ")}. Controleer de bestellingen vóór opnieuw versturen.`
      : `${data.totalTickets} tickets geregistreerd en alle ticketmails zijn verstuurd.`;
    socialTicketResult.className = `admin-notice ${failed.length ? "admin-notice-error" : "admin-notice-success"}`;
    if (!failed.length) {
      sessionStorage.removeItem("socialTicketBatchId");
      socialTicketList.value = "";
      socialTicketPaid.checked = false;
    }
    await loadOrders();
  } catch (err) {
    socialTicketResult.textContent = err.message || "Er ging iets mis. Probeer dezelfde lijst opnieuw; een verwerkte batch wordt niet dubbel aangemaakt.";
    socialTicketResult.className = "admin-notice admin-notice-error";
    socialTicketSubmit.disabled = false;
  } finally {
    socialTicketSubmit.textContent = "Maak tickets en verstuur e-mails";
  }
});

function renderStats(stats) {
  if (!stats) return;
  statsBox.innerHTML = `
    <div class="stat"><span>${stats.totalSold}</span><small>totaal verkocht (van ${stats.maxTickets})</small></div>
    <div class="stat"><span>${stats.totalRemaining}</span><small>totaal nog beschikbaar</small></div>
    <div class="stat"><span>${stats.earlybirdSold}</span><small>Early Bird verkocht (van ${stats.earlybirdCap})</small></div>
    <div class="stat"><span>${stats.earlybirdRemaining}</span><small>Early Bird nog over</small></div>
    <div class="stat"><span>${stats.awaitingTickets}</span><small>tickets wachten op betaling</small></div>
    <div class="stat"><span>€ ${formatCents(stats.paidRevenueCents)}</span><small>ontvangen van betaalde tickets</small></div>
    <div class="stat"><span>€ ${formatCents(stats.awaitingRevenueCents)}</span><small>nog openstaand bedrag</small></div>
  `;
}

function applyFilter() {
  const query = searchInput.value.trim().toLowerCase();
  const filtered = !query
    ? allOrders
    : allOrders.filter((o) =>
        [o.reference, o.name, o.email].some((field) => (field || "").toLowerCase().includes(query))
      );
  renderOrders(filtered);
}

searchInput.addEventListener("input", applyFilter);

async function loadOrders() {
  const res = await fetch("/api/admin/orders", {
    headers: { "X-Admin-Token": adminToken },
  });
  if (res.status === 401) {
    alert("Ongeldige admin-code.");
    sessionStorage.removeItem("adminToken");
    location.reload();
    return;
  }
  const data = await res.json();
  renderStats(data.stats);
  allOrders = data.orders;
  applyFilter();
}

async function checkToken(token) {
  try {
    const res = await fetch("/api/admin/ping", { headers: { "X-Admin-Token": token } });
    return res.ok;
  } catch (err) {
    return false;
  }
}

function renderOrders(orders) {
  ordersBody.innerHTML = "";
  let previousDateKey = "";
  for (const order of orders) {
    const createdAt = new Date(order.createdAt);
    const dateKey = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Amsterdam",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(createdAt);

    if (dateKey !== previousDateKey) {
      const divider = document.createElement("tr");
      divider.className = "date-divider";
      const dividerCell = document.createElement("td");
      dividerCell.colSpan = 8;
      dividerCell.textContent = new Intl.DateTimeFormat("nl-NL", {
        timeZone: "Europe/Amsterdam",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(createdAt);
      divider.appendChild(dividerCell);
      ordersBody.appendChild(divider);
      previousDateKey = dateKey;
    }

    const tr = document.createElement("tr");
    tr.dataset.orderId = order.id;
    const date = createdAt.toLocaleTimeString("nl-NL", {
      timeZone: "Europe/Amsterdam",
      hour: "2-digit",
      minute: "2-digit",
    });

    tr.innerHTML = `
      <td>${date}</td>
      <td>${order.name}</td>
      <td>${order.email}</td>
      <td>${order.quantity}</td>
      <td>€ ${formatCents(order.amountCents)}</td>
      <td><strong>${order.reference}</strong></td>
      <td>${order.status}</td>
      <td></td>
    `;

    const actionCell = tr.lastElementChild;
    const actionStatus = document.createElement("div");
    actionStatus.className = "row-action-status";
    actionCell.append(actionStatus);

    const emailEditor = document.createElement("div");
    emailEditor.className = "email-editor";
    const emailInput = document.createElement("input");
    emailInput.type = "email";
    emailInput.value = order.email;
    emailInput.placeholder = "Nieuw e-mailadres";
    emailInput.className = "email-editor-input";
    const emailSave = document.createElement("button");
    emailSave.type = "button";
    emailSave.textContent = "E-mail opslaan";
    emailSave.className = "secondary-btn";
    emailSave.onclick = () => updateEmail(order.id, emailInput, emailSave, actionStatus);
    emailEditor.append(emailInput, emailSave);
    actionCell.append(emailEditor);

    if (order.status === "awaiting_payment") {
      const approveBtn = document.createElement("button");
      approveBtn.textContent = "Bevestig betaling";
      approveBtn.className = "approve-btn";
      approveBtn.onclick = () => updateOrder(order.id, "approve", approveBtn, "Bevestigen...");

      const rejectBtn = document.createElement("button");
      rejectBtn.textContent = "Afwijzen";
      rejectBtn.className = "reject-btn";
      rejectBtn.onclick = () => updateOrder(order.id, "reject", rejectBtn, "Afwijzen...");

      const remindBtn = document.createElement("button");
      remindBtn.textContent = "Stuur betalingsherinnering";
      remindBtn.className = "secondary-btn";
      remindBtn.onclick = () => updateOrder(order.id, "remind", remindBtn, "Versturen...");

      actionCell.append(approveBtn, rejectBtn, remindBtn);
    }

    if (order.status === "paid") {
      const resendBtn = document.createElement("button");
      resendBtn.textContent = "Mail opnieuw versturen";
      resendBtn.className = "approve-btn";
      resendBtn.onclick = () => updateOrder(order.id, "resend-email", resendBtn, "Versturen...");
      actionCell.append(resendBtn);

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Annuleer / geen toegang";
      cancelBtn.className = "reject-btn";
      cancelBtn.onclick = () => {
        if (confirm("Weet je zeker dat deze bestelling geen toegang meer mag geven? De QR-code wordt ongeldig.")) {
          updateOrder(order.id, "cancel", cancelBtn, "Annuleren...");
        }
      };
      actionCell.append(cancelBtn);
    }

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Verwijder volledig";
    deleteBtn.className = "reject-btn";
    deleteBtn.onclick = () => {
      if (confirm("Deze bestelling en bijbehorende ticket(s) volledig en onherroepelijk verwijderen (bv. test-data)?")) {
        deleteOrder(order.id, deleteBtn);
      }
    };
    actionCell.append(deleteBtn);

    ordersBody.appendChild(tr);
  }
}

async function updateOrder(orderId, action, button, busyText) {
  const originalText = button.textContent;
  const actionCell = button.closest("td");
  const rowStatus = actionCell.querySelector(".row-action-status");
  button.disabled = true;
  button.textContent = busyText;
  rowStatus.textContent = "Actie wordt uitgevoerd...";
  rowStatus.className = "row-action-status row-action-pending";

  const actionNames = {
    approve: "Betaling bevestigd.",
    reject: "Bestelling afgewezen.",
    "resend-email": "Ticketmail opnieuw verstuurd.",
    cancel: "Bestelling geannuleerd; QR-code is ongeldig.",
    remind: "Betalingsherinnering verstuurd.",
  };

  const res = await fetch(`/api/admin/orders/${orderId}/${action}`, {
    method: "POST",
    headers: { "X-Admin-Token": adminToken },
  });
  const data = await res.json();
  if (!res.ok) {
    const message = data.error || "Er ging iets mis.";
    rowStatus.textContent = message;
    rowStatus.className = "row-action-status row-action-error";
    button.disabled = false;
    button.textContent = originalText;
    return;
  }
  if (data.emailError) {
    rowStatus.textContent = data.emailError;
    rowStatus.className = "row-action-status row-action-error";
  } else {
    rowStatus.textContent = actionNames[action] || "Actie uitgevoerd.";
    rowStatus.className = "row-action-status row-action-success";
  }
  await loadOrders();
  const refreshedRow = ordersBody.querySelector(`[data-order-id="${orderId}"]`);
  if (refreshedRow) {
    const refreshedStatus = refreshedRow.querySelector(".row-action-status");
    refreshedStatus.textContent = data.emailError || actionNames[action] || "Actie uitgevoerd.";
    refreshedStatus.className = `row-action-status ${data.emailError ? "row-action-error" : "row-action-success"}`;
  }
}

async function updateEmail(orderId, input, button, statusElement) {
  const email = input.value.trim();
  if (!email) {
    statusElement.textContent = "Vul een e-mailadres in.";
    statusElement.className = "row-action-status row-action-error";
    return;
  }

  button.disabled = true;
  button.textContent = "Opslaan...";
  statusElement.textContent = "E-mailadres wordt opgeslagen...";
  statusElement.className = "row-action-status row-action-pending";

  const res = await fetch(`/api/admin/orders/${orderId}/email`, {
    method: "POST",
    headers: { "X-Admin-Token": adminToken, "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data = await res.json();
  if (!res.ok) {
    statusElement.textContent = data.error || "E-mailadres kon niet worden opgeslagen.";
    statusElement.className = "row-action-status row-action-error";
    button.disabled = false;
    button.textContent = "E-mail opslaan";
    return;
  }

  statusElement.textContent = "E-mailadres opgeslagen. Druk daarna op Mail opnieuw versturen.";
  statusElement.className = "row-action-status row-action-success";
  button.disabled = false;
  button.textContent = "E-mail opgeslagen";
}

async function deleteOrder(orderId, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Verwijderen...";
  showNotice("Actie wordt uitgevoerd...", "pending");

  const res = await fetch(`/api/admin/orders/${orderId}`, {
    method: "DELETE",
    headers: { "X-Admin-Token": adminToken },
  });
  const data = await res.json();
  if (!res.ok) {
    showNotice(data.error || "Er ging iets mis.", "error");
    button.disabled = false;
    button.textContent = originalText;
    return;
  }
  showNotice("Bestelling volledig verwijderd.");
  loadOrders();
}

tokenForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const tokenError = document.getElementById("token-error");
  const submitBtn = tokenForm.querySelector("button");
  submitBtn.disabled = true;
  tokenError.hidden = true;

  const candidate = tokenForm.token.value;
  if (!await checkToken(candidate)) {
    tokenError.hidden = false;
    submitBtn.disabled = false;
    return;
  }

  adminToken = candidate;
  sessionStorage.setItem("adminToken", adminToken);
  tokenForm.hidden = true;
  app.hidden = false;
  submitBtn.disabled = false;
  loadOrders();
});

async function restoreSession() {
  if (!adminToken || !await checkToken(adminToken)) {
    sessionStorage.removeItem("adminToken");
    adminToken = "";
    return;
  }

  tokenForm.hidden = true;
  app.hidden = false;
  loadOrders();
}

refreshBtn?.addEventListener("click", loadOrders);

restoreSession();
