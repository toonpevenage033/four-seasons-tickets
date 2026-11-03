import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import QRCode from "qrcode";
import { hash, login, passwordHash, session, uuid } from "./auth.js";
import { createService, HttpError } from "./service.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const credentials = z.object({
  username: z.string().trim().min(3).max(80),
  password: z.string().min(1).max(256)
}).strict();
const checkoutInput = z.object({
  eventId: z.uuid(), requestId: z.uuid(), name: z.string().trim().min(2).max(120),
  email: z.email().max(254).transform(s => s.toLowerCase()), quantity: z.number().int().min(1).max(10)
}).strict();
const eventInput = z.object({
  title: z.string().trim().min(3).max(120), startsAt: z.iso.datetime({ offset: true }),
  location: z.string().trim().min(3).max(240), priceCents: z.number().int().min(100).max(100000),
  capacity: z.number().int().min(1).max(100000)
}).strict();
const scanInput = z.object({ eventId: z.uuid(), code: z.string().min(1).max(512), requestId: z.uuid() }).strict();
const parse = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, "INVALID_INPUT", "Controleer de ingevoerde gegevens.");
  return result.data;
};
const rawCookie = req => {
  const value = req.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith("koorts_admin="));
  return value?.slice("koorts_admin=".length);
};
const bearer = req => req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];

