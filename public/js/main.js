const statusBox = document.getElementById("status");
const form = document.getElementById("order-form");
const formError = document.getElementById("form-error");
const paymentInstructions = document.getElementById("payment-instructions");

async function loadStatus() {
  const res = await fetch("/api/status");
  const data = await res.json();

  if (!data.onSale) {
    statusBox.textContent = data.soldOut ? "Uitverkocht 😢" : data.message;
    form.hidden = true;
    return;
  }

  statusBox.innerHTML = `
    <div>${data.tier.label} tarief</div>
    <div class="price">€ ${data.tier.priceFormatted}</div>
    <div>${data.remaining} tickets nog beschikbaar</div>
  `;
  form.hidden = false;
  form.querySelector('input[name="quantity"]').max = data.maxQtyPerOrder;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.hidden = true;

  const submitBtn = form.querySelector("button");
  submitBtn.disabled = true;

  const payload = {
    name: form.name.value,
    email: form.email.value,
    quantity: Number(form.quantity.value),
  };

  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) {
      formError.textContent = data.error || "Er ging iets mis.";
      formError.hidden = false;
      submitBtn.disabled = false;
      return;
    }

    document.getElementById("pi-amount").textContent = `€ ${data.amountFormatted}`;
    document.getElementById("pi-iban").textContent = data.iban;
    document.getElementById("pi-holder").textContent = data.accountHolder;
    document.getElementById("pi-reference").textContent = data.reference;

    form.hidden = true;
    paymentInstructions.hidden = false;
  } catch (err) {
    formError.textContent = "Kon geen verbinding maken met de server.";
    formError.hidden = false;
    submitBtn.disabled = false;
  }
});

loadStatus();
