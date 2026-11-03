import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
export const hash = value => createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export const uuid = () => randomUUID();

export async function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString("hex")}`;
}

export async function resetPassword(db, username, password) {
  const hashed = await passwordHash(password);
  return db.transaction(async tx => {
    const { rows: [user] } = await tx.query(
      "UPDATE users SET password_hash=$2 WHERE username=$1 RETURNING id", [username, hashed]
    );
    if (!user) throw new Error("Account niet gevonden. Controleer de gebruikersnaam.");
    await tx.query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
  });
}

const dummyHash = await passwordHash(token());
export async function login(db, username, password, kind) {
  const { rows: [user] } = await db.query("SELECT * FROM users WHERE username=$1 AND active=true", [username.toLowerCase()]);
  const [salt, expected] = (user?.password_hash || dummyHash).split(":");
  const actual = await scrypt(password, salt, 64);
  const valid = timingSafeEqual(actual, Buffer.from(expected, "hex"));
  if (!valid || !user || (kind === "admin" && user.role !== "admin")) return null;
  const rawToken = token();
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  await db.query("INSERT INTO sessions(token_hash,user_id,kind,expires_at) VALUES($1,$2,$3,$4)", [hash(rawToken), user.id, kind, expiresAt]);
  return { token: rawToken, expiresAt, user: { id: user.id, username: user.username, role: user.role } };
}

export async function session(db, rawToken, kind) {
  if (!rawToken || rawToken.length > 200) return null;
  const { rows: [user] } = await db.query(
    `SELECT u.id,u.username,u.role FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.kind=$2 AND s.expires_at>now() AND u.active=true`,
    [hash(rawToken), kind]
  );
  return user || null;
}
