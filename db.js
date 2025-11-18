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
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_sid TEXT, -- 💡 CORRECTION 1 : Le CallSid de Twilio est du TEXTE, pas un INTEGER.
  garage_id TEXT,    -- Ajouté: Clé du garage pour lier l'appel/message
  from_number TEXT,  -- Ajouté: Numéro de l'appelant
  transcript TEXT,
  analysis TEXT,     -- 💡 MODIFICATION 2 : Stocke le JSON complet de l'analyse GPT
  sent_at TEXT,      -- Ajouté: Horodatage de l'envoi de l'email
  created_at TEXT DEFAULT (datetime('now'))
  -- Suppression des anciennes colonnes (recording_url, motif, nom_detecte, fidelity, confidence)
  -- La FOREIGN KEY n'est pas nécessaire ici si l'on ne référence pas calls(id)
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

console.log("✅ Base SQLite initialisée avec succès.");

export default db;