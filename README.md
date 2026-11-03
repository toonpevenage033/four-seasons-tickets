# KOORTS-EVENTS

Bedrijfswebsite, ticketbackend en besloten native scanapp voor Android en iPhone.
De crème/zwart/rode huisstijl gebruikt de aangeleverde logo's.
De oude ticketdatabase wordt **niet** gebruikt.

## Status en veilige standaard

- De publieke website toont geen testevenementen.
- Testevenementen en testbestellingen zijn alleen via ingelogd beheer beschikbaar.
- Lokaal kun je zonder accounts bij betaal-/mailproviders testen: mockbetalingen,
  een PostgreSQL-compatibele PGlite-database en expliciete mailpreview.
- Mockbetalingen werken uitsluitend lokaal, nooit op een productiehost.
- Echte PostgreSQL, Mollie en Resend zijn aangesloten via configureerbare adapters.
  Een echte Mollie-testbetaling, afgeleverde Resend-mail en fysieke telefoons moeten
  nog met jullie eigen accounts/apparaten worden getest.
- Live verkoop staat standaard uit. Er worden geen diensten besteld of uitgerold
  door `npm install` of `npm start`.

## Lokaal starten

Node.js >=22.12 vereist.

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
```

Maak het eerste beheeraccount door **lokaal** in `.env` tijdelijk in te stellen:

```dotenv
CREATE_USERNAME=jouw-beheernaam
CREATE_PASSWORD=Kies-hier-zelf-een-uniek-lang-wachtwoord
CREATE_ROLE=admin
```

Gebruik het voorbeeldwachtwoord niet. Kies minimaal 14 tekens.

```bash
npm run user:create
```

Verwijder daarna `CREATE_PASSWORD` uit `.env`. Deel geen API-sleutels of
wachtwoorden in chat, commits of screenshots.

Vergeten of verkeerd getypt wachtwoord? Stel dezelfde `CREATE_USERNAME` en een
nieuw `CREATE_PASSWORD` tijdelijk in en voer `npm run user:reset-password` uit.
Dit wijzigt alleen het bestaande accountwachtwoord en trekt zijn sessies in;
de rol en blokkering blijven behouden. Verwijder het wachtwoord daarna weer.

```bash
npm start
```

- Website: <http://localhost:3000>
- Beheer: <http://localhost:3000/beheer.html>
- Healthcheck: <http://localhost:3000/api/health>

De lokale database staat in de genegeerde map `.local/development` en blijft na
herstart bestaan. Dit is uitsluitend nieuwe ontwikkeldata, niet de oude feestdata.
Voor ticketverkoop is openen als los HTML-bestand of een statische Python-server
niet voldoende: de API moet draaien.

### Complete lokale test

1. Log in bij beheer. Het gezaaide testevenement staat op privé.
2. Maak via **Privé-testbestelling** een bestelling.
3. Kies in de lokale simulator betaald, mislukt of geannuleerd.
4. Bij betaald verschijnen exact de bestelde QR-tickets op de persoonlijke link.
5. Mailstatus **preview** betekent dat er niets is gemaild.
6. Maak in beheer een account voor elke beveiliger. Accounts kunnen worden
   geblokkeerd; bestaande sessies worden dan direct ingetrokken.
7. Zonder betaalprovider: kies in beheer **QR-testtickets zonder betaling**,
   selecteer het privé-testevenement en het aantal (1–10). De persoonlijke
   ticketpagina opent direct. Geen naam, e-mail, Mollie-sleutel of Shell nodig.
   Deze route is alleen voor beheerders in testmodus, telt mee voor de capaciteit,
   verstuurt geen mail en kan geen tickets voor live-evenementen uitgeven.
8. Laat de native scanner de tickets lezen. Een nieuw scanverzoek voor hetzelfde
   ticket toont al gebruikt. Een netwerkretry met dezelfde requestId herhaalt het
   oorspronkelijke resultaat zonder een tweede check-in.

Gebruik het testevenement uitsluitend voor oefenen, nooit voor echte toegang.
Een nieuwe serverstart maakt niet automatisch accounts of evenementen aan.

## PostgreSQL

Op Render of een andere host is een aparte, persistente PostgreSQL-database nodig:

```dotenv
DB_DRIVER=pg
DATABASE_URL=postgresql://...
DATABASE_SSL=false
```

Gebruik de interne verbinding als backend en database in dezelfde Render-regio
staan. Als je databaseprovider TLS vereist, stel `DATABASE_SSL=true` in; certificaten
worden gecontroleerd. Zet certificaatcontrole niet uit als workaround.

Migraties draaien bij opstarten transactioneel en gebruiken op PostgreSQL een
advisory lock tegen gelijktijdige schema-aanmaak.
De backend serveert alleen expliciet toegestane websitebestanden, niet de repo,
database, `.env`, tests of appbroncode.

## Mollie-testomgeving aansluiten

Zonder Mollie-account kun je eerst `PAYMENT_PROVIDER=disabled`,
`PAYMENT_MODE=test`, `LIVE_SALES_ENABLED=false` en `MAIL_PROVIDER=preview`
gebruiken met PostgreSQL en een HTTPS BASE_URL. Inloggen, beheer en scannen
blijven beschikbaar, maar nieuwe bestellingen en betaalmeldingen worden expliciet
geweigerd. Beheerders kunnen via **QR-testtickets zonder betaling** wel privé-
scannertickets uitgeven. Ze worden apart gemarkeerd als `manual_test`, krijgen
geen betaaldatum, betaal-ID of mailjob en worden nooit naar een betaalprovider
gestuurd. Intern gebruiken ze de bestaande scanbare orderstatus `paid`; de
ticketpagina en het beheeroverzicht tonen expliciet **zonder betaling**, niet
**betaling bevestigd**. Een Mollie-sleutel is in deze modus niet nodig.

Zet op een publiek bereikbare HTTPS-testbackend:

```dotenv
NODE_ENV=production
DB_DRIVER=pg
BASE_URL=https://jouw-testbackend.example
PAYMENT_PROVIDER=mollie
PAYMENT_MODE=test
MOLLIE_API_KEY=test_...
LIVE_SALES_ENABLED=false
MAIL_PROVIDER=preview
```

Gebruik jullie **test**-sleutel in de geheime hostinginstellingen. Bestel uitsluitend
via beheer bij een testevenement. De lokale simulator is dan niet beschikbaar.

De backend maakt een Mollie-betaling aan en slaat het betalings-ID op.
Mollie meldt statuswijzigingen aan `POST /api/payments/webhook`; de backend vraagt de
status opnieuw bij Mollie op en controleert betalings-ID, order-ID, bedrag, valuta
en test/live-modus. De terugkeerpagina van de browser is geen betaalbewijs.

Betaalcreatie is idempotent op het order-ID. Herhaal bij een netwerkfout dezelfde
aanvraagcode. Een reservering wordt pas vrijgegeven na een door de provider
bevestigde mislukte, geannuleerde of verlopen betaling, niet op een lokale timer.
Zo veroorzaken vertraagde betalingen geen oververkoop. Mislukte betaalsetup wordt
opnieuw geprobeerd; na 23 uur is handmatige providercontrole nodig voordat opnieuw
wordt aangemaakt, om de idempotentieperiode niet te overschrijden.

Een achtergrondtaak controleert open betalingen en verwerkt mail elke 15 seconden.
Betaalde orders worden periodiek opnieuw gecontroleerd op terugbetalingen en
chargebacks. **Iedere terugbetaling (ook gedeeltelijk) blokkeert momenteel alle
tickets van die bestelling.** Deelrestituties en vervangende tickets zijn nog geen
beheerfunctie; voer geen deelrestituties uit zonder dit proces uit te werken.
Bij een onverwachte late betaling na een definitief gesloten order wordt een fout
gelogd voor handmatige controle, niet alsnog boven capaciteit uitgegeven.

## Resend aansluiten

```dotenv
MAIL_PROVIDER=resend
RESEND_API_KEY=re_...
EMAIL_FROM=KOORTS-EVENTS <tickets@jullie-geverifieerde-domein.nl>
```

Verifieer eerst jullie eigen afzenderdomein bij Resend (DNS-records).
`koortsevents@gmail.com` is het contact- en reply-to-adres, niet het geverifieerde
afzenderdomein. De mail bevat een persoonlijke link naar alle QR-tickets.

Tickets en een mailjob worden in dezelfde database-transactie aangemaakt.
Bij een mailfout blijven de tickets bestaan en wordt opnieuw geprobeerd.
Beheer toont de mailstatus en kan een nieuwe poging inplannen.
Resend krijgt een stabiele idempotency key tegen dubbele verzending bij retries;
binnen Resends idempotentieperiode kan opnieuw inplannen daarom dezelfde
verzendactie opleveren, geen tweede mail. Een preview wordt nooit als verzonden
weergegeven.

## Native scanapp

Zie [scanner-app/README.md](scanner-app/README.md) voor Expo, fysieke telefoons,
Android APK en de iOS-build-/distributieroute.

De app praat via HTTPS met dezelfde backend als de website. Alleen de backend
krijgt database- en providergeheimen. Personeelsaccounts hebben geen beheertoegang.
Staffsessies verlopen na 12 uur; log op de feestdag opnieuw in.

Voor een fysieke telefoon tijdens lokale ontwikkeling:

- Start de backend expliciet met `HOST=0.0.0.0 npm start`.
- Gebruik in de app het LAN-adres van de computer, bijvoorbeeld
  `http://192.168.1.10:3000`, niet `localhost` van de telefoon.
