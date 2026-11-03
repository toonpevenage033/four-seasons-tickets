# KOORTS-EVENTS — Website

De officiële website van KOORTS-EVENTS: een statische website (alleen HTML, CSS en
JavaScript — geen server of database nodig) met info over het bedrijf, aankomende
evenementen, een fotogalerij van vorige feesten en contactgegevens.

## Pagina's

| Pagina | Bestand | Inhoud |
|---|---|---|
| Home | `index.html` | Groot logo, intro en highlights |
| Evenementen | `evenementen.html` | Aankomende feesten ("tickets binnenkort") |
| Foto's | `fotos.html` | Galerij van vorige feesten, met lightbox |
| Over ons | `over-ons.html` | Bedrijfsverhaal + officiële bedrijfsgegevens (KVK) |
| Contact | `contact.html` | E-mail en socials |

## Lokaal bekijken

Open gewoon `index.html` in je browser, of start een mini-server:

```bash
python3 -m http.server 8000
```

en ga naar `http://localhost:8000`.

## Foto's toevoegen

1. Zet je foto's in de map `images/galerij/`.
2. Open `fotos.html` en voeg de bestandsnamen toe aan de `window.GALERIJ`-lijst onderaan:

```js
window.GALERIJ = [
  { file: "halloween-2026-01.jpg", caption: "Four Seasons Halloween 2026" },
  "halloween-2026-02.jpg", // zonder bijschrift kan ook
];
```

Tip: verklein grote foto's tot max. ±1920px breed zodat de pagina snel laadt.

## KVK-gegevens invullen

Zodra de registratie rond is: open `over-ons.html` en vervang in het blok
"Officiële bedrijfsgegevens" de placeholders (KVK-nummer, BTW-nummer,
vestigingsadres) door de echte gegevens.

## Eigen logo gebruiken

Op de homepage staat nu een typografisch logo. Heb je een logo-afbeelding?
Zet die als `images/logo.png` in de repo en vervang in `index.html` de
`<h1 class="hero-logo">…</h1>` door:

```html
<img class="hero-logo-img" src="images/logo.png" alt="KOORTS-EVENTS">
```

## Nieuw evenement toevoegen

Open `evenementen.html`, kopieer het bovenste `<article class="event-card">`-blok
en pas datum, titel en omschrijving aan. Zodra er een ticketlink is, vervang je de
"Tickets binnenkort"-badge door een knop:

```html
<a href="https://link-naar-ticketshop" class="btn btn-primary">Koop tickets</a>
```

## Hosting (gratis)

Omdat de site volledig statisch is kan hij gratis gehost worden:

- **GitHub Pages**: repo → Settings → Pages → Source: "Deploy from a branch" → branch `main`, map `/ (root)`.
- **Render.com**: nieuw "Static Site" aanmaken, deze repo koppelen, publish directory `.` (geen build command nodig).
