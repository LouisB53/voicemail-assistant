#!/usr/bin/env node
/**
 * Script de rattrapage complet via l'API Twilio
 *
 * Pour chaque appel du 13 avril non présent en BDD :
 * - Si enregistrement disponible : transcription Whisper + analyse GPT + email avec transcription
 * - Si pas d'enregistrement : email appel manqué sans message
 *
 * Reproduit exactement le comportement de server.js (processVoicemail + missed-call-email)
 *
 * Usage : node jobs/twilio-recovery.js [--date YYYY-MM-DD] [--dry-run]
 *   --date    : date à traiter en heure Paris (défaut : 2026-04-13)
 *   --dry-run : affiche sans envoyer ni écrire en BDD
 */

import Database from 'better-sqlite3';
import sgMail from '@sendgrid/mail';
import axios from 'axios';
import FormData from 'form-data';
import Twilio from 'twilio';
import { DateTime } from 'luxon';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { extractInfoGPT } from '../utils/gpt-extractor.js';
import { escapeHtml, normalizePhone } from '../utils/extractors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Arguments CLI ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dateIdx = args.indexOf('--date');
const TARGET_DATE = dateIdx !== -1 ? args[dateIdx + 1] : '2026-04-13';

// --- Config ---
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'voicemail.db');
const SENDGRID_API_SECRET = process.env.SENDGRID_API_SECRET;
const ACCOUNT_SID = process.env.ACCOUNT_SID;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Charger la configuration des garages
let GARAGES;
const configString = process.env.GARAGES_CONFIG;
if (configString) {
  try { GARAGES = JSON.parse(configString); }
  catch { GARAGES = JSON.parse(fs.readFileSync(join(__dirname, '..', 'garages.json'), 'utf-8')); }
} else {
  GARAGES = JSON.parse(fs.readFileSync(join(__dirname, '..', 'garages.json'), 'utf-8'));
}

// Vérification des variables requises
const missing = ['SENDGRID_API_SECRET', 'ACCOUNT_SID', 'AUTH_TOKEN', 'OPENAI_API_KEY']
  .filter(k => !process.env[k]);
if (missing.length > 0 && !DRY_RUN) {
  console.error(`❌ Variables manquantes : ${missing.join(', ')}`);
  process.exit(1);
}

if (!DRY_RUN) sgMail.setApiKey(SENDGRID_API_SECRET);
const twilioClient = Twilio(ACCOUNT_SID, AUTH_TOKEN);

// --- Utilitaires (même logique que server.js) ---
function toParisTime(date) {
  return DateTime.fromJSDate(date).setZone('Europe/Paris').toFormat('dd/MM - HH:mm');
}

function recoveryBanner(callDate) {
  return `
    <div style="background:#fff3cd;border-left:4px solid #f6c90e;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#555;line-height:1.5;">
      <strong>📬 Rattrapage</strong> — Cette notification concerne un appel du <strong>${callDate}</strong>
      qui n'a pas pu être envoyé suite à une interruption de notre service email (11-13 avril).
    </div>`;
}

// --- BDD ---
function openDB() {
  return new Database(DB_PATH);
}

function isAlreadyProcessed(db, callSid) {
  const row = db.prepare('SELECT id FROM calls WHERE call_sid = ?').get(callSid);
  return !!row;
}

function saveCallToDB(db, data) {
  db.prepare(`
    INSERT OR IGNORE INTO calls
      (call_sid, from_number, to_number, start_time, end_time, duration, status, has_message, garage_id)
    VALUES
      (@call_sid, @from_number, @to_number, @start_time, @end_time, @duration, @status, @has_message, @garage_id)
  `).run(data);
}

function saveMessageToDB(db, data) {
  db.prepare(`
    INSERT INTO messages (call_sid, garage_id, from_number, transcript, analysis, sent_at)
    VALUES (@call_sid, @garage_id, @from_number, @transcript, @analysis, @sent_at)
  `).run(data);
}

// --- Transcription Whisper ---
async function transcribeAudio(audioBuffer, callSid) {
  try {
    const { default: OpenAI } = await import('openai');
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    const form = new FormData();
    form.append('file', audioBuffer, { filename: `voicemail-${callSid}.mp3`, contentType: 'audio/mpeg' });
    form.append('model', 'whisper-1');
    form.append('language', 'fr');
    form.append('response_format', 'text');

    const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
      maxBodyLength: Infinity,
      timeout: 40000,
    });

    return (res.data || '').toString().trim() || '(transcription vide)';
  } catch (e) {
    console.error(`   ❌ Erreur Whisper : ${e.message}`);
    return `(échec transcription: ${e.message})`;
  }
}

