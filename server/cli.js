import { loadConfig } from "./config.js";
import { openDatabase, migrate } from "./db.js";
import { passwordHash, uuid } from "./auth.js";
import { z } from "zod";

const config = loadConfig();
const db = await openDatabase(config);
try {
  await migrate(db);
  switch (process.argv[2]) {
    case "migrate":
      console.log("Databaseschema bijgewerkt.");
      break;
    case "seed": {
      if (config.PAYMENT_MODE !== "test") throw new Error("Testgegevens kunnen alleen in testmodus worden aangemaakt.");
      const { rows } = await db.query("SELECT id FROM events WHERE is_test=true");
      if (rows.length) {
        console.log("Er bestaat al een testevenement; geen wijzigingen.");
        break;
      }
      await db.query(
        `INSERT INTO events(id,title,starts_at,location,price_cents,capacity,is_test)
         VALUES($1,'KOORTS — TESTEVENEMENT',now()+interval '30 days','Testlocatie (geen echt feest)',1500,100,true)`, [uuid()]
      );
      console.log("Privé-testevenement aangemaakt. Niet zichtbaar in publieke verkoop.");
      break;
    }
    case "user": {
      const input = z.object({
        CREATE_USERNAME: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,80}$/),
        CREATE_PASSWORD: z.string().min(14).max(256),
        CREATE_ROLE: z.enum(["admin", "staff"]).default("staff")
      }).parse(process.env);
      await db.query(
        "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)",
        [uuid(), input.CREATE_USERNAME, await passwordHash(input.CREATE_PASSWORD), input.CREATE_ROLE]
      );
      console.log("Account aangemaakt. Verwijder CREATE_PASSWORD nu uit je lokale configuratie.");
      break;
    }
    default: throw new Error("Gebruik migrate, seed of user.");
  }
} finally {
  await db.close();
}
