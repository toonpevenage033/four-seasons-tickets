const tokenForm = document.getElementById("token-form");
const app = document.getElementById("app");
const ordersBody = document.getElementById("orders-body");
const refreshBtn = document.getElementById("refresh-btn");

let adminToken = sessionStorage.getItem("adminToken") || "";

function formatCents(cents) {
  return (cents / 100).toFixed(2).replace(".", ",");
}

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
  renderOrders(data.orders);
}

function renderOrders(orders) {
  ordersBody.innerHTML = "";
  for (const order of orders) {
    const tr = document.createElement("tr");
    const date = new Date(order.createdAt).toLocaleString("nl-NL");

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
    if (order.status === "awaiting_payment") {
      const approveBtn = document.createElement("button");
      approveBtn.textContent = "Bevestig betaling";
      approveBtn.className = "approve-btn";
      approveBtn.onclick = () => updateOrder(order.id, "approve");

      const rejectBtn = document.createElement("button");
      rejectBtn.textContent = "Afwijzen";
      rejectBtn.className = "reject-btn";
      rejectBtn.onclick = () => updateOrder(order.id, "reject");

      actionCell.append(approveBtn, rejectBtn);
    }

    ordersBody.appendChild(tr);
  }
}

async function updateOrder(orderId, action) {
  const res = await fetch(`/api/admin/orders/${orderId}/${action}`, {
    method: "POST",
    headers: { "X-Admin-Token": adminToken },
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Er ging iets mis.");
    return;
  }
  if (data.emailError) {
    alert(data.emailError);
  }
  loadOrders();
}

tokenForm.addEventListener("submit", (e) => {
  e.preventDefault();
  adminToken = tokenForm.token.value;
  sessionStorage.setItem("adminToken", adminToken);
  tokenForm.hidden = true;
  app.hidden = false;
  loadOrders();
});

refreshBtn?.addEventListener("click", loadOrders);

if (adminToken) {
  tokenForm.hidden = true;
  app.hidden = false;
  loadOrders();
}
