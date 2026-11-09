const statusEl = document.querySelector("#admin-status");
const loginForm = document.querySelector("#admin-login");
const dashboard = document.querySelector("#admin-dashboard");
const node = (tag, value) => {
  const el = document.createElement(tag);
  el.textContent = value;
  return el;
};
function loggedOut() {
  loginForm.hidden = false;
  dashboard.hidden = true;
  document.querySelector("#admin-orders").replaceChildren();
  document.querySelector("#staff-users").replaceChildren();
}
async function api(path, options = {}) {
  const response = await fetch(`/api/admin${path}`, {
    ...options, headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000)
  });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) loggedOut();
    throw new Error(data.error?.message || "Verzoek mislukt.");
  }
  return data;
}
const report = error => { statusEl.textContent = error.message; statusEl.className = "notice error"; };
function action(label, fn) {
  const button = node("button", label);
  button.className = "btn btn-outline";
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await fn(); await refresh(); } catch (error) { report(error); } finally { button.disabled = false; }
  });
  return button;
}
async function refresh() {
  const session = await api("/session");
  loginForm.hidden = true;
  dashboard.hidden = false;
  statusEl.className = "notice";
  statusEl.textContent = `${session.paymentProvider === "disabled" ? "BETALINGEN NIET AANGESLOTEN: inloggen en scannen beschikbaar" : session.paymentMode === "test" ? "TESTMODUS: geen echte betalingen" : "LIVE BETALINGEN"} · Mail: ${session.mailProvider === "preview" ? "preview, er wordt niets verstuurd" : "Resend"}`;
  const [{ events }, { orders }, { users }] = await Promise.all([api("/events"), api("/orders"), api("/users")]);
  document.querySelector("#admin-events").replaceChildren(...events.map(event => {
    const card = document.createElement("article");
    card.className = "event-card";
    card.append(node("h3", `${event.isTest ? "TEST: " : ""}${event.title}`), node("p", `${new Date(event.startsAt).toLocaleString("nl-NL")} · ${event.location}`), node("p", `${event.capacity} plaatsen · ${event.published ? "Gepubliceerd" : "Privé/concept"}`));
    card.append(action(event.scanningEnabled ? "Scannen uitschakelen" : "Scannen inschakelen", () => api(`/events/${event.id}`, { method: "PATCH", body: JSON.stringify({ scanningEnabled: !event.scanningEnabled }) })));
    if (!event.isTest) card.append(action(event.published ? "Verkoop sluiten" : "Verkoop publiceren", () => api(`/events/${event.id}`, { method: "PATCH", body: JSON.stringify({ published: !event.published }) })));
    return card;
  }));
  const select = document.querySelector("#test-event");
  const selected = select.value;
  select.replaceChildren(...events.filter(e => e.isTest).map(e => {
    const option = node("option", e.title);
    option.value = e.id;
    return option;
  }));
  if ([...select.options].some(o => o.value === selected)) select.value = selected;
  document.querySelector("#test-order-form button").disabled = !select.options.length || session.paymentProvider === "disabled";
  const manualSelect = document.querySelector("#manual-test-event");
  const manualSelected = manualSelect.value;
  manualSelect.replaceChildren(...[...select.options].map(option => option.cloneNode(true)));
  if ([...manualSelect.options].some(o => o.value === manualSelected)) manualSelect.value = manualSelected;
  document.querySelector("#manual-test-panel").hidden = session.paymentMode !== "test";
  document.querySelector("#manual-test-form button").disabled = !manualSelect.options.length;
  document.querySelector("#admin-orders").replaceChildren(...orders.map(order => {
    const row = document.createElement("tr");
    for (const value of [`${order.isTest ? "TEST: " : ""}${order.title}`, order.name, order.quantity, order.manualTest ? "TEST: zonder betaling" : order.status, order.manualTest ? "Geen mail (scannertest)" : order.mailStatus || "Nog niet ingepland"]) row.append(node("td", value));
    const cell = document.createElement("td");
    if (order.status === "paid" && !order.manualTest) cell.append(action("Mail opnieuw inplannen", () => api(`/orders/${order.id}/retry-mail`, { method: "POST" })));
    if (order.mailError) cell.append(node("p", order.mailError));
    row.append(cell);
    return row;
  }));
  document.querySelector("#staff-users").replaceChildren(...users.filter(u => u.role === "staff").map(user => {
    const card = document.createElement("p");
    card.append(node("span", `${user.username}: ${user.active ? "Actief" : "Geblokkeerd"} `),
      action(user.active ? "Blokkeren" : "Activeren", () => api(`/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ active: !user.active }) })));
    return card;
  }));
}
function handleForm(id, fn) {
  const form = document.querySelector(id);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const button = form.querySelector("button");
    button.disabled = true;
    try { await fn(form); } catch (error) { report(error); } finally { button.disabled = false; }
  });
}
handleForm("#admin-login", async form => {
  await api("/login", { method: "POST", body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value }) });
  form.reset();
  await refresh();
});
handleForm("#event-form", async form => {
  await api("/events", { method: "POST", body: JSON.stringify({
    title: form.elements.title.value, startsAt: new Date(form.elements.startsAt.value).toISOString(),
    location: form.elements.location.value, priceCents: Math.round(Number(form.elements.price.value) * 100), capacity: Number(form.elements.capacity.value)
  }) });
  form.reset();
  await refresh();
});
let manualRequest;
handleForm("#manual-test-form", async form => {
  const values = { eventId: form.elements.eventId.value, quantity: Number(form.elements.quantity.value) };
  const fingerprint = JSON.stringify(values);
  if (!manualRequest) {
    const saved = sessionStorage.getItem("koorts-manual-test");
    if (saved) manualRequest = JSON.parse(saved);
  }
  if (manualRequest?.fingerprint !== fingerprint) {
    manualRequest = { fingerprint, requestId: crypto.randomUUID() };
    sessionStorage.setItem("koorts-manual-test", JSON.stringify(manualRequest));
  }
  const result = await api("/test-tickets", {
    method: "POST", body: JSON.stringify({ ...values, requestId: manualRequest.requestId })
  });
  sessionStorage.removeItem("koorts-manual-test");
  location.assign(result.orderUrl);
});
let pendingTestOrder;
handleForm("#test-order-form", async form => {
  const values = {
    eventId: form.elements.eventId.value, name: form.elements.name.value,
    email: form.elements.email.value, quantity: Number(form.elements.quantity.value)
  };
  const fingerprint = JSON.stringify(values);
  if (!pendingTestOrder) {
    try { pendingTestOrder = JSON.parse(sessionStorage.getItem("koorts-test-checkout")); }
    catch (error) { console.warn("Testbetaalpoging kon niet worden gelezen:", error.message); }
  }
  if (pendingTestOrder?.fingerprint !== fingerprint) {
    pendingTestOrder = { fingerprint, requestId: crypto.randomUUID() };
    try { sessionStorage.setItem("koorts-test-checkout", JSON.stringify(pendingTestOrder)); }
    catch (error) { console.warn("Testbetaalpoging kon niet worden bewaard:", error.message); }
  }
  const result = await api("/test-orders", { method: "POST", body: JSON.stringify({ ...values, requestId: pendingTestOrder.requestId }) });
  try { sessionStorage.removeItem("koorts-test-checkout"); }
  catch (error) { console.warn("Testbetaalpoging kon niet worden opgeruimd:", error.message); }
  location.assign(result.checkoutUrl);
});
handleForm("#staff-form", async form => {
  await api("/users", { method: "POST", body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value }) });
  form.reset();
  await refresh();
});
document.querySelector("#admin-refresh").addEventListener("click", () => refresh().catch(report));
document.querySelector("#admin-logout").addEventListener("click", async () => {
  try {
    await api("/logout", { method: "POST" });
    loggedOut();
    statusEl.textContent = "Uitgelogd.";
  } catch (error) { report(error); }
});
refresh().catch(report);
