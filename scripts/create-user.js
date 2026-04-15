/**
 * Script pour créer un utilisateur garagiste.
 * Usage : node scripts/create-user.js <garage_id> <username> <password> [display_name]
 * Exemple : node scripts/create-user.js "Garage Martin" martin MonMotDePasse "Jean Martin"
 */

import bcrypt from "bcryptjs";
import db from "../db.js";

const [, , garageId, username, password, displayName, role] = process.argv;

if (!garageId || !username || !password) {
  console.error("Usage : node scripts/create-user.js <garage_id> <username> <password> [display_name] [role]");
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);

try {
  db.prepare(`
    INSERT INTO users (garage_id, username, password_hash, display_name, role)
    VALUES (?, ?, ?, ?, ?)
  `).run(garageId, username, hash, displayName || username, role || 'user');
  console.log(`✅ Utilisateur créé : ${username} → garage "${garageId}"`);
} catch (err) {
  if (err.message.includes("UNIQUE constraint")) {
    console.error(`❌ L'identifiant "${username}" existe déjà.`);
  } else {
    console.error("❌ Erreur :", err.message);
  }
  process.exit(1);
}
