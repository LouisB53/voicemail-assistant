/**
 * scripts/recover-recordings.js
 *
 * Récupère et insère en BDD tous les enregistrements Twilio entre le 12 juin 2026 et aujourd'hui,
 * avec les dates/heures réelles de chaque appel (comme si ça avait été traité en live).
 * Aucun email envoyé.
 *
 * Usage:
 *   node scripts/recover-recordings.js              → traitement complet
 *   node scripts/recover-recordings.js --dry-run    → liste seulement, rien modifié
 *   node scripts/recover-recordings.js --no-delete  → conserve les enregistrements sur Twilio
 */

import dotenv from "dotenv";
dotenv.config();

import Twilio from "twilio";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { extractInfoGPT } from "../utils/gpt-extractor.js";
import db, { upsertAutoContact, getContactByPhone } from "../db.js";
import { GARAGES } from "../utils/garages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const NO_DELETE = args.includes("--no-delete");

const DATE_FROM = new Date("2026-06-13T00:00:00Z");
const DATE_TO   = new Date(); // aujourd'hui

const twilioClient = Twilio(process.env.ACCOUNT_SID, process.env.AUTH_TOKEN);

const AUDIO_DIR = path.join(__dirname, "../recovered-audio");
if (!DRY_RUN) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// --- Utilitaires ---

/** Convertit une Date JS en format SQLite UTC : "YYYY-MM-DD HH:MM:SS" */
function toSQLiteUTC(date) {
    return date.toISOString().replace("T", " ").substring(0, 19);
}

function findGarageByTo(toNumber) {
    return GARAGES[toNumber] || null;
}

