#!/usr/bin/env node
/**
 * Script de rattrapage : insère en BDD tous les appels Twilio de la période
 * avec leurs dates réelles, sans envoyer d'emails.
 * Les données apparaissent ensuite sur la plateforme comme si elles avaient été traitées en live.
 *
 * Usage : node jobs/twilio-recovery.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run]
 *   --from    : date de début (défaut : 2026-06-13)
 *   --to      : date de fin inclusive (défaut : aujourd'hui)
 *   --dry-run : affiche sans écrire en BDD
 */

import Database from 'better-sqlite3';
import axios from 'axios';
import FormData from 'form-data';
import Twilio from 'twilio';
import { DateTime } from 'luxon';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { extractInfoGPT } from '../utils/gpt-extractor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Arguments CLI ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

const fromIdx = args.indexOf('--from');
const FROM_DATE = fromIdx !== -1 ? args[fromIdx + 1] : '2026-06-13';

const toIdx = args.indexOf('--to');
const TO_DATE = toIdx !== -1 ? args[toIdx + 1] : DateTime.now().setZone('Europe/Paris').toFormat('yyyy-MM-dd');

// --- Config ---
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'voicemail.db');
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

const missing = ['ACCOUNT_SID', 'AUTH_TOKEN', 'OPENAI_API_KEY'].filter(k => !process.env[k]);
if (missing.length > 0 && !DRY_RUN) {
  console.error(`❌ Variables manquantes : ${missing.join(', ')}`);
  process.exit(1);
}

const twilioClient = Twilio(ACCOUNT_SID, AUTH_TOKEN);

// --- Utilitaires ---
function toParisTime(date) {
  return DateTime.fromJSDate(date).setZone('Europe/Paris').toFormat('dd/MM/yyyy HH:mm');
}

