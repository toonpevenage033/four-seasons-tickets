// Prijsfases en ticketlimiet voor het feest bij Four Seasons, Kastanjelaan 1, Leusden.
const MAX_TICKETS = 450;
const MAX_QTY_PER_ORDER = 6;
// Order blijft "actief" (telt mee voor de limiet) totdat de handmatige betaaltermijn verloopt.
const PENDING_ORDER_TTL_HOURS = 48;

const EVENT = {
  name: "Four Seasons Feest",
  address: "Four Seasons, Kastanjelaan 1, Leusden",
  start: "2026-10-31T21:00:00",
  end: "2026-11-01T02:00:00",
};

// Fases lopen na elkaar; "end" van een fase is exclusief (volgende fase begint dan).
// TIJDELIJK VOOR TESTEN: earlybird-start naar het verleden gezet, hierna weer terugzetten!
const TIERS = [
  {
    id: "earlybird",
    label: "Early Bird",
    priceCents: 1050,
    start: "2020-01-01T00:00:00",
    end: "2026-10-01T00:00:00",
  },
  {
    id: "regular",
    label: "Regular",
    priceCents: 1450,
    start: "2026-10-01T00:00:00",
    end: "2026-10-24T00:00:00",
  },
  {
    id: "latebird",
    label: "Late Bird",
    priceCents: 1750,
    start: "2026-10-24T00:00:00",
    end: "2026-11-01T02:00:00",
  },
];

function getCurrentTier(now = new Date()) {
  for (const tier of TIERS) {
    if (now >= new Date(tier.start) && now < new Date(tier.end)) {
      return tier;
    }
  }
  return null;
}

function getNextTier(now = new Date()) {
  return TIERS.find((tier) => new Date(tier.start) > now) || null;
}

function formatPrice(cents) {
  return (cents / 100).toFixed(2).replace(".", ",");
}

module.exports = {
  MAX_TICKETS,
  MAX_QTY_PER_ORDER,
  PENDING_ORDER_TTL_HOURS,
  EVENT,
  TIERS,
  getCurrentTier,
  getNextTier,
  formatPrice,
};
