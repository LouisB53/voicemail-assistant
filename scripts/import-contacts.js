/**
 * Import des contacts depuis l'historique des messages.
 * Prend le dernier nom connu (non-inconnu) par numéro par garage.
 * Ne remplace jamais un contact déjà validé manuellement.
 * Usage : node scripts/import-contacts.js
 */

import db from "../db.js";
import { upsertAutoContact } from "../db.js";

// Récupérer tous les messages avec analyse, du plus ancien au plus récent
const rows = db.prepare(`
  SELECT c.garage_id, c.from_number, m.analysis
  FROM messages m
  JOIN calls c ON c.call_sid = m.call_sid
  WHERE m.analysis IS NOT NULL
  ORDER BY m.created_at ASC
`).all();

// Garder le dernier nom non-inconnu par (garage_id, phone)
const best = {};
const SKIP = ["inconnu", "unknown", "—", "-", ""];

for (const row of rows) {
  try {
    const a = JSON.parse(row.analysis);
    const name = (a.caller_name || a.name || a.client_name || "").trim();
    if (SKIP.includes(name.toLowerCase())) continue;
    const key = `${row.garage_id}||${row.from_number}`;
    best[key] = { garage_id: row.garage_id, phone: row.from_number, name };
  } catch {}
}

// Insérer / mettre à jour les contacts
let count = 0;
for (const { garage_id, phone, name } of Object.values(best)) {
  upsertAutoContact(garage_id, phone, name);
  count++;
  console.log(`  [${garage_id}] ${phone} → ${name}`);
}

console.log(`\n✅ ${count} contacts importés.`);
