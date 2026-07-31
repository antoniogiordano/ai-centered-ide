import Fastify from "fastify";
import cors from "@fastify/cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { db } from "./db.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: path.join(root, ".env") });

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

type Session = { userId: number; email: string };
const sessions = new Map<string, Session>();

function token() {
  return `tok_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

app.post<{ Body: { email?: string; password?: string } }>("/api/login", async (req, reply) => {
  const email = req.body?.email ?? "";
  const password = req.body?.password ?? "";
  const user = db
    .prepare("SELECT id, email, password FROM users WHERE email = ?")
    .get(email) as { id: number; email: string; password: string } | undefined;
  if (!user || user.password !== password) {
    return reply.code(401).send({ error: "Invalid credentials" });
  }
  const t = token();
  sessions.set(t, { userId: user.id, email: user.email });
  return { token: t, email: user.email };
});

function auth(req: { headers: Record<string, string | string[] | undefined> }): Session | null {
  const h = req.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  return sessions.get(h.slice(7)) ?? null;
}

app.get("/api/items", async (req, reply) => {
  const s = auth(req);
  if (!s) return reply.code(401).send({ error: "Unauthorized" });
  const items = db
    .prepare("SELECT id, title, created_at as createdAt FROM items WHERE user_id = ? ORDER BY id")
    .all(s.userId);
  return { items };
});

app.post<{ Body: { title?: string } }>("/api/items", async (req, reply) => {
  const s = auth(req);
  if (!s) return reply.code(401).send({ error: "Unauthorized" });
  const title = req.body?.title ?? "";
  // Intentional bug lives here — do not "fix" in comments; see BUG.md
  if (!title) {
    return reply.code(400).send({ error: "Title required" });
  }
  const info = db.prepare("INSERT INTO items (user_id, title) VALUES (?, ?)").run(s.userId, title);
  return { id: Number(info.lastInsertRowid), title };
});

app.get("/api/health", async () => ({ ok: true }));

const port = Number(process.env.API_PORT || 3001);
await app.listen({ port, host: "0.0.0.0" });