- Alleen een development-build mag lokaal HTTP gebruiken. Productie gebruikt HTTPS.
- Laat de lokale betaalflow in de computerbrowser staan; de mock-checkout gebruikt
  de `BASE_URL` van de backend.
- Sluit deze testserver na gebruik; gebruik geen publieke port-forward voor mock.

De centrale scancontrole vergrendelt ticket/order en check-in atomair. Er kan maar
één eerste toelating zijn. Scanaanvragen zijn idempotent per personeelsaccount en
requestId. Een andere inhoud met dezelfde requestId wordt geweigerd.
Zonder serververbinding geeft de app geen groene toelating. Zorg voor betrouwbare
wifi/4G en een reserveverbinding; meerdere offline scanners garanderen geen
bescherming tegen dubbele toegang.

## Hosting op Render

Er wordt door deze repo niets automatisch bij Render aangemaakt.

1. Maak na budgetakkoord een betaalde Node **Web Service** en een betaalde
   PostgreSQL-database in dezelfde regio aan.
2. Backend build command: `npm ci --omit=dev`. Start command: `npm start`.
3. Zet bovenstaande testconfig en geheimen bij Render Environment. Render levert
   `PORT`; de productiebackend luistert op `0.0.0.0`.
4. Health check path: `/api/health`.
5. Maak het eerste adminaccount eenmalig via de Render-shell met `npm run user:create`.
   Verwijder daarna de tijdelijke CREATE_PASSWORD-instelling.