function formatDuration(s) {
    if (!s) return "?s";
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m${sec}s` : `${sec}s`;
}

function alreadyInDB(callSid) {
    return !!db.prepare("SELECT 1 FROM calls WHERE call_sid = ? LIMIT 1").get(callSid);
}

function insertCall({ call_sid, from_number, to_number, start_time, duration, status, has_message, garage_id, created_at }) {
    db.prepare(`
        INSERT OR IGNORE INTO calls
            (call_sid, from_number, to_number, start_time, end_time, duration, status, has_message, garage_id, created_at)
        VALUES
            (@call_sid, @from_number, @to_number, @start_time, @end_time, @duration, @status, @has_message, @garage_id, @created_at)
    `).run({ call_sid, from_number, to_number, start_time, end_time: start_time, duration, status, has_message, garage_id, created_at });
}

function insertMessage({ call_sid, garage_id, from_number, transcript, analysis, sent_at, created_at }) {
    db.prepare(`
        INSERT INTO messages (call_sid, garage_id, from_number, transcript, analysis, sent_at, created_at)
        VALUES (@call_sid, @garage_id, @from_number, @transcript, @analysis, @sent_at, @created_at)
    `).run({ call_sid, garage_id, from_number, transcript, analysis, sent_at, created_at });
}

// --- Main ---
async function main() {
    console.log(`\n${"=".repeat(62)}`);
    console.log(`🔄  Récupération des enregistrements Twilio`);
    console.log(`${"=".repeat(62)}`);
    console.log(`📅  Période : ${DATE_FROM.toLocaleDateString("fr-FR", { timeZone: "UTC" })} → ${DATE_TO.toLocaleDateString("fr-FR")}`);
    console.log(`🧪  Mode    : ${DRY_RUN ? "DRY-RUN (lecture seule)" : "INSERTION EN BDD"}`);
    console.log(`🗑️   Twilio  : ${NO_DELETE ? "enregistrements conservés" : "supprimés après traitement (RGPD)"}`);
    console.log(`${"=".repeat(62)}\n`);

    // 1. Récupérer les enregistrements Twilio sur la période
    console.log("📡 Interrogation de l'API Twilio...");
    let recordings;
    try {
        recordings = await twilioClient.recordings.list({
            dateCreatedAfter:  DATE_FROM,
            dateCreatedBefore: DATE_TO,
            limit: 1000,
        });
    } catch (err) {
        console.error("❌ Erreur API Twilio :", err.message);
        process.exit(1);
    }

    if (recordings.length === 0) {
        console.log("✅ Aucun enregistrement trouvé sur Twilio pour cette période.");
        console.log("   → Soit déjà traités et supprimés, soit aucun message laissé.\n");
        process.exit(0);
    }

    // 2. Résumé
    console.log(`📋 ${recordings.length} enregistrement(s) trouvé(s) sur Twilio :\n`);
    let nouveaux = 0;
    for (const rec of recordings) {
        const sid = rec.callSid || rec.sid;
        const deja = alreadyInDB(sid) || alreadyInDB(rec.sid);
        const garage = findGarageByTo(rec.to || "");
        const date = new Date(rec.dateCreated).toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
        const flag = deja ? "⏭  déjà en BDD" : "🆕 à traiter";
        if (!deja) nouveaux++;
        console.log(`  ${flag} | ${date} | ${rec.from} → ${rec.to} | ${formatDuration(rec.duration)} | ${garage?.name || "garage inconnu"} | ${rec.sid}`);
    }
    console.log(`\n  → ${nouveaux} nouveau(x) à insérer, ${recordings.length - nouveaux} déjà présent(s).`);

    if (DRY_RUN) {
        console.log("\n🧪 Dry-run terminé. Relancez sans --dry-run pour insérer.\n");
        process.exit(0);
    }

    if (nouveaux === 0) {
        console.log("\n✅ Rien à faire, tous les enregistrements sont déjà en BDD.\n");
        process.exit(0);
    }

    // 3. Traitement
    console.log(`\n${"─".repeat(62)}`);
    console.log(`🚀 Traitement des ${nouveaux} nouvel(s) enregistrement(s)...`);
    console.log(`${"─".repeat(62)}\n`);

    let ok = 0, skipped = 0, failed = 0;

    for (const rec of recordings) {
        const RecordingSid = rec.sid;
        const CallSid      = rec.callSid || rec.sid;
        const From         = rec.from;
        const To           = rec.to;
        const duration     = parseInt(rec.duration, 10) || 0;
        const callDate     = new Date(rec.dateCreated);
        const sqliteDate   = toSQLiteUTC(callDate);
        const isoDate      = callDate.toISOString();

        // Skip doublons
        if (alreadyInDB(CallSid) || alreadyInDB(RecordingSid)) {
            skipped++;
            continue;
        }

        const dateLabel = callDate.toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
        console.log(`\n[${ok + failed + 1}/${nouveaux}] 🎙️  ${dateLabel} | ${From} → ${To} | ${formatDuration(duration)}`);

        // Identifier le garage
        const garage = findGarageByTo(To);
        if (!garage) {
            console.log(`  ⚠️  Numéro ${To} non reconnu — ignoré`);
            skipped++;
            continue;
        }
        console.log(`  🏪 Garage : ${garage.name}`);

        // Appels trop courts → appel manqué (sans message)
        if (duration <= 3) {
            insertCall({
                call_sid:    RecordingSid,
                from_number: From,
                to_number:   To,
                start_time:  isoDate,
                duration,
                status:      "missed",
                has_message: 0,
                garage_id:   garage.name,
                created_at:  sqliteDate,
            });
            console.log(`  📭 Inséré comme appel manqué (${duration}s)`);
            ok++;
            continue;
        }

        try {
            // 3a. Téléchargement audio
            console.log(`  📥 Téléchargement audio...`);
            const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.ACCOUNT_SID}/Recordings/${RecordingSid}.mp3`;
            const audioRes = await axios.get(recordingUrl, {
                responseType: "arraybuffer",
                auth: { username: process.env.ACCOUNT_SID, password: process.env.AUTH_TOKEN },
                timeout: 15000,
            });
            const audioBuffer = Buffer.from(audioRes.data);
            fs.writeFileSync(path.join(AUDIO_DIR, `${RecordingSid}.mp3`), audioBuffer);
            console.log(`  ✅ Audio OK (${Math.round(audioBuffer.length / 1024)} KB) — sauvegardé dans recovered-audio/`);

            // 3b. Transcription Whisper
            console.log(`  🎤 Transcription Whisper...`);
            let transcript = "(transcription indisponible)";
            try {
                const { default: OpenAI } = await import("openai");
                const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                const form = new FormData();
                form.append("file", audioBuffer, { filename: `${RecordingSid}.mp3`, contentType: "audio/mpeg" });
                form.append("model", "whisper-1");
                form.append("language", "fr");
                form.append("response_format", "text");
                const sttRes = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
                    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
                    maxBodyLength: Infinity,
                    timeout: 40000,
                });
                transcript = (sttRes.data || "").toString().trim() || transcript;
                console.log(`  ✅ Transcription : "${transcript.substring(0, 90)}${transcript.length > 90 ? "..." : ""}"`);
            } catch (e) {
                console.error(`  ❌ Whisper échoué : ${e.message}`);
                transcript = `(échec transcription: ${e?.message || "inconnue"})`;
            }

            // 3c. Analyse GPT
            console.log(`  🤖 Analyse GPT...`);
            const gpt = await extractInfoGPT(transcript);
            console.log(`  ✅ ${gpt.motive_legend} | urgent: ${gpt.is_urgent} | plaque: ${gpt.plate_number}`);

            // 3d. Insertion BDD avec la vraie date de l'appel
            insertCall({
                call_sid:    CallSid,
                from_number: From,
                to_number:   To,
                start_time:  isoDate,
                duration,
                status:      "processed",
                has_message: 1,
                garage_id:   garage.name,
                created_at:  sqliteDate,   // ← date réelle de l'appel
            });
            insertMessage({
                call_sid:    CallSid,
                garage_id:   garage.name,
                from_number: From,
                transcript,
                analysis:    JSON.stringify(gpt),
                sent_at:     isoDate,
                created_at:  sqliteDate,   // ← date réelle de l'appel
            });
            upsertAutoContact(garage.name, From, gpt.name);
            console.log(`  💾 Inséré en BDD avec created_at = ${sqliteDate} (UTC)`);

            // 3e. Suppression RGPD sur Twilio
            if (!NO_DELETE) {
                try {
                    await twilioClient.recordings(RecordingSid).remove();
                    console.log(`  🗑️  Supprimé de Twilio (RGPD)`);
                } catch (e) {
                    console.warn(`  ⚠️  Suppression Twilio échouée : ${e.message}`);
                }
            }

            ok++;
        } catch (err) {
            console.error(`  ❌ ERREUR ${RecordingSid} : ${err.message}`);
            failed++;
        }

        // Petite pause pour éviter de saturer les APIs
        await new Promise(r => setTimeout(r, 600));
    }

    // 4. Bilan
    console.log(`\n${"=".repeat(62)}`);
    console.log(`✅  Terminé`);
    console.log(`   Insérés  : ${ok}`);
    console.log(`   Ignorés  : ${skipped}`);
    console.log(`   Erreurs  : ${failed}`);
    if (ok > 0) console.log(`\n   MP3 locaux : ${AUDIO_DIR}`);
    console.log(`${"=".repeat(62)}\n`);

}

main().catch(err => {
    console.error("💥 Erreur fatale :", err.message);
    process.exit(1);
});