// --- Email avec transcription (même format que processVoicemail) ---
async function sendVoicemailEmail(garage, From, callDate, transcript, gptAnalysis, audioBuffer, callSid) {
  const fromPhone = normalizePhone(From);
  const { name, motive_legend, motive_details, date_preference, is_urgent, plate_number } = gptAnalysis;

  const priorityTag = is_urgent ? '🚨 URGENT' : '';
  const subject = `📞 [${motive_legend.toUpperCase()}] ${name} (${fromPhone}) - ${date_preference}${priorityTag ? ' · ' + priorityTag : ''}`;

  const summaryLines = [
    priorityTag && `**${priorityTag}**`,
    `**Catégorie :** ${motive_legend}`,
    `**Motif détaillé :** ${motive_details}`,
    `**Date souhaitée :** ${date_preference}`,
    `**Appelant :** ${name} (${fromPhone})`,
    plate_number && plate_number !== 'inconnu' && `**Immatriculation :** ${plate_number}`,
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

  const html = `
    <div style="font-family: Arial, sans-serif; line-height:1.6; color:#222; font-size:15px; max-width:600px;">
      ${recoveryBanner(callDate)}
      ${summaryHtml}
      <p style="margin:14px 0 4px 0;"><strong>Transcription :</strong></p>
      <p style="margin:0; padding-left:10px; border-left:3px solid #ccc;">
        ${escapeHtml(transcript).replace(/\n+/g, '<br>').replace(/([.?!])\s/g, '$1&nbsp;')}
      </p>
    </div>`;

  const msg = {
    to: garage.to_email,
    from: garage.from_email,
    subject,
    html,
  };

  if (audioBuffer) {
    msg.attachments = [{
      content: audioBuffer.toString('base64'),
      filename: `voicemail-${callSid}.mp3`,
      type: 'audio/mpeg',
      disposition: 'attachment',
    }];
  }

  await sgMail.send(msg);
  return subject;
}

// --- Email appel manqué (même format que /missed-call-email) ---
async function sendMissedCallEmail(garage, From, callDate) {
  const subject = `📞 Appel manqué sans message de ${From}`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height:1.6; color:#222; font-size:15px; max-width:600px;">
      ${recoveryBanner(callDate)}
      <p><strong>Appelant :</strong> ${escapeHtml(From)}</p>
      <p>Aucun message n'a été laissé.</p>
    </div>`;

  await sgMail.send({ to: garage.to_email, from: garage.from_email, subject, html });
  return subject;
}

// --- Script principal ---
async function run() {
  console.log('='.repeat(60));
  console.log('📞 RATTRAPAGE VIA API TWILIO — PitCall');
  console.log('='.repeat(60));
  console.log(`Date ciblée    : ${TARGET_DATE} (heure Paris)`);
  console.log(`Mode           : ${DRY_RUN ? '🔍 DRY RUN' : '🚀 ENVOI RÉEL'}`);
  console.log(`Base de données: ${DB_PATH}`);
  console.log('='.repeat(60) + '\n');

  // Plage horaire : journée du TARGET_DATE en heure Paris → UTC
  const dayStart = DateTime.fromISO(TARGET_DATE, { zone: 'Europe/Paris' }).startOf('day');
  const dayEnd = dayStart.endOf('day');

  // Twilio filtre par date en UTC (format YYYY-MM-DD)
  const twilioStartDate = dayStart.toUTC().toJSDate();
  const twilioEndDate = dayEnd.toUTC().plus({ days: 1 }).toJSDate(); // endTime est exclusif

  console.log(`Plage UTC      : ${dayStart.toUTC().toISO()} → ${dayEnd.toUTC().toISO()}\n`);

  const db = openDB();
  let totalSent = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const [twilioNumber, garage] of Object.entries(GARAGES)) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`🏢 ${garage.name} (${twilioNumber})`);

    // Récupérer les appels Twilio entrants sur ce numéro ce jour-là
    let calls;
    try {
      calls = await twilioClient.calls.list({
        to: twilioNumber,
        startTimeAfter: twilioStartDate,
        startTimeBefore: twilioEndDate,
      });
    } catch (err) {
      console.error(`   ❌ Erreur API Twilio : ${err.message}`);
      totalFailed++;
      continue;
    }

    console.log(`   ${calls.length} appel(s) trouvé(s) sur Twilio`);

    for (const call of calls) {
      const callDate = toParisTime(call.startTime);
      const From = call.from;
      const callSid = call.sid;

      console.log(`\n   📞 ${callDate} — ${From} (${callSid})`);

      // Vérifier si déjà traité en BDD
      if (isAlreadyProcessed(db, callSid)) {
        console.log(`   ⏭️  Déjà en BDD — ignoré`);
        totalSkipped++;
        continue;
      }

      // Récupérer les enregistrements de cet appel
      let recordings = [];
      try {
        recordings = await twilioClient.recordings.list({ callSid });
      } catch (err) {
        console.error(`   ⚠️  Impossible de récupérer les enregistrements : ${err.message}`);
      }

      const validRecording = recordings.find(r => parseInt(r.duration, 10) > 3);

      if (validRecording) {
        console.log(`   🎙️  Enregistrement trouvé (${validRecording.duration}s) — transcription en cours...`);

        // Télécharger l'audio
        let audioBuffer = null;
        let transcript = '(transcription indisponible)';
        let gptAnalysis = null;

        if (!DRY_RUN) {
          try {
            const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${validRecording.sid}.mp3`;
            const audioRes = await axios.get(recordingUrl, {
              responseType: 'arraybuffer',
              auth: { username: ACCOUNT_SID, password: AUTH_TOKEN },
              timeout: 15000,
            });
            audioBuffer = Buffer.from(audioRes.data);
            console.log(`   ✅ Audio téléchargé`);

            transcript = await transcribeAudio(audioBuffer, callSid);
            console.log(`   ✅ Transcription : "${transcript.slice(0, 80)}..."`);

            gptAnalysis = await extractInfoGPT(transcript);
            console.log(`   ✅ GPT : ${gptAnalysis.motive_legend} — ${gptAnalysis.name}`);
          } catch (err) {
            console.error(`   ❌ Erreur traitement audio : ${err.message}`);
          }

          if (!gptAnalysis) {
            gptAnalysis = {
              name: 'inconnu',
              motive_legend: 'demande d\'information',
              motive_details: 'échec analyse',
              date_preference: 'pas précisé',
              is_urgent: false,
              plate_number: 'inconnu',
            };
          }

          try {
            const subject = await sendVoicemailEmail(garage, From, callDate, transcript, gptAnalysis, audioBuffer, callSid);
            console.log(`   ✅ Email envoyé : ${subject}`);

            saveCallToDB(db, {
              call_sid: callSid,
              from_number: From,
              to_number: twilioNumber,
              start_time: call.startTime.toISOString(),
              end_time: call.endTime?.toISOString() || call.startTime.toISOString(),
              duration: parseInt(call.duration, 10) || 0,
              status: 'completed',
              has_message: 1,
              garage_id: garage.name,
            });
            saveMessageToDB(db, {
              call_sid: callSid,
              garage_id: garage.name,
              from_number: From,
              transcript,
              analysis: JSON.stringify(gptAnalysis),
              sent_at: new Date().toISOString(),
            });

            // Suppression RGPD de l'enregistrement Twilio
            try {
              await twilioClient.recordings(validRecording.sid).remove();
              console.log(`   🗑️  Enregistrement Twilio supprimé (RGPD)`);
            } catch (err) {
              console.warn(`   ⚠️  Impossible de supprimer l'enregistrement : ${err.message}`);
            }

            totalSent++;
          } catch (err) {
            console.error(`   ❌ Échec envoi email : ${err.message}`);
            if (err.response) console.error('   Détails:', JSON.stringify(err.response.body));
            totalFailed++;
          }

        } else {
          console.log(`   ✅ [DRY RUN] Email avec transcription préparé pour ${garage.to_email}`);
          totalSent++;
        }

      } else {
        // Pas d'enregistrement valide → appel manqué sans message
        console.log(`   📵 Pas d'enregistrement valide — email appel manqué`);

        if (!DRY_RUN) {
          try {
            await sendMissedCallEmail(garage, From, callDate);
            console.log(`   ✅ Email appel manqué envoyé`);

            saveCallToDB(db, {
              call_sid: callSid,
              from_number: From,
              to_number: twilioNumber,
              start_time: call.startTime.toISOString(),
              end_time: call.endTime?.toISOString() || call.startTime.toISOString(),
              duration: parseInt(call.duration, 10) || 0,
              status: 'missed',
              has_message: 0,
              garage_id: garage.name,
            });

            totalSent++;
          } catch (err) {
            console.error(`   ❌ Échec envoi email : ${err.message}`);
            totalFailed++;
          }
        } else {
          console.log(`   ✅ [DRY RUN] Email appel manqué préparé pour ${garage.to_email}`);
          totalSent++;
        }
      }
    }
  }

  db.close();

  console.log('\n' + '='.repeat(60));
  console.log('RÉSUMÉ');
  console.log('='.repeat(60));
  console.log(`✅ Emails envoyés : ${totalSent}`);
  console.log(`⏭️  Déjà traités  : ${totalSkipped}`);
  console.log(`❌ Échecs         : ${totalFailed}`);
  console.log('='.repeat(60));

  process.exit(totalFailed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('❌ Erreur fatale:', err);
  process.exit(1);
});