export function createApp({ db, config, payments, mailer }) {
  const app = express();
  const service = createService(db, config, payments, mailer);
  app.disable("x-powered-by");
  if (config.NODE_ENV === "production") app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      "script-src": ["'self'"], "style-src": ["'self'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"], "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"], "form-action": ["'self'"],
      "upgrade-insecure-requests": config.NODE_ENV === "production" ? [] : null
    } },
    strictTransportSecurity: config.NODE_ENV === "production" ? undefined : false
  }));
  app.use("/api", (_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  app.use(express.urlencoded({ extended: false, limit: "4kb" }));
  app.use((req, _res, next) => {
    if (["POST", "PUT", "DELETE", "PATCH"].includes(req.method) && req.path !== "/api/payments/webhook") {
      if (req.headers.origin && req.headers.origin !== config.BASE_URL) {
        return next(new HttpError(403, "ORIGIN_DENIED", "Dit verzoek is niet toegestaan vanaf deze website."));
      }
      if (req.headers["sec-fetch-site"] === "cross-site") {
        return next(new HttpError(403, "ORIGIN_DENIED", "Cross-site verzoek geweigerd."));
      }
    }
    next();
  });
  const limiter = (limit, windowMs, keyGenerator) => rateLimit({
    windowMs, limit, standardHeaders: "draft-8", legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (_req, res) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Te veel verzoeken. Wacht even en probeer opnieuw." } })
  });
  const loginLimit = limiter(15, 15 * 60 * 1000);
  const purchaseLimit = limiter(20, 15 * 60 * 1000);
  const staffAuth = async (req, _res, next) => {
    req.user = await session(db, bearer(req), "staff");
    if (!req.user) throw new HttpError(401, "UNAUTHORIZED", "Je sessie is verlopen. Log opnieuw in.");
    next();
  };
  const adminAuth = async (req, _res, next) => {
    req.user = await session(db, rawCookie(req), "admin");
    if (!req.user || req.user.role !== "admin") throw new HttpError(401, "UNAUTHORIZED", "Log in als beheerder.");
    next();
  };
  const cookieOptions = { httpOnly: true, secure: config.BASE_URL.startsWith("https:"), sameSite: "strict", path: "/api/admin", maxAge: 12 * 60 * 60 * 1000 };

  app.get("/api/health", async (_req, res) => {
    await db.query("SELECT 1");
    res.json({ status: "ok", paymentMode: config.PAYMENT_MODE, paymentProvider: config.PAYMENT_PROVIDER, liveSalesEnabled: config.LIVE_SALES_ENABLED });
  });
  app.get("/api/events", async (_req, res) => res.json({ events: await service.events() }));
  app.post("/api/orders", purchaseLimit, async (req, res) => {
    res.status(201).json(await service.checkout(parse(checkoutInput, req.body)));
  });
  app.get("/api/order", async (req, res) => {
    const access = parse(z.string().regex(/^[A-Za-z0-9_-]{43}$/), req.headers["x-order-token"]);
    const order = await service.orderStatus(access);
    order.tickets = await Promise.all(order.tickets.map(async ticket => ({
      ...ticket, qrDataUrl: await QRCode.toDataURL(ticket.code, { margin: 4, width: 300, errorCorrectionLevel: "M" })
    })));
    res.json(order);
  });
  app.post("/api/payments/webhook", limiter(300, 60000), async (req, res) => {
    const id = parse(z.string().regex(/^(tr_|mock_)[A-Za-z0-9_-]{1,100}$/), req.body.id);
    await service.reconcile(id);
    res.sendStatus(200);
  });

  app.post("/api/admin/login", loginLimit, async (req, res) => {
    const input = parse(credentials, req.body);
    const result = await login(db, input.username, input.password, "admin");
    if (!result) throw new HttpError(401, "LOGIN_FAILED", "Gebruikersnaam of wachtwoord onjuist.");
    res.cookie("koorts_admin", result.token, cookieOptions).json({ user: result.user, expiresAt: result.expiresAt });
  });
  app.use("/api/admin", adminAuth);
  app.get("/api/admin/session", (req, res) => res.json({ user: req.user, paymentMode: config.PAYMENT_MODE, paymentProvider: config.PAYMENT_PROVIDER, mailProvider: config.MAIL_PROVIDER }));
  app.post("/api/admin/logout", async (req, res) => {
    await db.query("DELETE FROM sessions WHERE token_hash=$1", [hash(rawCookie(req))]);
    res.clearCookie("koorts_admin", { ...cookieOptions, maxAge: undefined }).sendStatus(204);
  });
  app.get("/api/admin/events", async (_req, res) => res.json({ events: await service.events(true) }));
  app.get("/api/admin/users", async (_req, res) => {
    const { rows } = await db.query("SELECT id,username,role,active FROM users ORDER BY username");
    res.json({ users: rows });
  });
  app.post("/api/admin/users", async (req, res) => {
    const input = parse(z.object({
      username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,80}$/),
      password: z.string().min(14).max(256)
    }).strict(), req.body);
    const result = await db.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,'staff') ON CONFLICT(username) DO NOTHING RETURNING id",
      [uuid(), input.username, await passwordHash(input.password)]
    );
    if (!result.rows.length) throw new HttpError(409, "USERNAME_TAKEN", "Deze gebruikersnaam bestaat al.");
    res.status(201).json({ id: result.rows[0].id });
  });
  app.patch("/api/admin/users/:id", async (req, res) => {
    const id = parse(z.uuid(), req.params.id);
    const input = parse(z.object({ active: z.boolean() }).strict(), req.body);
    const result = await db.transaction(async tx => {
      const changed = await tx.query("UPDATE users SET active=$2 WHERE id=$1 AND role='staff' RETURNING id", [id, input.active]);
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      return changed;
    });
    if (!result.rows.length) throw new HttpError(404, "STAFF_NOT_FOUND", "Personeelsaccount niet gevonden.");
    res.sendStatus(204);
  });
  app.post("/api/admin/events", async (req, res) => {
    const input = parse(eventInput, req.body);
    if (new Date(input.startsAt) <= new Date()) throw new HttpError(400, "INVALID_DATE", "Kies een datum in de toekomst.");
    const id = uuid();
    await db.query(
      "INSERT INTO events(id,title,starts_at,location,price_cents,capacity,is_test) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [id, input.title, input.startsAt, input.location, input.priceCents, input.capacity, config.PAYMENT_MODE === "test"]
    );
    res.status(201).json({ id });
  });
  app.patch("/api/admin/events/:id", async (req, res) => {
    const id = parse(z.uuid(), req.params.id);
    const input = parse(z.object({ published: z.boolean().optional(), scanningEnabled: z.boolean().optional() }).strict().refine(v => Object.keys(v).length > 0), req.body);
    const { rows: [event] } = await db.query("SELECT * FROM events WHERE id=$1", [id]);
    if (!event) throw new HttpError(404, "EVENT_NOT_FOUND", "Evenement niet gevonden.");
    if (input.published && (event.is_test || !config.LIVE_SALES_ENABLED)) throw new HttpError(403, "TEST_PRIVATE", "Testevenementen kunnen niet publiek verkocht worden.");
    await db.query(
      "UPDATE events SET published=coalesce($2,published),scanning_enabled=coalesce($3,scanning_enabled) WHERE id=$1",
      [id, input.published ?? null, input.scanningEnabled ?? null]
    );
    res.sendStatus(204);
  });
  app.post("/api/admin/test-orders", purchaseLimit, async (req, res) => {
    const input = parse(checkoutInput, req.body);
    const { rows: [event] } = await db.query("SELECT is_test FROM events WHERE id=$1", [input.eventId]);
    if (!event?.is_test) throw new HttpError(403, "NOT_TEST_EVENT", "Deze route is uitsluitend voor testevenementen.");
    res.status(201).json(await service.checkout(input, true));
  });
  app.get("/api/admin/orders", async (_req, res) => {
    const { rows } = await db.query(
      `SELECT o.id,o.buyer_name AS name,o.quantity,o.status,o.is_test AS "isTest",e.title,
       m.status AS "mailStatus",m.last_error AS "mailError",o.created_at AS "createdAt"
       FROM orders o JOIN events e ON e.id=o.event_id LEFT JOIN mail_jobs m ON m.order_id=o.id
       ORDER BY o.created_at DESC LIMIT 100`
    );
    res.json({ orders: rows });
  });
  app.post("/api/admin/orders/:id/retry-mail", async (req, res) => {
    const id = parse(z.uuid(), req.params.id);
    const result = await db.query(
      `UPDATE mail_jobs SET status='pending',next_attempt_at=now() WHERE order_id=$1
       AND EXISTS(SELECT 1 FROM orders WHERE id=$1 AND status='paid') RETURNING order_id`, [id]
    );
    if (!result.rows.length) throw new HttpError(409, "MAIL_NOT_AVAILABLE", "Voor deze bestelling kan geen ticketmail worden ingepland.");
    res.sendStatus(204);
  });

  app.post("/api/staff/login", loginLimit, async (req, res) => {
    const input = parse(credentials, req.body);
    const result = await login(db, input.username, input.password, "staff");
    if (!result) throw new HttpError(401, "LOGIN_FAILED", "Gebruikersnaam of wachtwoord onjuist.");
    res.json(result);
  });
  app.use("/api/staff", staffAuth);
  app.get("/api/staff/events", async (_req, res) => res.json({ events: (await service.events(true)).filter(e => e.scanningEnabled) }));
  app.post("/api/staff/scan", limiter(300, 60000, req => req.user.id), async (req, res) => {
    res.json(await service.scan(req.user, parse(scanInput, req.body)));
  });
  app.post("/api/staff/logout", async (req, res) => {
    await db.query("DELETE FROM sessions WHERE token_hash=$1", [hash(bearer(req))]);
    res.sendStatus(204);
  });

  if (config.PAYMENT_PROVIDER === "mock") {
    app.get("/api/dev/payments/:id", async (req, res) => {
      const { rows: [order] } = await db.query("SELECT access_token FROM orders WHERE payment_id=$1", [req.params.id]);
      if (!order) throw new HttpError(404, "PAYMENT_NOT_FOUND", "Testbetaling niet gevonden.");
      res.json({ orderToken: order.access_token, payment: await payments.get(req.params.id) });
    });
    app.post("/api/dev/payments/:id", async (req, res) => {
      const status = parse(z.enum(["paid", "canceled", "failed"]), req.body.status);
      const { rows: [payment] } = await db.query(
        "UPDATE mock_payments SET status=$2 WHERE id=$1 AND status='open' AND expires_at>now() RETURNING *", [req.params.id, status]
      );
      if (!payment) throw new HttpError(409, "PAYMENT_CLOSED", "Deze testbetaling is niet meer open.");
      await service.reconcile(payment.id);
      await service.processMail();
      res.sendStatus(204);
    });
  }
  for (const dir of ["css", "js", "images"]) {
    app.use(`/${dir}`, express.static(`${root}/${dir}`, { dotfiles: "deny", index: false }));
  }
  const pages = ["index", "evenementen", "fotos", "over-ons", "contact", "tickets", "bestelling", "beheer"];
  if (config.PAYMENT_PROVIDER === "mock") pages.push("dev-payment");
  app.get("/", (_req, res) => res.sendFile(`${root}/index.html`));
  for (const name of pages) app.get(`/${name}.html`, (_req, res) => res.sendFile(`${root}/${name}.html`));
  app.use((_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "Pagina niet gevonden.")));
  app.use((err, _req, res, _next) => {
    const status = err instanceof HttpError ? err.status : err.type === "entity.parse.failed" ? 400 : err.status === 413 ? 413 : 500;
    if (status >= 500) console.error("Serverfout:", err.message);
    res.status(status).json({ error: {
      code: err instanceof HttpError ? err.code : status === 400 ? "INVALID_JSON" : "SERVER_ERROR",
      message: err instanceof HttpError ? err.message : status === 400 ? "Ongeldige JSON." : "Verzoek mislukt. Probeer opnieuw of neem contact op."
    } });
  });
  return { app, service };
}
