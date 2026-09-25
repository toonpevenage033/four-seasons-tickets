const tokenForm = document.getElementById("token-form");
const app = document.getElementById("app");
const ordersBody = document.getElementById("orders-body");
const refreshBtn = document.getElementById("refresh-btn");
const adminNotice = document.getElementById("admin-notice");
const statsBox = document.getElementById("stats-box");
const searchInput = document.getElementById("search-input");

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

function renderStats(stats) {
  if (!stats) return;
  statsBox.innerHTML = `
    <div class="stat"><span>${stats.totalSold}</span><small>totaal verkocht (van ${stats.maxTickets})</small></div>
    <div class="stat"><span>${stats.totalRemaining}</span><small>totaal nog beschikbaar</small></div>
    <div class="stat"><span>${stats.earlybirdSold}</span><small>Early Bird verkocht (van ${stats.earlybirdCap})</small></div>
    <div class="stat"><span>${stats.earlybirdRemaining}</span><small>Early Bird nog over</small></div>
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
