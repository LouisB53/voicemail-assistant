#!/usr/bin/env node
/**
 * Script de rattrapage des emails non envoyés (expiration trial SendGrid)
 *
 * Envoie UN email par appel, au même format que server.js,
 * avec une bannière indiquant que c'est un rattrapage.
 *
 * Usage : node jobs/recovery-send.js [--from YYYY-MM-DD] [--dry-run]
 *   --from    : date de début (défaut : 2026-04-13)
 *   --dry-run : affiche sans envoyer
 */

import Database from 'better-sqlite3';
import sgMail from '@sendgrid/mail';
import { DateTime } from 'luxon';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Arguments CLI ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const fromIdx = args.indexOf('--from');
const FROM_DATE = fromIdx !== -1 ? args[fromIdx + 1] : '2026-04-13';

// --- Config ---
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'voicemail.db');
const SENDGRID_API_SECRET = process.env.SENDGRID_API_SECRET;

// Charger la configuration des garages (même logique que server.js)
let GARAGES;
const configString = process.env.GARAGES_CONFIG;
if (configString) {
  try {
    GARAGES = JSON.parse(configString);
  } catch {
    GARAGES = JSON.parse(fs.readFileSync(join(__dirname, '..', 'garages.json'), 'utf-8'));
  }
} else {
  GARAGES = JSON.parse(fs.readFileSync(join(__dirname, '..', 'garages.json'), 'utf-8'));
}

if (!DRY_RUN) {
  if (!SENDGRID_API_SECRET) {
    console.error('❌ SENDGRID_API_SECRET non défini');
    process.exit(1);
  }
  sgMail.setApiKey(SENDGRID_API_SECRET);
}

