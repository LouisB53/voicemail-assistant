// db.js (CORRIGÉ et SYNCHRONISÉ avec server.js)

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const dbFile = path.join(process.cwd(), "voicemail.db");

// ✅ Vérifie que la BDD existe, sinon la crée
if (!fs.existsSync(dbFile)) {
  console.log("📁 Création de la base SQLite...");
  fs.writeFileSync(dbFile, "");
}

const db = new Database(dbFile);

// ✅ Création des tables si elles n’existent pas
db.exec(`
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_sid TEXT UNIQUE,
  from_number TEXT,
  to_number TEXT,
  start_time TEXT,
  end_time TEXT,
  duration INTEGER,
  status TEXT,
  has_message INTEGER DEFAULT 0,
  garage_id TEXT,
  created_at TEXT DEFAULT (datetime(‘now’))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_sid TEXT,
  garage_id TEXT,
  from_number TEXT,
  transcript TEXT,
  analysis TEXT,
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime(‘now’))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  garage_id TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT
);

CREATE TABLE IF NOT EXISTS garage_settings (
  garage_id TEXT PRIMARY KEY,
  is_closed INTEGER DEFAULT 0,
  closed_message TEXT,
  updated_at TEXT
);
`);

// ✅ Ajout des colonnes recalled si elles n’existent pas (migration safe)
const callsColumns = db.prepare("PRAGMA table_info(calls)").all().map(c => c.name);
if (!callsColumns.includes("recalled_at")) {
  db.exec("ALTER TABLE calls ADD COLUMN recalled_at TEXT");
}
if (!callsColumns.includes("recalled_by")) {
  db.exec("ALTER TABLE calls ADD COLUMN recalled_by TEXT");
}

// Fonctions utilitaires
export function saveCall(callData) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO calls (call_sid, from_number, to_number, start_time, end_time, duration, status, has_message, garage_id)
    VALUES (@call_sid, @from_number, @to_number, @start_time, @end_time, @duration, @status, @has_message, @garage_id)
  `);
  stmt.run(callData);
}

export function saveMessage(messageData) {
  // 💡 Requête mise à jour pour correspondre aux clés envoyées par server.js
  const stmt = db.prepare(`
    INSERT INTO messages (call_sid, garage_id, from_number, transcript, analysis, sent_at)
    VALUES (@call_sid, @garage_id, @from_number, @transcript, @analysis, @sent_at)
  `);
  stmt.run(messageData);
}

export function getAllCalls() {
  // Pour l'exportation complète avec les messages associés
  return db.prepare(`
    SELECT 
      c.*, 
      m.transcript, 
      m.analysis
    FROM calls c
    LEFT JOIN messages m ON c.call_sid = m.call_sid
    ORDER BY c.created_at DESC
  `).all();
}

export function getRecentCalls(fromNumber, garageId) {
  return db.prepare(`
    SELECT created_at, has_message
    FROM calls
    WHERE from_number = ?
      AND garage_id = ?
      AND status NOT LIKE 'blocked%'
      AND created_at > datetime('now', '-7 days')
    ORDER BY created_at DESC
  `).all(fromNumber, garageId);
}

// --- Utilisateurs ---

export function getUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

export function getUserById(id) {
  return db.prepare("SELECT id, garage_id, username, display_name FROM users WHERE id = ?").get(id);
}

// --- Dashboard ---

export function getDashboardCalls(garageId, limit = 100) {
  const rows = db.prepare(`
    SELECT
      c.id, c.call_sid, c.from_number, c.garage_id, c.has_message,
      c.duration, c.status, c.created_at,
      c.recalled_at, c.recalled_by,
      m.transcript, m.analysis,
      (
        SELECT m2.analysis
        FROM messages m2
        JOIN calls c2 ON c2.call_sid = m2.call_sid
        WHERE c2.from_number = c.from_number
          AND c2.garage_id = c.garage_id
          AND c2.has_message = 1
          AND c2.id != c.id
        ORDER BY c2.created_at DESC
        LIMIT 1
      ) AS previous_analysis
    FROM calls c
    LEFT JOIN messages m ON c.call_sid = m.call_sid
    WHERE c.garage_id = ?
      AND c.status NOT LIKE 'blocked%'
    ORDER BY c.created_at DESC
    LIMIT ?
  `).all(garageId, limit);

  return rows.map(r => ({
    ...r,
    analysis: r.analysis ? JSON.parse(r.analysis) : null,
    previous_analysis: r.previous_analysis ? JSON.parse(r.previous_analysis) : null,
  }));
}

export function getDashboardKpis(garageId) {
  return db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(has_message) as with_message,
      SUM(CASE WHEN has_message = 1 AND recalled_at IS NULL THEN 1 ELSE 0 END) as to_recall
    FROM calls
    WHERE garage_id = ?
      AND status NOT LIKE 'blocked%'
      AND created_at > datetime('now', '-14 days')
  `).get(garageId);
}

export function getUrgentCount(garageId) {
  const rows = db.prepare(`
    SELECT m.analysis
    FROM messages m
    JOIN calls c ON c.call_sid = m.call_sid
    WHERE c.garage_id = ?
      AND c.created_at > datetime('now', '-14 days')
  `).all(garageId);
  return rows.filter(r => {
    try { return JSON.parse(r.analysis)?.is_urgent; } catch { return false; }
  }).length;
}

export function getMotifBreakdown(garageId) {
  const rows = db.prepare(`
    SELECT m.analysis
    FROM messages m
    JOIN calls c ON c.call_sid = m.call_sid
    WHERE c.garage_id = ?
      AND c.created_at > datetime('now', '-30 days')
  `).all(garageId);
  const counts = {};
  for (const r of rows) {
    try {
      const a = JSON.parse(r.analysis);
      const motif = a?.motive_legend;
      if (motif) counts[motif] = (counts[motif] || 0) + 1;
    } catch {}
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

export function markRecalled(callId, username) {
  db.prepare(`
    UPDATE calls SET recalled_at = datetime('now'), recalled_by = ?
    WHERE id = ?
  `).run(username, callId);
}

export function unmarkRecalled(callId) {
  db.prepare(`
    UPDATE calls SET recalled_at = NULL, recalled_by = NULL WHERE id = ?
  `).run(callId);
}

// --- Paramètres garage ---

export function getGarageSettings(garageId) {
  const row = db.prepare("SELECT * FROM garage_settings WHERE garage_id = ?").get(garageId);
  if (row) return row;
  // Valeurs par défaut si pas encore de ligne
  return { garage_id: garageId, is_closed: 0, closed_message: "Le garage est actuellement fermé. Merci de rappeler pendant nos horaires d'ouverture." };
}

export function setGarageSettings(garageId, isClosed, closedMessage) {
  db.prepare(`
    INSERT INTO garage_settings (garage_id, is_closed, closed_message, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(garage_id) DO UPDATE SET
      is_closed = excluded.is_closed,
      closed_message = excluded.closed_message,
      updated_at = excluded.updated_at
  `).run(garageId, isClosed ? 1 : 0, closedMessage);
}

console.log("✅ Base SQLite initialisée avec succès.");

export default db;