// db.js
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
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER,
  recording_url TEXT,
  transcription TEXT,
  motif TEXT,
  nom_detecte TEXT,
  fidelity TEXT,
  confidence REAL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY(call_id) REFERENCES calls(id)
);
`);

// Fonctions utilitaires
export function saveCall(callData) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO calls (call_sid, from_number, to_number, start_time, end_time, duration, status, has_message, garage_id)
    VALUES (@call_sid, @from_number, @to_number, @start_time, @end_time, @duration, @status, @has_message, @garage_id)
  `);
  stmt.run(callData);
}

export function saveMessage(messageData) {
  const stmt = db.prepare(`
    INSERT INTO messages (call_id, recording_url, transcription, motif, nom_detecte, fidelity, confidence)
    VALUES (@call_id, @recording_url, @transcription, @motif, @nom_detecte, @fidelity, @confidence)
  `);
  stmt.run(messageData);
}

export function getAllCalls() {
  return db.prepare("SELECT * FROM calls ORDER BY created_at DESC").all();
}

console.log("✅ Base SQLite initialisée avec succès.");

export default db;