6. Maak het privé-testevenement met `npm run db:seed` en test de volledige keten.

Deze eenvoudigste opzet serveert de website en API samen vanaf dezelfde backend.
Er is dus geen tweede betaalde websitehost nodig. Als je later de statische
website apart host, zijn een reverse proxy en expliciete originconfiguratie nodig;
cross-origin API-verzoeken zijn nu bewust niet ingeschakeld.

Gebruik geen gratis slapende server of aflopende testdatabase voor live verkoop.
Begin met één backend-instance: de rate-limiters zijn instance-lokaal. Configureer
een gedeelde limiter voordat je meerdere backend-instances gebruikt.
De productieproxyconfiguratie verwacht één vertrouwde reverse proxy (Render);
pas dit aan voordat je een andere proxyketen gebruikt.

### Voor livegang

Nog uitvoeren met de organisator:

- Officiële bedrijfsgegevens en KVK-inschrijving verifiëren en publiceren.
- Privacyverklaring, verkoopvoorwaarden, annulerings-/restitutieproces en
  bewaartermijnen vastleggen. De huidige website is nog geen afgeronde juridische
  checkout. Bewaar niet onbeperkt persoonsgegevens.
- Mollie-account laten goedkeuren en iDEAL activeren.
- Resend-domein verifiëren en echte aflevering testen.
- Fysieke Android- en iPhone-cameratests, meerdere scanners en slechte wifi testen.
- De bekende advisories in Expo-ontwikkeltooling opnieuw beoordelen; actuele
  beperkingen staan in de apphandleiding. Geen incompatibele geforceerde upgrades.
- iOS-distributie, ondertekening en personeelsinstallatie regelen.
- Databaseback-ups, een hersteltest, monitoring, kostenlimieten en mail-/provider-
  foutmeldingen organiseren.
- Een apart live-evenement aanmaken; testevenementen worden nooit omgezet naar live.
- Pas dan bewust `PAYMENT_MODE=live`, een `live_`-sleutel,
  `LIVE_SALES_ENABLED=true` en `MAIL_PROVIDER=resend` instellen.
  Publiceer daarna het nieuwe live-evenement in beheer.

De backend weigert live verkoop met een testsleutel, mockprovider of mailpreview.

## Validatie

```bash
npm test
npm run check
npm run test:postgres
```

`npm test` gebruikt een tijdelijke PGlite-database en providerstubs; geen netwerk
naar Mollie/Resend. `test:postgres` start een tijdelijke echte PostgreSQL-cluster
op loopback, voert dezelfde integratietests uit en stopt/verwijdert uitsluitend
die testcluster. Hiervoor wordt het dev-package `embedded-postgres` gebruikt.
Er is geen systeemwijde PostgreSQL-installatie nodig.

Tests controleren o.a. privé-testverkoop, voorraad bij gelijktijdige bestellingen,
betaalvalidatie, webhook-idempotentie, mailretries, sessies en gelijktijdige scans.
De lokale scan-p95-test meet API-verzoeken, niet cameraleessnelheid of Render.
Browservalidatie omvat een lokale testbetaling tot twee zichtbare QR-tickets.

## Website-inhoud

- Foto's: plaats bestanden in `images/galerij/` en vul `window.GALERIJ` in
  [js/gallery.js](js/gallery.js). Gebruik alleen foto's met geschikte publicatierechten.
- Bedrijfsgegevens: vul [over-ons.html](over-ons.html) pas na bevestiging aan.
- Logo's: [images/Logo.png](images/Logo.png) en
  [images/Pictogram.png](images/Pictogram.png).
- Contact: `koortsevents@gmail.com`. Social-links blijven weg tot accounts bevestigd zijn.
- Evenementen/tickets: beheer via [beheer.html](beheer.html), niet via HTML-kaarten.