// Même fonction que server.js
function toParisTime(rawDate) {
  if (!rawDate) return 'date inconnue';
  const dt = DateTime.fromSQL(rawDate, { zone: 'utc' });
  if (!dt.isValid) return rawDate;
  return dt.setZone('Europe/Paris').toFormat('dd/MM - HH:mm');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizePhone(number) {
  if (!number) return '';
  return String(number).replace(/\s+/g, '');
}

function parseAnalysis(str) {
  try { return str ? JSON.parse(str) : {}; } catch { return {}; }
}

// Bannière de rattrapage à insérer en haut de chaque email
function recoveryBanner(callDate) {
  return `
    <div style="background:#fff3cd;border-left:4px solid #f6c90e;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#555;line-height:1.5;">
      <strong>📬 Rattrapage</strong> — Cette notification concerne un appel du <strong>${callDate}</strong>
      qui n'a pas pu être envoyé suite à une interruption de notre service email (11-13 avril).
    </div>`;
}

async function run() {
  console.log('='.repeat(60));
  console.log('📬 RATTRAPAGE EMAILS NON ENVOYÉS — PitCall');
  console.log('='.repeat(60));
  console.log(`Depuis         : ${FROM_DATE}`);
  console.log(`Mode           : ${DRY_RUN ? '🔍 DRY RUN (aucun email envoyé)' : '🚀 ENVOI RÉEL'}`);
  console.log(`Base de données: ${DB_PATH}`);
  console.log('='.repeat(60) + '\n');

  let db;
  try {
    db = new Database(DB_PATH, { readonly: true });
    console.log('✅ Connexion BDD réussie\n');
  } catch (err) {
    console.error("❌ Impossible d'ouvrir la BDD:", err.message);
    process.exit(1);
  }

  const startDatetime = `${FROM_DATE} 00:00:00`;

  // Récupérer tous les appels depuis FROM_DATE (sauf les bloqués)
  const calls = db.prepare(`
    SELECT c.call_sid, c.from_number, c.to_number, c.has_message, c.created_at, c.garage_id,
           m.transcript, m.analysis
    FROM calls c
    LEFT JOIN messages m ON c.call_sid = m.call_sid
    WHERE datetime(c.created_at) >= datetime(?)
      AND c.status NOT LIKE 'blocked%'
    ORDER BY c.created_at ASC
  `).all(startDatetime);

  console.log(`📞 Appels à traiter : ${calls.length}\n`);

  let totalSent = 0;
  let totalFailed = 0;

  for (const call of calls) {
    const garageId = call.garage_id;

    // Trouver la config du garage (cherche par name comme server.js stocke garage.name)
    const garageConfig = Object.values(GARAGES).find(g => g.name === garageId || g.id === garageId);
    if (!garageConfig) {
      console.log(`⚠️  [${call.call_sid}] Pas de config pour "${garageId}" — ignoré`);
      totalFailed++;
      continue;
    }

    const { to_email, from_email } = garageConfig;
    const From = call.from_number;
    const fromPhone = normalizePhone(From);
    const callDate = toParisTime(call.created_at);
    const banner = recoveryBanner(callDate);

    let subject, html;

    if (call.has_message && call.transcript) {
      // --- Email avec transcription (même format que processVoicemail) ---
      const analysis = parseAnalysis(call.analysis);
      const name = analysis.name || '(non spécifié)';
      const motive_legend = analysis.motive_legend || '(pas catégorisé)';
      const motive_details = analysis.motive_details || '(à déterminer)';
      const date_preference = analysis.date_preference || 'Indéterminée';
      const is_urgent = analysis.is_urgent || false;
      const plate_number = analysis.plate_number || null;

      const priorityTag = is_urgent ? '🚨 URGENT' : '';
      subject = `📞 [${motive_legend.toUpperCase()}] ${name} (${fromPhone}) - ${date_preference}${priorityTag ? ' · ' + priorityTag : ''}`;

      const summaryLines = [
        priorityTag && `**${priorityTag}**`,
        `**Catégorie :** ${motive_legend}`,
        `**Motif détaillé :** ${motive_details}`,
        `**Date souhaitée :** ${date_preference}`,
        `**Appelant :** ${name} (${fromPhone})`,
        plate_number && `**Immatriculation :** ${plate_number}`,
        `—`,
        `Rappel rapide recommandé.`,
      ].filter(Boolean);

      const summaryHtml = summaryLines.map(l => {
        if (l === '—') return '<hr style="border:none;border-top:1px solid #ddd;margin:12px 0;">';
        const clean = escapeHtml(l.replace(/\*\*/g, ''));
        const match = clean.match(/^([^:]+):\s*(.*)/);
        if (match) return `<p style="margin:0 0 4px 0;"><strong>${match[1]}:</strong> ${match[2]}</p>`;
        return `<p style="margin:0 0 4px 0;"><strong>${clean}</strong></p>`;
      }).join('');

      html = `
        <div style="font-family: Arial, sans-serif; line-height:1.6; color:#222; font-size:15px; max-width:600px;">
          ${banner}
          ${summaryHtml}
          <p style="margin:14px 0 4px 0;"><strong>Transcription :</strong></p>
          <p style="margin:0; padding-left:10px; border-left:3px solid #ccc;">
            ${escapeHtml(call.transcript).replace(/\n+/g, '<br>')}
          </p>
        </div>`;

    } else {
      // --- Email appel manqué sans message (même format que /missed-call-email) ---
      subject = `📞 Appel manqué sans message de ${From}`;
      html = `
        <div style="font-family: Arial, sans-serif; line-height:1.6; color:#222; font-size:15px; max-width:600px;">
          ${banner}
          <p><strong>Appelant :</strong> ${escapeHtml(From)}</p>
          <p>Aucun message n'a été laissé.</p>
        </div>`;
    }

    console.log(`📧 [${callDate}] ${call.has_message ? 'Message vocal' : 'Appel manqué'} de ${From} → ${to_email}`);
    console.log(`   Sujet : ${subject}`);

    if (DRY_RUN) {
      console.log('   ✅ [DRY RUN] Email non envoyé\n');
      totalSent++;
      continue;
    }

    try {
      await sgMail.send({ to: to_email, from: from_email, subject, html });
      console.log('   ✅ Envoyé\n');
      totalSent++;
    } catch (err) {
      console.error(`   ❌ Échec : ${err.message}`);
      if (err.response) console.error('   Détails:', JSON.stringify(err.response.body));
      console.log('');
      totalFailed++;
    }
  }

  db.close();

  console.log('='.repeat(60));
  console.log(`✅ Envoyés : ${totalSent}`);
  console.log(`❌ Échecs  : ${totalFailed}`);
  console.log('='.repeat(60));

  process.exit(totalFailed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('❌ Erreur fatale:', err);
  process.exit(1);
});
