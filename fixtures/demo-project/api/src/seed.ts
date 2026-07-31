import { db } from "./db.js";

const email = process.env.DEMO_USER_EMAIL || "demo@example.com";
const password = process.env.DEMO_USER_PASSWORD || "password";

db.prepare("DELETE FROM items").run();
db.prepare("DELETE FROM users").run();
db.prepare("INSERT INTO users (email, password) VALUES (?, ?)").run(email, password);
const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: number };
db.prepare("INSERT INTO items (user_id, title) VALUES (?, ?)").run(user.id, "Welcome item");
console.log(`Seeded user ${email} with 1 item`);
