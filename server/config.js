import { z } from "zod";

const boolean = z.enum(["true", "false"]).transform(value => value === "true");
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  BASE_URL: z.url().default("http://localhost:3000"),
  DB_DRIVER: z.enum(["pg", "pglite"]).default("pg"),
  DATABASE_URL: z.string().optional(),
  DATABASE_SSL: boolean.default(false),
  PGLITE_PATH: z.string().default(".local/development"),
  PAYMENT_MODE: z.enum(["test", "live"]).default("test"),
  PAYMENT_PROVIDER: z.enum(["disabled", "mock", "mollie"]).default("mollie"),
  LIVE_SALES_ENABLED: boolean.default(false),
  MAIL_PROVIDER: z.enum(["preview", "resend"]).default("preview"),
  MOLLIE_API_KEY: z.string().default(""),
  RESEND_API_KEY: z.string().default(""),
  EMAIL_FROM: z.string().default("")
});

export function loadConfig(env = process.env) {
  const c = schema.parse(env);
  const base = new URL(c.BASE_URL);
  if (base.pathname !== "/" || base.search || base.hash || base.username || base.password) {
    throw new Error("BASE_URL moet alleen een origin bevatten (zonder pad, query of inloggegevens).");
  }
  c.BASE_URL = base.origin;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(local && c.NODE_ENV !== "production" && base.protocol === "http:")) {
    throw new Error("BASE_URL moet HTTPS gebruiken, behalve lokaal tijdens ontwikkeling.");
  }
  if (c.DB_DRIVER === "pg" && !c.DATABASE_URL) throw new Error("DATABASE_URL ontbreekt.");
  if (c.NODE_ENV === "production" && c.DB_DRIVER !== "pg") throw new Error("Productie vereist PostgreSQL (DB_DRIVER=pg).");
  if (c.PAYMENT_PROVIDER === "mock" && (!local || c.NODE_ENV === "production" || c.PAYMENT_MODE !== "test")) {
    throw new Error("Mockbetalingen zijn uitsluitend voor lokale testontwikkeling.");
  }
  if (c.PAYMENT_PROVIDER === "mollie" && !c.MOLLIE_API_KEY.startsWith(`${c.PAYMENT_MODE}_`)) {
    throw new Error("MOLLIE_API_KEY ontbreekt of past niet bij PAYMENT_MODE.");
  }
  if (c.PAYMENT_PROVIDER === "mollie" && base.protocol !== "https:") {
    throw new Error("Mollie vereist een publiek bereikbare HTTPS BASE_URL voor betaalmeldingen.");
  }
  if (c.LIVE_SALES_ENABLED && (c.PAYMENT_MODE !== "live" || c.PAYMENT_PROVIDER !== "mollie" || c.MAIL_PROVIDER !== "resend")) {
    throw new Error("Live verkoop vereist Mollie live en Resend.");
  }
  if (c.PAYMENT_MODE === "live" && !c.LIVE_SALES_ENABLED) throw new Error("Live betalingen vereisen expliciet LIVE_SALES_ENABLED=true.");
  if (c.MAIL_PROVIDER === "resend" && (!c.RESEND_API_KEY || !c.EMAIL_FROM || /@gmail\.com\b/i.test(c.EMAIL_FROM))) {
    throw new Error("Resend vereist RESEND_API_KEY en EMAIL_FROM op een geverifieerd eigen domein.");
  }
  return c;
}
