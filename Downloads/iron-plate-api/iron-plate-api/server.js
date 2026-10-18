"use strict";
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-secret-change-me";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "ironplate.db");
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
if (process.env.NODE_ENV === "production" && JWT_SECRET === "dev-only-secret-change-me") {
  console.error("Set JWT_SECRET before running in production."); process.exit(1);
}

// ---------- Database ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  goal_cal INTEGER NOT NULL DEFAULT 2400,
  goal_pro INTEGER NOT NULL DEFAULT 140,
  goal_sets INTEGER NOT NULL DEFAULT 15,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL, exercise TEXT NOT NULL,
  weight REAL NOT NULL, reps INTEGER NOT NULL, sets INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS meals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL, name TEXT NOT NULL,
  calories INTEGER NOT NULL, protein INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS weights (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL, value REAL NOT NULL,
  PRIMARY KEY (user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_sets_user_date ON sets(user_id, date);
CREATE INDEX IF NOT EXISTS idx_meals_user_date ON meals(user_id, date);
`);

// ---------- Helpers ----------
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const str = (v, max = 100) => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);
const num = (v, { min = 0, max = 1e6, int = false } = {}) => {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) return null;
  return int ? Math.round(n) : n;
};
const bad = (res, msg) => res.status(400).json({ error: msg });
const wrap = (fn) => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };

const app = express();
app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",") }));
app.use(express.json({ limit: "100kb" }));

// ---------- Auth ----------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const sign = (u) => jwt.sign({ sub: u.id }, JWT_SECRET, { expiresIn: "30d" });

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try { req.uid = jwt.verify(token, JWT_SECRET).sub; next(); }
  catch { res.status(401).json({ error: "Invalid or expired token" }); }
}

app.post("/api/auth/register", authLimiter, wrap((req, res) => {
  const email = str(req.body.email, 200)?.toLowerCase();
  const password = req.body.password;
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return bad(res, "Enter a valid email");
  if (typeof password !== "string" || password.length < 8 || password.length > 200) return bad(res, "Password must be 8 to 200 characters");
  if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email)) return res.status(409).json({ error: "Email already registered" });
  const info = db.prepare("INSERT INTO users (email, password_hash) VALUES (?,?)").run(email, bcrypt.hashSync(password, 10));
  res.status(201).json({ token: sign({ id: info.lastInsertRowid }) });
}));

app.post("/api/auth/login", authLimiter, wrap((req, res) => {
  const email = str(req.body.email, 200)?.toLowerCase();
  const u = email && db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!u || typeof req.body.password !== "string" || !bcrypt.compareSync(req.body.password, u.password_hash))
    return res.status(401).json({ error: "Wrong email or password" });
  res.json({ token: sign(u) });
}));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api", auth);

// ---------- Goals ----------
const goalsOf = (uid) => {
  const u = db.prepare("SELECT goal_cal cal, goal_pro pro, goal_sets sets FROM users WHERE id=?").get(uid);
  return u;
};
app.get("/api/goals", wrap((req, res) => res.json(goalsOf(req.uid))));
app.put("/api/goals", wrap((req, res) => {
  const cal = num(req.body.cal, { min: 500, max: 10000, int: true });
  const pro = num(req.body.pro, { min: 0, max: 600, int: true });
  const sets = num(req.body.sets, { min: 1, max: 200, int: true });
  if (cal === null || pro === null || sets === null) return bad(res, "Targets out of range");
  db.prepare("UPDATE users SET goal_cal=?, goal_pro=?, goal_sets=? WHERE id=?").run(cal, pro, sets, req.uid);
  res.json(goalsOf(req.uid));
}));

// ---------- Sets ----------
app.get("/api/sets", wrap((req, res) => {
  const { date, from, to } = req.query;
  let q = "SELECT id, date, exercise, weight, reps, sets FROM sets WHERE user_id=?", p = [req.uid];
  if (date) { if (!isDate(date)) return bad(res, "Bad date"); q += " AND date=?"; p.push(date); }
  if (from && isDate(from)) { q += " AND date>=?"; p.push(from); }
  if (to && isDate(to)) { q += " AND date<=?"; p.push(to); }
  res.json(db.prepare(q + " ORDER BY date DESC, id DESC").all(...p));
}));
app.post("/api/sets", wrap((req, res) => {
  const b = req.body, exercise = str(b.exercise, 80);
  const weight = num(b.weight, { max: 1000 }), reps = num(b.reps, { min: 1, max: 1000, int: true });
  const sets = b.sets === undefined ? 1 : num(b.sets, { min: 1, max: 100, int: true });
  if (!isDate(b.date) || !exercise || weight === null || reps === null || sets === null) return bad(res, "Invalid set");
  const i = db.prepare("INSERT INTO sets (user_id,date,exercise,weight,reps,sets) VALUES (?,?,?,?,?,?)").run(req.uid, b.date, exercise, weight, reps, sets);
  res.status(201).json({ id: i.lastInsertRowid, date: b.date, exercise, weight, reps, sets });
}));
app.delete("/api/sets/:id", wrap((req, res) => {
  const r = db.prepare("DELETE FROM sets WHERE id=? AND user_id=?").run(req.params.id, req.uid);
  r.changes ? res.status(204).end() : res.status(404).json({ error: "Not found" });
}));

// ---------- Meals ----------
app.get("/api/meals", wrap((req, res) => {
  const { date, from, to } = req.query;
  let q = "SELECT id, date, name, calories, protein FROM meals WHERE user_id=?", p = [req.uid];
  if (date) { if (!isDate(date)) return bad(res, "Bad date"); q += " AND date=?"; p.push(date); }
  if (from && isDate(from)) { q += " AND date>=?"; p.push(from); }
  if (to && isDate(to)) { q += " AND date<=?"; p.push(to); }
  res.json(db.prepare(q + " ORDER BY date DESC, id DESC").all(...p));
}));
app.post("/api/meals", wrap((req, res) => {
  const b = req.body, name = str(b.name, 100);
  const calories = num(b.calories, { max: 10000, int: true });
  const protein = b.protein === undefined ? 0 : num(b.protein, { max: 1000, int: true });
  if (!isDate(b.date) || !name || calories === null || protein === null) return bad(res, "Invalid meal");
  const i = db.prepare("INSERT INTO meals (user_id,date,name,calories,protein) VALUES (?,?,?,?,?)").run(req.uid, b.date, name, calories, protein);
  res.status(201).json({ id: i.lastInsertRowid, date: b.date, name, calories, protein });
}));
app.delete("/api/meals/:id", wrap((req, res) => {
  const r = db.prepare("DELETE FROM meals WHERE id=? AND user_id=?").run(req.params.id, req.uid);
  r.changes ? res.status(204).end() : res.status(404).json({ error: "Not found" });
}));

// ---------- Weigh-ins (one per day, upsert) ----------
app.get("/api/weights", wrap((req, res) => {
  res.json(db.prepare("SELECT date, value FROM weights WHERE user_id=? ORDER BY date").all(req.uid));
}));
app.put("/api/weights/:date", wrap((req, res) => {
  const value = num(req.body.value, { min: 20, max: 500 });
  if (!isDate(req.params.date) || value === null) return bad(res, "Invalid weigh-in");
  db.prepare("INSERT INTO weights (user_id,date,value) VALUES (?,?,?) ON CONFLICT(user_id,date) DO UPDATE SET value=excluded.value").run(req.uid, req.params.date, value);
  res.json({ date: req.params.date, value });
}));
app.delete("/api/weights/:date", wrap((req, res) => {
  const r = db.prepare("DELETE FROM weights WHERE user_id=? AND date=?").run(req.uid, req.params.date);
  r.changes ? res.status(204).end() : res.status(404).json({ error: "Not found" });
}));

// ---------- Summaries ----------
app.get("/api/summary/:date", wrap((req, res) => {
  const d = req.params.date;
  if (!isDate(d)) return bad(res, "Bad date");
  const m = db.prepare("SELECT COALESCE(SUM(calories),0) cal, COALESCE(SUM(protein),0) pro FROM meals WHERE user_id=? AND date=?").get(req.uid, d);
  const s = db.prepare("SELECT COALESCE(SUM(sets),0) sets FROM sets WHERE user_id=? AND date=?").get(req.uid, d);
  const w = db.prepare("SELECT value FROM weights WHERE user_id=? ORDER BY date DESC LIMIT 1").get(req.uid);
  res.json({ date: d, calories: m.cal, protein: m.pro, sets: s.sets, latestWeight: w ? w.value : null, goals: goalsOf(req.uid) });
}));

app.get("/api/progress", wrap((req, res) => {
  const days = Math.min(num(req.query.days, { min: 1, max: 365, int: true }) || 7, 365);
  const since = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
  const calories = db.prepare("SELECT date, SUM(calories) calories, SUM(protein) protein FROM meals WHERE user_id=? AND date>=? GROUP BY date ORDER BY date").all(req.uid, since);
  const bests = db.prepare(`
    SELECT exercise, MAX(weight) bestWeight, SUM(sets) totalSets,
           MAX(weight * (1 + reps / 30.0)) est1RM
    FROM sets WHERE user_id=? GROUP BY exercise ORDER BY exercise`).all(req.uid)
    .map((r) => ({ ...r, est1RM: Math.round(r.est1RM * 10) / 10 }));
  const weights = db.prepare("SELECT date, value FROM weights WHERE user_id=? AND date>=? ORDER BY date").all(req.uid, since);
  res.json({ days, calories, weights, bests });
}));

// ---------- Export / delete ----------
app.get("/api/export", wrap((req, res) => {
  res.json({
    goals: goalsOf(req.uid),
    sets: db.prepare("SELECT date, exercise, weight, reps, sets FROM sets WHERE user_id=?").all(req.uid),
    meals: db.prepare("SELECT date, name, calories, protein FROM meals WHERE user_id=?").all(req.uid),
    weights: db.prepare("SELECT date, value FROM weights WHERE user_id=?").all(req.uid),
  });
}));
app.delete("/api/account", wrap((req, res) => {
  db.prepare("DELETE FROM users WHERE id=?").run(req.uid);
  res.status(204).end();
}));

// ---------- Errors ----------
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON" });
  console.error(err);
  res.status(500).json({ error: "Server error" });
});

if (require.main === module) app.listen(PORT, () => console.log(`Iron & Plate API on :${PORT}`));
module.exports = app;