function toSQLiteUTC(date) {
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

// --- BDD ---
function isAlreadyProcessed(db, callSid) {
  return !!db.prepare('SELECT id FROM calls WHERE call_sid = ?').get(callSid);
}

function saveCallToDB(db, data) {
  db.prepare(`
    INSERT OR IGNORE INTO calls
      (call_sid, from_number, to_number, start_time, end_time, duration, status, has_message, garage_id, created_at)
    VALUES
      (@call_sid, @from_number, @to_number, @start_time, @end_time, @duration, @status, @has_message, @garage_id, @created_at)
  `).run(data);
}

function saveMessageToDB(db, data) {
  db.prepare(`
    INSERT INTO messages (call_sid, garage_id, from_number, transcript, analysis, sent_at, created_at)
    VALUES (@call_sid, @garage_id, @from_number, @transcript, @analysis, @sent_at, @created_at)
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
    console.error(`    ❌ Erreur Whisper : ${e.message}`);
    return `(échec transcription: ${e.message})`;
  }
}

// --- Script principal ---
async function run() {
  console.log('='.repeat(60));
  console.log('📞 RATTRAPAGE BDD VIA TWILIO — PitCall');
  console.log('='.repeat(60));
  console.log(`Période        : ${FROM_DATE} → ${TO_DATE}`);
  console.log(`Mode           : ${DRY_RUN ? '🔍 DRY RUN (aucune écriture)' : '🚀 INSERTION EN BDD'}`);
  console.log(`Base de données: ${DB_PATH}`);
  console.log('='.repeat(60) + '\n');

  // Générer la liste des jours à traiter
  const days = [];
  let cursor = DateTime.fromISO(FROM_DATE, { zone: 'Europe/Paris' }).startOf('day');
  const end = DateTime.fromISO(TO_DATE, { zone: 'Europe/Paris' }).endOf('day');
  while (cursor <= end) {
    days.push(cursor);
    cursor = cursor.plus({ days: 1 });
  }
  console.log(`📅 ${days.length} jour(s) à traiter\n`);

  const db = openDB();
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const day of days) {
    const dayLabel = day.toFormat('dd/MM/yyyy');
    const dayStart = day.toUTC().toJSDate();
    const dayEnd = day.endOf('day').toUTC().toJSDate();

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`📅 ${dayLabel}`);

    for (const [twilioNumber, garage] of Object.entries(GARAGES)) {
      console.log(`\n  🏢 ${garage.name} (${twilioNumber})`);

      let calls;
      try {
        calls = await twilioClient.calls.list({
          to: twilioNumber,
          startTimeAfter: dayStart,
          startTimeBefore: dayEnd,
        });
      } catch (err) {
        console.error(`  ❌ Erreur API Twilio : ${err.message}`);
        totalFailed++;
        continue;
      }

      if (calls.length === 0) { console.log(`  → Aucun appel`); continue; }
      console.log(`  → ${calls.length} appel(s)`);

      for (const call of calls) {
        const callDateObj = new Date(call.startTime);
        const callDate = toParisTime(callDateObj);
        const From = call.from;
        const callSid = call.sid;
        const createdAt = toSQLiteUTC(callDateObj);

        console.log(`\n    📞 ${callDate} — ${From}`);

        if (isAlreadyProcessed(db, callSid)) {
          console.log(`    ⏭️  Déjà en BDD`);
          totalSkipped++;
          continue;
        }

        if (DRY_RUN) {
          console.log(`    ✅ [DRY RUN] Serait inséré en BDD`);
          totalInserted++;
          continue;
        }

        // Récupérer les enregistrements
        let recordings = [];
        try {
          recordings = await twilioClient.recordings.list({ callSid });
        } catch (err) {
          console.error(`    ⚠️  Enregistrements inaccessibles : ${err.message}`);
        }

        const validRecording = recordings.find(r => parseInt(r.duration, 10) > 3);

        if (validRecording) {
          console.log(`    🎙️  Enregistrement (${validRecording.duration}s) — transcription...`);

          let audioBuffer = null;
          let transcript = '(transcription indisponible)';
          let gptAnalysis = null;

          try {
            const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Recordings/${validRecording.sid}.mp3`;
            const audioRes = await axios.get(recordingUrl, {
              responseType: 'arraybuffer',
              auth: { username: ACCOUNT_SID, password: AUTH_TOKEN },
              timeout: 15000,
            });
            audioBuffer = Buffer.from(audioRes.data);

            transcript = await transcribeAudio(audioBuffer, callSid);
            console.log(`    ✅ Transcription : "${transcript.slice(0, 70)}${transcript.length > 70 ? '...' : ''}"`);

            gptAnalysis = await extractInfoGPT(transcript);
            console.log(`    ✅ GPT : ${gptAnalysis.motive_legend} — ${gptAnalysis.name}`);
          } catch (err) {
            console.error(`    ❌ Erreur traitement : ${err.message}`);
          }

          if (!gptAnalysis) {
            gptAnalysis = {
              name: 'inconnu', motive_legend: "demande d'information",
              motive_details: 'échec analyse', date_preference: 'pas précisé',
              is_urgent: false, plate_number: 'inconnu',
            };
          }

          try {
            saveCallToDB(db, {
              call_sid: callSid,
              from_number: From,
              to_number: twilioNumber,
              start_time: callDateObj.toISOString(),
              end_time: (call.endTime ? new Date(call.endTime) : callDateObj).toISOString(),
              duration: parseInt(call.duration, 10) || 0,
              status: 'completed',
              has_message: 1,
              garage_id: garage.name,
              created_at: createdAt,
            });
            saveMessageToDB(db, {
              call_sid: callSid,
              garage_id: garage.name,
              from_number: From,
              transcript,
              analysis: JSON.stringify(gptAnalysis),
              sent_at: callDateObj.toISOString(),
              created_at: createdAt,
            });
            console.log(`    💾 Inséré en BDD (${createdAt})`);

            // Suppression RGPD
            try {
              await twilioClient.recordings(validRecording.sid).remove();
              console.log(`    🗑️  Enregistrement Twilio supprimé (RGPD)`);
            } catch (err) {
              console.warn(`    ⚠️  Suppression Twilio échouée : ${err.message}`);
            }

            totalInserted++;
          } catch (err) {
            console.error(`    ❌ Erreur BDD : ${err.message}`);
            totalFailed++;
          }

        } else {
          // Appel manqué sans enregistrement
          try {
            saveCallToDB(db, {
              call_sid: callSid,
              from_number: From,
              to_number: twilioNumber,
              start_time: callDateObj.toISOString(),
              end_time: (call.endTime ? new Date(call.endTime) : callDateObj).toISOString(),
              duration: parseInt(call.duration, 10) || 0,
              status: 'missed',
              has_message: 0,
              garage_id: garage.name,
              created_at: createdAt,
            });
            console.log(`    💾 Appel manqué inséré en BDD (${createdAt})`);
            totalInserted++;
          } catch (err) {
            console.error(`    ❌ Erreur BDD : ${err.message}`);
            totalFailed++;
          }
        }

        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  db.close();

  console.log('\n' + '='.repeat(60));
  console.log('RÉSUMÉ');
  console.log('='.repeat(60));
  console.log(`💾 Insérés en BDD : ${totalInserted}`);
  console.log(`⏭️  Déjà présents  : ${totalSkipped}`);
  console.log(`❌ Échecs          : ${totalFailed}`);
  console.log('='.repeat(60));

  process.exit(totalFailed > 0 ? 1 : 0);
}

function openDB() {
  return new Database(DB_PATH);
}

run().catch(err => {
  console.error('❌ Erreur fatale:', err);
  process.exit(1);
});
