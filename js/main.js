// KOORTS-EVENTS — gedeelde scripts

// ---------- Hamburger menu ----------
(function () {
  const hamburger = document.querySelector(".hamburger");
  const menu = document.querySelector(".nav-menu");
  const overlay = document.querySelector(".nav-overlay");
  if (!hamburger || !menu || !overlay) return;

  function toggle(open) {
    const isOpen = open ?? !menu.classList.contains("open");
    menu.classList.toggle("open", isOpen);
    overlay.classList.toggle("open", isOpen);
    hamburger.classList.toggle("open", isOpen);
    hamburger.setAttribute("aria-expanded", String(isOpen));
  }

  hamburger.addEventListener("click", () => toggle());
  overlay.addEventListener("click", () => toggle(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") toggle(false);
  });
})();

// ---------- Actieve pagina markeren in het menu ----------
(function () {
  const current = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".nav-menu a").forEach((a) => {
    if (a.getAttribute("href") === current) a.classList.add("active");
  });
})();

// ---------- Fotogalerij (alleen op fotos.html) ----------
// Voeg je foto's toe aan images/galerij/ en zet de bestandsnamen
// in de GALERIJ-lijst in fotos.html.
(function () {
  const grid = document.querySelector("[data-gallery]");
  if (!grid) return;

  const fotos = window.GALERIJ || [];

  if (fotos.length === 0) {
    const empty = document.createElement("div");
    empty.className = "gallery-empty";
    empty.innerHTML =
      "<p><strong>Foto's volgen snel!</strong></p>" +
      "<p>We zijn de mooiste momenten van onze vorige feesten aan het verzamelen.</p>";
    grid.replaceWith(empty);
    return;
  }

  // Lightbox
  const lightbox = document.createElement("div");
  lightbox.className = "lightbox";
  const lightboxImg = document.createElement("img");
  lightbox.appendChild(lightboxImg);
  document.body.appendChild(lightbox);
  lightbox.addEventListener("click", () => lightbox.classList.remove("open"));

  fotos.forEach((foto) => {
    const file = typeof foto === "string" ? foto : foto.file;
    const caption = typeof foto === "string" ? "" : foto.caption || "";
    const fig = document.createElement("figure");
    const img = document.createElement("img");
    img.src = "images/galerij/" + file;
    img.alt = caption || "Foto van een KOORTS-EVENTS feest";
    img.loading = "lazy";
    fig.appendChild(img);
    if (caption) {
      const cap = document.createElement("figcaption");
      cap.textContent = caption;
      fig.appendChild(cap);
    }
    fig.addEventListener("click", () => {
      lightboxImg.src = img.src;
      lightboxImg.alt = img.alt;
      lightbox.classList.add("open");
    });
    grid.appendChild(fig);
  });
})();

// ---------- Feestaanvraag (alleen op feest-aanvragen.html) ----------
// Bouwt een gestructureerde e-mail en opent het mailprogramma van de bezoeker.
(function () {
  const form = document.querySelector("#party-form");
  if (!form) return;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = (name) => (form.elements[name].value || "").trim();
    const soort = v("soort");
    const regels = [
      "Hoi KOORTS-EVENTS,",
      "",
      "Ik wil graag een feest aanvragen. Dit zijn de gegevens:",
      "",
      "— Naam: " + v("naam"),
      "— E-mail: " + v("email"),
      v("telefoon") ? "— Telefoon: " + v("telefoon") : null,
      "— Soort feest: " + soort,
      v("datum") ? "— Gewenste datum: " + v("datum") : "— Gewenste datum: nog open",
      v("gasten") ? "— Aantal gasten: ±" + v("gasten") : null,
      "— Locatie: " + v("locatie"),
      v("budget") ? "— Indicatie budget: " + v("budget") : null,
      "",
      "Over het feest:",
      v("wensen"),
      "",
      "Groetjes,",
      v("naam"),
    ].filter((r) => r !== null);
    const mailto = "mailto:koortsevents@gmail.com" +
      "?subject=" + encodeURIComponent("Feestaanvraag — " + soort) +
      "&body=" + encodeURIComponent(regels.join("\n"));
    location.href = mailto;
  });
})();
