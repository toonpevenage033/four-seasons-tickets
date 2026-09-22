# Four Seasons Feest — Ticketverkoop

Simpele ticketwebsite zonder betaal-API of KVK nodig: kopers reserveren tickets, maken
het bedrag zelf over via een bankoverschrijving met unieke referentie, en jij bevestigt
de betaling handmatig in een beveiligde beheerpagina. Zodra je bevestigt, ontvangt de
koper automatisch een e-mail (via Resend) met een unieke QR-code per ticket. Bij de
ingang scan je de QR-code met de scanner-pagina om te controleren of een ticket geldig
en nog niet gebruikt is.

- Max. **450 tickets** in totaal (hard limiet, ook onder gelijktijdige bestellingen).
- Automatische prijsfases:
  - **Early Bird** — €10,50 — vanaf 24 sept 2026 15:00 t/m 30 sept 2026
  - **Regular** — €14,50 — vanaf 1 okt 2026 t/m 23 okt 2026
  - **Late Bird** — €17,50 — vanaf 24 okt 2026 t/m avond van het feest (of uitverkocht)
- Locatie: Four Seasons, Kastanjelaan 1, Leusden. Datum: 31 oktober 2026, 21:00–02:00.

## 1. Installatie

```bash
cd fourseasons-tickets
npm install
cp .env.example .env
```

Vul in `.env` in:
- `RESEND_API_KEY` — API key uit [Resend](https://resend.com), en een geverifieerd `EMAIL_FROM`-domein.
- `PAYMENT_IBAN` en `PAYMENT_ACCOUNT_HOLDER` — het rekeningnummer waar kopers naartoe moeten overmaken.
- `ADMIN_TOKEN` — geheime code voor jou/organisatoren, om op `/admin` betalingen te bevestigen.
- `STAFF_TOKEN` — geheime code voor het deurpersoneel, om op `/scan` tickets te scannen.
- `BASE_URL` — de publieke URL van je site zodra die live staat.

Houd `ADMIN_TOKEN` en `STAFF_TOKEN` gescheiden en geef `ADMIN_TOKEN` alleen aan mensen die
je vertrouwt: wie deze code heeft, kan (gratis) tickets aanmaken.

## 2. Lokaal testen

```bash
npm start
```

Ga naar:
- `http://localhost:3000` — de ticketpagina voor kopers
- `http://localhost:3000/admin` — beheerpagina om betalingen te bevestigen/afwijzen
- `http://localhost:3000/scan` — scanner-pagina voor bij de deur

## 3. Live zetten (gratis/goedkope opties)

Dit is een gewone Node.js/Express app, dus je kunt hem gratis of goedkoop hosten op bijvoorbeeld:
- **Render.com** (gratis web service tier)
- **Railway.app**
- Elke goedkope VPS met Node.js

Zet daar dezelfde environment variables uit `.env`, en zorg voor **persistente opslag** voor
de map `data/` (zie punt 5 hieronder) zodat bestellingen niet verloren gaan bij een herstart.

## 4. Hoe het werkt

1. Bezoeker vult naam, e-mail en aantal tickets in op de hoofdpagina.
2. Server checkt of er nog genoeg tickets over zijn (max. 450) en maakt een reservering aan
   met een unieke referentiecode. De koper krijgt direct op de pagina én per e-mail te zien
   waar en met welke omschrijving hij moet overmaken.
3. Jij checkt je bankrekening en gaat naar `/admin`. Bestellingen met de bijpassende
   referentie en het juiste bedrag klik je op **"Bevestig betaling"**.
4. Zodra je bevestigt, genereert de server per ticket een unieke, niet te raden code + QR-
   afbeelding, en mailt deze naar de koper via Resend.
5. Bij de deur open je `/scan`, voert eenmalig de staff-code in, en scant QR-codes. Elke
   code kan maar **één keer** geldig gescand worden.
6. Reserveringen die na 48 uur nog niet bevestigd zijn tellen niet langer mee voor de
   limiet van 450, zodat "vergeten" bestellingen geen plekken blijven blokkeren. Je kunt
   een bestelling ook zelf **afwijzen** in `/admin` als iemand toch niet betaalt.

## 5. Belangrijk om te weten

- Data (bestellingen + tickets) wordt lokaal opgeslagen in `data/db.json`. Maak hier
  back-ups van als je dit op een server zonder persistente schijf host (bv. sommige
  serverless platforms wissen dit bestand bij elke deploy — kies in dat geval
  Render/Railway/VPS met persistente opslag/disk).
- Zet de omgevingsvariabele `TZ=Europe/Amsterdam` zodat de prijsfases op het juiste
  moment wisselen.
- Controleer bij het bevestigen van een betaling altijd of het **bedrag én de referentie**
  overeenkomen met wat in `/admin` staat, om fouten te voorkomen.
