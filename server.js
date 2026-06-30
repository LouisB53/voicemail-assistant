// server.js (Code COMPLET refactorisé et finalisé)

import express from "express";
import axios from "axios";
import FormData from "form-data";
import sgMail from "@sendgrid/mail";
import fs from "fs";
import dotenv from "dotenv";
// Import de l'extracteur GPT et des utilitaires nécessaires
import { extractInfoGPT } from "./utils/gpt-extractor.js"; 
import db, { saveCall, saveMessage, getAllCalls, getRecentCalls, getGarageSettings, upsertAutoContact, getContactByPhone, getAllGarageConfigs } from "./db.js";
import authRouter from "./routes/auth.js";
import dashboardRouter from "./routes/dashboard.js";
import contactsRouter from "./routes/contacts.js";
import adminRouter from "./routes/admin.js";
import billingRouter from "./routes/billing.js";
import { logServerError } from "./db.js";
import { escapeHtml, normalizePhone } from "./utils/extractors.js";
import { DateTime } from "luxon";
import Twilio from "twilio";
import { GARAGES, addGarageToRuntime } from "./utils/garages.js";

dotenv.config();

const app = express();

// Configuration Twilio
const twilioClient = Twilio(process.env.ACCOUNT_SID, process.env.AUTH_TOKEN);

// Raw body pour le webhook Stripe (doit être avant express.json)
app.use("/api/billing/webhook", express.raw({ type: "application/json" }));

// Middleware pour accepter tous les formats Twilio
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.text({ type: "*/*" }));

// Interface web statique
app.use(express.static("public"));

// Routes API
app.use("/api/auth", authRouter);
app.use("/api/billing", billingRouter);
app.use("/api", dashboardRouter);
app.use("/api", contactsRouter);
app.use("/api/admin", adminRouter);

// --- DÉBUT DU BLOC MODIFIÉ POUR LA SÉCURITÉ ET AZURE APP SERVICE ---

// Charger la configuration des garages (statique + dynamique DB)
{
  const dbGarages = getAllGarageConfigs();
  for (const g of dbGarages) {
    addGarageToRuntime(g.twilio_number, {
      id: g.garage_id,
      name: g.name,
      to_email: g.to_email,
      from_email: g.from_email,
    });
  }
  console.log(`✅ Garages chargés : ${Object.keys(GARAGES).length} au total, ${dbGarages.length} dynamiques.`);
}

// Configurer SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_SECRET);

// Bonne heure locale pour les timestamps
function toParisTime(rawDate) {
    if (!rawDate) return "date inconnue";

    // SQLite renvoie du "YYYY-MM-DD HH:mm:ss" (datetime('now'))
    const dt = DateTime.fromSQL(rawDate, { zone: "utc" });

    if (!dt.isValid) {
        console.error("❌ DateTime invalide pour l'historique:", rawDate, dt.invalidReason);
        return rawDate; // fallback brut, au moins tu vois quelque chose
    }

    return dt
        .setZone("Europe/Paris")
        .toFormat("dd/MM - HH:mm");
}

// --- FIN DU BLOC MODIFIÉ ---

// Garde anti-doublon : empêche de traiter deux fois le même enregistrement
const _processingKeys = new Set();

/**
 * ⚙️ Fonction de Traitement Lourd Asynchrone (Whisper, GPT, Email)
 * Cette fonction est appelée sans "await" par la route Twilio.
 */
async function processVoicemail(payload) {
    let { RecordingSid, From, To, CallSid, CallStatus, RecordingDuration } = payload;

    // Dédupliquer : si cet enregistrement est déjà en cours / déjà traité, on ignore
    const dedupKey = RecordingSid || CallSid;
    if (dedupKey && _processingKeys.has(dedupKey)) {
        console.warn(`⏭️ Doublon ignoré : ${dedupKey} déjà en cours de traitement.`);
        return;
    }
    if (dedupKey) {
        _processingKeys.add(dedupKey);
        // Nettoyage après 10 min pour éviter une fuite mémoire
        setTimeout(() => _processingKeys.delete(dedupKey), 10 * 60 * 1000);
    }
    
    // Remplacement de CallDuration par RecordingDuration (qui est présent dans le payload)
    const durationSeconds = parseInt(RecordingDuration, 10) || 0; 
    
    let cleanTo = (To || "").trim().replace(/\s+/g, "");
    if (!cleanTo.startsWith("+")) cleanTo = "+" + cleanTo;
    const garage = GARAGES[cleanTo];
    
    const callUniqueId = CallSid || RecordingSid || `no-sid-${Date.now()}`;

    if (!garage) {
        console.warn(`⚠️ Traitement annulé: Numéro Twilio inconnu après normalisation : '${cleanTo}'`);
        return;
    }

    // --- 1. Récupération des infos via API Twilio (si manquant) ---
    if ((!To || !From) && CallSid) {
        try {
            const call = await twilioClient.calls(CallSid).fetch();
            To = call.to;
            From = call.from;
        } catch (err) {
            console.warn("⚠️ Impossible de récupérer les infos via Twilio API :", err.message);
        }
    }

    // --- 2. Gestion des Appels Manqués (si pas d'enregistrement valide) ---
    const hasValidRecording = RecordingSid && durationSeconds > 3;

    if (!hasValidRecording) {
        console.log("📭 Appel Manqué / Silence détecté – envoi mail d’appel manqué");
        
        // ✔️ Historique des appels de cet appelant
        const history = getRecentCalls(From, garage.name)

        let historyHtml = "";
        if (history.length >= 1) {
            historyHtml = `
                <p><strong>Historique récent des appels de cet appelant :</strong></p>
                <ul>
                    ${history.map(h => {
                        const type = h.has_message ? "avec message" : "sans message";
                        return `<li>${toParisTime(h.created_at)} — ${type}</li>`;
                    }).join("")}
                </ul>
                <hr>
            `;
        }
        
        // Enrichir avec le carnet de contacts
        const missedContact = getContactByPhone(garage.name, From);
        let missedCallerHtml, missedSubject;
        if (missedContact?.source === "manual") {
            missedCallerHtml = `${escapeHtml(missedContact.name)} (${From})`;
            missedSubject = `📞 Appel manqué sans message de ${missedContact.name} (${From})`;
        } else if (missedContact?.source === "auto") {
            missedCallerHtml = `${escapeHtml(missedContact.name)} (${From}) <span style="font-size:0.85em;color:#999;">(à valider)</span>`;
            missedSubject = `📞 Appel manqué sans message de ${missedContact.name} - à valider (${From})`;
        } else {
            missedCallerHtml = escapeHtml(From);
            missedSubject = `📞 Appel manqué sans message de ${From}`;
        }

        await sgMail.send({
            to: garage.to_email,
            from: garage.from_email,
            subject: missedSubject,
            html: `
                <p><strong>Appelant :</strong> ${missedCallerHtml}</p>
                <p>Aucun message n’a été laissé (ou message vide).</p>
                ${historyHtml}
            `
        });

        saveCall({
            call_sid: RecordingSid || CallSid,
            from_number: From,
            to_number: To,
            start_time: new Date().toISOString(),
            end_time: new Date().toISOString(),
            duration: durationSeconds,
            status: "missed",
            has_message: 0,
            garage_id: garage.name
        });

        return;
    }

    let transcript = "(transcription indisponible)";
    let name = "(non spécifié)";
    let motive_legend = "(pas catégorisé)"; // 💡 MODIFICATION: Nouvelle variable pour la catégorie stricte
    let motive_details = "(à déterminer)"; // 💡 MODIFICATION: Variable pour le détail concis
    let date_preference = "Indéterminée";
    let is_urgent = false;
    let plate_number = null;

    try {
        // --- 3. Télécharger l’audio ---
        const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.ACCOUNT_SID}/Recordings/${RecordingSid}.mp3`;
        const audioRes = await axios.get(recordingUrl, {
            responseType: "arraybuffer",
            auth: { username: process.env.ACCOUNT_SID, password: process.env.AUTH_TOKEN },
            timeout: 10000,
        });
        const audioBuffer = Buffer.from(audioRes.data);
        console.log(`✅ Téléchargement audio réussi: ${RecordingSid}`);
        
        // --- 4. Transcription via Whisper (Réactivation de l'API OpenAI) ---
        try {
            const OpenAI = (await import('openai')).default;
            const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
            
            const form = new FormData();
            form.append('file', audioBuffer, { filename: `voicemail-${RecordingSid}.mp3`, contentType: 'audio/mpeg' });
            form.append('model', 'whisper-1');
            form.append('language', 'fr');
            form.append('response_format', 'text');
            
            // Utiliser axios pour l'appel à OpenAI car FormData fonctionne bien avec axios
            const sttRes = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
                headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
                maxBodyLength: Infinity,
                timeout: 40000,
            });
            
            transcript = (sttRes.data || '').toString().trim() || transcript;
            console.log("✅ Transcription Whisper réussie:", transcript);

        } catch (e) {
            transcript = `(échec transcription: ${e?.message || 'inconnue'})`;
            console.error("❌ Erreur Whisper:", e.message);
        }

        // --- 5. Analyse du texte via GPT (CLÉ DE L'AMÉLIORATION) ---
        // On récupère l'objet complet d'analyse GPT
        const gptAnalysis = await extractInfoGPT(transcript);
        
        name = gptAnalysis.name;
        motive_legend = gptAnalysis.motive_legend; // 💡 MODIFICATION: Assignation de la catégorie stricte
        motive_details = gptAnalysis.motive_details; // 💡 MODIFICATION: Assignation du détail
        date_preference = gptAnalysis.date_preference;
        is_urgent = gptAnalysis.is_urgent;
        plate_number = gptAnalysis.plate_number;

        // --- 6. Construction et Envoi d’Email ---
        const fromPhone = normalizePhone(From);
        const priorityTag = is_urgent ? "🚨 URGENT" : "";
        const tagLine = [priorityTag].filter(Boolean).join(" ");

        // Enrichir le nom avec le carnet de contacts (priorité sur le nom GPT)
        const voiceContact = getContactByPhone(garage.name, From);
        let callerDisplayText, callerDisplayHtml;
        if (voiceContact?.source === "manual") {
            callerDisplayText = `${voiceContact.name} (${fromPhone})`;
            callerDisplayHtml = `${escapeHtml(voiceContact.name)} (${fromPhone})`;
        } else if (voiceContact?.source === "auto") {
            callerDisplayText = `${voiceContact.name} - a valider (${fromPhone})`;
            callerDisplayHtml = `${escapeHtml(voiceContact.name)} (${fromPhone}) <span style="font-size:0.85em;color:#999;">(a valider)</span>`;
        } else {
            callerDisplayText = `${name} (${fromPhone})`;
            callerDisplayHtml = `${escapeHtml(name)} (${fromPhone})`;
        }

        const subject = `📞 [${motive_legend.toUpperCase()}] ${callerDisplayText} - ${date_preference} ${tagLine ? "· " + tagLine : ""}`;

        const summaryLines = [
            priorityTag && `**${priorityTag}**`,
            `**Catégorie :** ${motive_legend}`,
            `**Motif détaillé :** ${motive_details}`,
            `**Date souhaitée :** ${date_preference}`,
            // Ligne Appelant gérée séparément (HTML enrichi)
            plate_number && `**Immatriculation :** ${plate_number}`,
            `—`,
            `Rappel rapide recommandé.`,
        ].filter(Boolean);

        // --- 🔍 Historique des appels récents (7 jours) ---
        const history = getRecentCalls(From, garage.name)

        let historyHtml = "";
        if (history.length >= 1) {
            historyHtml = `
                <p><strong>Historique récent des appels de cet appelant :</strong></p>
                <ul>
                    ${history.map(h => {
                        const type = h.has_message ? "avec message" : "sans message";
                        return `<li>${toParisTime(h.created_at)} — ${type}</li>`;
                    }).join("")}
                </ul>
                <hr>
            `;
        }

        const html = `
            <div style="font-family: Arial, sans-serif; line-height:1.6; color:#222; font-size:15px; max-width:600px;">
                ${summaryLines.map(l => {
                    if (l === "—") return '<hr style="border:none;border-top:1px solid #ddd;margin:12px 0;">';
                    const clean = escapeHtml(l.replace(/\*\*/g, ''));
                    const match = clean.match(/^([^:]+):\s*(.*)/);
                    if (match) {
                        return `<p style="margin:0 0 4px 0;"><strong>${match[1]}:</strong> ${match[2]}</p>`;
                    }
                    return `<p style="margin:0 0 4px 0;"><strong>${clean}</strong></p>`;
                }).join('')}
                <p style="margin:0 0 4px 0;"><strong>Appelant :</strong> ${callerDisplayHtml}</p>
                <p style="margin:14px 0 4px 0;"><strong>Transcription :</strong></p>
                <p style="margin:0; padding-left:10px; border-left:3px solid #ccc;">
                    ${escapeHtml(transcript).replace(/\n+/g, '<br>').replace(/([.?!])\s/g, '$1&nbsp;')}
                </p>
                ${historyHtml}
            </div>
        `;

        await sgMail.send({
            to: garage.to_email,
            from: garage.from_email,
            subject,
            html,
            attachments: [
                {
                    content: audioBuffer.toString("base64"),
                    filename: `voicemail-${RecordingSid}.mp3`,
                    type: "audio/mpeg",
                    disposition: 'attachment',
                },
            ],
        });

        console.log(`✅ Email envoyé à ${garage.to_email}`);
        
        // --- 7. Sauvegarder l’appel ---
        saveCall({
            call_sid: callUniqueId,
            from_number: From,
            to_number: To,
            start_time: new Date().toISOString(),
            end_time: new Date().toISOString(),
            duration: durationSeconds, // Utilise la durée convertie
            status: CallStatus || "processed",
            has_message: RecordingSid ? 1 : 0,
            garage_id: garage.name || "garage_inconnu"
        });

        // --- 8. Sauvegarder en BDD ---
        // 🚨 BRIQUE MANQUANTE AJOUTÉE ICI 🚨
        saveMessage({
            call_sid: callUniqueId,
            garage_id: garage.name,
            from_number: From,
            transcript: transcript,
            analysis: JSON.stringify(gptAnalysis),
            sent_at: new Date().toISOString()
        });

        // --- 9. Mise à jour automatique du carnet de contacts ---
        upsertAutoContact(garage.name, From, name);

        // --- 10. SUPPRESSION RGPD DE L'ENREGISTREMENT ---
        try {
            await twilioClient.recordings(RecordingSid).remove();
            console.log(`✅ Enregistrement Twilio ${RecordingSid} supprimé pour des raisons RGPD.`);
        } catch (err) {
            console.warn(`⚠️ ERREUR: Impossible de supprimer l'enregistrement ${RecordingSid} sur Twilio:`, err.message);
        }

    } catch (err) {
        console.error("💥 Erreur serveur pendant le traitement lourd:", err.message);
        logServerError("processVoicemail", err.message, err.stack);
        try {
            await sgMail.send({
                to: "cbecker.piaf@gmail.com",
                from: "louis.becker@student-cs.fr",
                subject: "🚨 PitCall — Erreur serveur",
                html: `<p><strong>Route :</strong> processVoicemail</p><p><strong>Message :</strong> ${err.message}</p><pre style="font-size:12px;color:#666;">${err.stack}</pre>`
            });
        } catch {}
    }
}


// --- ROUTE PRINCIPALE TWILIO : Réponse Immédiate (Asynchrone) ---
app.post("/email-voicemail", async (req, res) => {
    // 💡 Simplification du parsing : req.body est déjà l'objet POST de Twilio
    const payload = req.body; 
    
    // Vous pouvez garder cette ligne pour le debug
    console.log("📩 Corps Twilio reçu et décodé :", payload); 

        // --- 🔥 FILTRE PAYS ET ENREGISTREMENT DB APPELS BLOQUÉS ---
    const callerCountry = payload.CallerCountry || payload.FromCountry || null;
    const fromNumber = payload.From || payload.Caller || "inconnu";
    const toNumber = payload.To || "inconnu";
    const callSid = payload.CallSid || `blocked-${Date.now()}`;

    // Si pas FR → on bloque et on stocke en BDD comme "appel d'un autre pays"
    if (callerCountry && callerCountry !== "FR") {

        console.warn(`🚫 Appel bloqué (pays = ${callerCountry}) depuis ${fromNumber}`);

        // 🔄 Récupération du garage (même logique que partout ailleurs)
        let cleanTo = (toNumber || "").trim().replace(/\s+/g, "");
        if (!cleanTo.startsWith("+")) cleanTo = "+" + cleanTo;
        const garage = GARAGES[cleanTo];

        if (garage) {
            // 🔥 Sauvegarde BDD sans changer la structure
            saveCall({
                call_sid: callSid,
                from_number: fromNumber,
                to_number: toNumber,
                start_time: new Date().toISOString(),
                end_time: new Date().toISOString(),
                duration: 0,
                status: `blocked_${callerCountry}`,   // ⚠️ NE CHANGE PAS LA STRUCTURE
                has_message: 0,
                garage_id: garage.name
            });
        }

        // ➜ On répond à Twilio et on stoppe ici
        res.type('text/xml');
        return res.send('<Response><Hangup/></Response>');
    }

    // 🚨 CLÉ DE LA ROBUSTESSE : Réponse IMMÉDIATE à Twilio avec TwiML de Raccrochage
    // Twilio attend un TwiML (XML) en réponse à l'action Record.
    res.type('text/xml');
    res.send('<Response><Hangup/></Response>');

    // 🚀 Déclenchement Asynchrone : On lance le travail lourd sans bloquer la route
    processVoicemail(payload).catch(err =>
        console.error("💥 Erreur non gérée dans processVoicemail:", err.message)
    );

    // La route se termine ici immédiatement.
});


// --------------------------------------------------------------------------------
// --- AJOUT DES ROUTES UTILITAIRES (Pour la surveillance et l'exportation) ---
// --------------------------------------------------------------------------------

// Route d'accueil simple
app.get("/", (req, res) => {
    res.send("🤖 Serveur Voicemail Assistant en ligne et opérationnel.");
});

// Route de santé (Health Check) pour Azure App Service
app.get("/health", (req, res) => {
    // Un simple test pour vérifier que l'App Service est en vie
    res.status(200).json({ status: "ok", service: "voicemail-assistant" });
});

// Route d'exportation des données (pour le débogage ou l'analyse)
app.get("/export", (req, res) => {
    const secret = process.env.EXPORT_SECRET;
    if (!secret || req.query.key !== secret) {
        return res.status(401).json({ error: "Non autorisé." });
    }
    try {
        const calls = getAllCalls();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename="calls_export.json"');
        res.status(200).send(JSON.stringify(calls, null, 2));
    } catch (error) {
        console.error("Erreur lors de l'exportation des données:", error);
        res.status(500).send("Erreur interne lors de l'exportation.");
    }
});

// --------------------------------------------------------------------------------
// --- FIN DES ROUTES UTILITAIRES ---
// --------------------------------------------------------------------------------


// --- ROUTE PUBLIQUE : statut du garage (appelée par le Studio Flow Twilio) ---
app.get("/twiml/status", (req, res) => {
    let to = (req.query.to || "").trim().replace(/\s+/g, "");
    if (!to.startsWith("+")) to = "+" + to;
    const garage = GARAGES[to];
    if (!garage) return res.status(404).json({ error: "Garage inconnu" });
    const settings = getGarageSettings(garage.name);
    res.json({
        is_closed: settings.is_closed ? 1 : 0,
        closed_message: settings.closed_message || "Le garage est actuellement fermé. Merci de rappeler pendant nos horaires d'ouverture."
    });
});


// --- NOUVELLE ROUTE : GESTION DES CHANGEMENTS DE STATUT D'APPEL ---
app.post("/missed-call-email", async (req, res) => {
    // 1. Réponse immédiate à Twilio pour éviter les timeouts
    res.json({ received: true }); 

    const payload = req.body;
    const { CallSid, CallStatus, From, To } = payload;

    // --- 🔥 FILTRE PAYS POUR LES APPELS SANS MESSAGE (SPAM) ---
    const callerCountry = payload.CallerCountry || payload.FromCountry || null;

    if (callerCountry && callerCountry !== "FR") {
        console.warn(`🚫 [Missed-Call] Appel étranger bloqué (${callerCountry}) depuis ${From}`);

        // Trouver le garage associé au numéro Twilio
        let cleanTo = (To || "").trim().replace(/\s+/g, "");
        if (!cleanTo.startsWith("+")) cleanTo = "+" + cleanTo;
        const garage = GARAGES[cleanTo];

        if (garage) {
            // 🔥 On logue l'appel dans la BDD avec la structure existante
            saveCall({
                call_sid: CallSid || `blocked-missed-${Date.now()}`,
                from_number: From,
                to_number: To,
                start_time: new Date().toISOString(),
                end_time: new Date().toISOString(),
                duration: 0,
                status: `blocked_${callerCountry}`, // ⚠️ On n'ajoute aucun champ
                has_message: 0,
                garage_id: garage.name
            });
        }

        // On arrête ici → pas d'email, pas de traitement
        return;
    }

    
    // Nous ne traitons que les statuts de fin d'appel
    if (!['completed', 'no-answer', 'busy', 'failed'].includes(CallStatus)) {
        return; 
    }

    try {
        // Chercher la configuration du garage (nécessaire pour l'email)
        let cleanTo = (To || "").trim().replace(/\s+/g, "");
        if (!cleanTo.startsWith("+")) cleanTo = "+" + cleanTo;
        const garage = GARAGES[cleanTo];

        if (!garage) {
            console.warn(`⚠️ [Status Update] Numéro Twilio inconnu : '${cleanTo}'`);
            return;
        }

        // Vérifier via l'API Twilio si un enregistrement existe pour ce CallSid.
        // Si un enregistrement existe, le mail a été envoyé par processVoicemail (/email-voicemail), donc on ignore.
        const recordings = await twilioClient.recordings.list({ callSid: CallSid, limit: 1 });
        
        if (recordings && recordings.length > 0) {
            console.log(`ℹ️ [Status Update] Enregistrement trouvé pour ${CallSid}. Déjà traité par la route /email-voicemail. Ignoré.`);
            return;
        }
        
        // Si aucun enregistrement n'est trouvé, c'est un vrai appel manqué sans message.
        console.log(`📭 [Status Update] Appel manqué sans message (raccrochage précoce) détecté pour ${CallSid}. Envoi email.`);

        // --- 🔍 Historique des appels récents (7 jours) ---
        const history = getRecentCalls(From, garage.name)

        let historyHtml = "";
        if (history.length >= 1) {
            historyHtml = `
                <p><strong>Historique récent des appels de cet appelant :</strong></p>
                <ul>
                    ${history.map(h => {
                        const type = h.has_message ? "avec message" : "sans message";
                        return `<li>${toParisTime(h.created_at)} — ${type}</li>`;
                    }).join("")}
                </ul>
                <hr>
            `;
        }

        // Envoi de l'email d'appel manqué
        await sgMail.send({
            to: garage.to_email,
            from: garage.from_email,
            subject: `📞 Appel manqué sans message de ${From}`,
            html: `
                <p><strong>Appelant :</strong> ${From}</p>
                <p>Aucun message n’a été laissé.</p>
                ${historyHtml}
            `
        });

        // 👉 AJOUT ICI : Sauvegarder l’appel manqué en DB
        saveCall({
            call_sid: CallSid,
            from_number: From,
            to_number: To,
            start_time: new Date().toISOString(),
            end_time: new Date().toISOString(),
            duration: 0,
            status: "missed",
            has_message: 0,
            garage_id: garage.name
        });

    } catch (err) {
        console.error("❌ Erreur dans le traitement de l'état de l'appel:", err.message);
    }
});

// --- TwiML dynamique pour les garages auto-provisionnés ---
app.get("/twiml/record", (req, res) => {
  let to = (req.query.To || req.query.to || "").trim().replace(/\s+/g, "");
  if (!to.startsWith("+")) to = "+" + to;
  const garage = GARAGES[to];

  res.type("text/xml");

  if (!garage) {
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say language="fr-FR">Ce numéro n'est pas configuré. Veuillez rappeler directement le garage.</Say><Hangup/></Response>`);
  }

  const settings = getGarageSettings(garage.name);
  const garageName = garage.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  if (settings.is_closed) {
    const msg = (settings.closed_message || "Le garage est actuellement fermé. Merci de rappeler pendant nos horaires d'ouverture.")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say language="fr-FR">${msg}</Say><Hangup/></Response>`);
  }

  const PUBLIC_SERVER_URL = process.env.PUBLIC_SERVER_URL || "https://app.pitcall.fr";
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="fr-FR">Bonjour, vous avez bien joint ${garageName}. Merci de nous laisser votre message après le bip. Nous vous rappellerons dans les meilleurs délais.</Say>
  <Record action="${PUBLIC_SERVER_URL}/email-voicemail" method="POST" maxLength="120" playBeep="true" trim="trim-silence" recordingStatusCallback="${PUBLIC_SERVER_URL}/email-voicemail" recordingStatusCallbackMethod="POST" />
  <Say language="fr-FR">Nous n'avons pas reçu de message. Merci de rappeler. Au revoir.</Say>
</Response>`);
});

// --- Route de récupération des enregistrements manqués (usage unique, supprimée après) ---
app.get("/api/recover-recordings", async (req, res) => {
    if (req.query.token !== process.env.AUTH_TOKEN) {
        return res.status(403).send("Accès refusé.\n");
    }

    const dryRun   = req.query.dry === "1";
    const noDelete = req.query.nodelete === "1";
    const DATE_FROM = new Date("2026-06-13T00:00:00Z");
    const DATE_TO   = new Date();

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("X-Accel-Buffering", "no");

    const log = (msg) => { res.write(msg + "\n"); };

    log(`=== Récupération enregistrements Twilio ===`);
    log(`Période : ${DATE_FROM.toLocaleDateString("fr-FR")} → ${DATE_TO.toLocaleDateString("fr-FR")}`);
    log(`Mode    : ${dryRun ? "DRY-RUN" : "INSERTION BDD"}`);
    log(`RGPD    : ${noDelete ? "conservation Twilio" : "suppression après traitement"}`);
    log(``);

    let recordings;
    try {
        recordings = await twilioClient.recordings.list({ dateCreatedAfter: DATE_FROM, dateCreatedBefore: DATE_TO, limit: 1000 });
    } catch (err) {
        log(`ERREUR API Twilio : ${err.message}`);
        return res.end();
    }

    if (recordings.length === 0) {
        log("Aucun enregistrement trouvé sur Twilio pour cette période.");
        return res.end();
    }

    log(`${recordings.length} enregistrement(s) trouvé(s) :\n`);

    const toSQLite = (d) => d.toISOString().replace("T", " ").substring(0, 19);

    let nouveaux = 0;
    for (const rec of recordings) {
        const sid  = rec.callSid || rec.sid;
        const deja = !!db.prepare("SELECT 1 FROM calls WHERE call_sid = ? LIMIT 1").get(sid)
                  || !!db.prepare("SELECT 1 FROM calls WHERE call_sid = ? LIMIT 1").get(rec.sid);
        const garage = GARAGES[rec.to || ""];
        const date = new Date(rec.dateCreated).toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
        const flag = deja ? "[deja en BDD]" : "[a traiter ]";
        if (!deja) nouveaux++;
        log(`  ${flag} ${date} | ${rec.from} → ${rec.to} | ${rec.duration}s | ${garage?.name || "inconnu"} | ${rec.sid}`);
    }

    log(`\n${nouveaux} nouveau(x) à insérer.`);

    if (dryRun || nouveaux === 0) {
        log(dryRun ? "\nDry-run terminé. Relancez sans ?dry=1 pour insérer." : "\nRien à faire.");
        return res.end();
    }

    log(`\n--- Début du traitement ---\n`);

    let ok = 0, skipped = 0, failed = 0;

    for (const rec of recordings) {
        const RecordingSid = rec.sid;
        const CallSid      = rec.callSid || rec.sid;
        const From         = rec.from;
        const To           = rec.to;
        const duration     = parseInt(rec.duration, 10) || 0;
        const callDate     = new Date(rec.dateCreated);
        const sqliteDate   = toSQLite(callDate);
        const isoDate      = callDate.toISOString();

        const deja = !!db.prepare("SELECT 1 FROM calls WHERE call_sid = ? LIMIT 1").get(CallSid)
                  || !!db.prepare("SELECT 1 FROM calls WHERE call_sid = ? LIMIT 1").get(RecordingSid);
        if (deja) { skipped++; continue; }

        const garage = GARAGES[To || ""];
        if (!garage) { log(`[${RecordingSid}] Numéro ${To} inconnu — ignoré`); skipped++; continue; }

        const dateLabel = callDate.toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
        log(`[${ok + failed + 1}/${nouveaux}] ${dateLabel} | ${From} | ${garage.name} | ${duration}s`);

        if (duration <= 3) {
            db.prepare(`INSERT OR IGNORE INTO calls (call_sid, from_number, to_number, start_time, end_time, duration, status, has_message, garage_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
              .run(RecordingSid, From, To, isoDate, isoDate, duration, "missed", 0, garage.name, sqliteDate);
            log(`  -> Appel manqué inséré`);
            ok++; continue;
        }

        try {
            const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.ACCOUNT_SID}/Recordings/${RecordingSid}.mp3`;
            const audioRes = await axios.get(recordingUrl, {
                responseType: "arraybuffer",
                auth: { username: process.env.ACCOUNT_SID, password: process.env.AUTH_TOKEN },
                timeout: 15000,
            });
            const audioBuffer = Buffer.from(audioRes.data);
            log(`  -> Audio OK (${Math.round(audioBuffer.length / 1024)} KB)`);

            let transcript = "(transcription indisponible)";
            try {
                const OpenAI = (await import("openai")).default;
                const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                const form = new FormData();
                form.append("file", audioBuffer, { filename: `${RecordingSid}.mp3`, contentType: "audio/mpeg" });
                form.append("model", "whisper-1");
                form.append("language", "fr");
                form.append("response_format", "text");
                const sttRes = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
                    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
                    maxBodyLength: Infinity, timeout: 40000,
                });
                transcript = (sttRes.data || "").toString().trim() || transcript;
                log(`  -> Transcription : "${transcript.substring(0, 80)}${transcript.length > 80 ? "..." : ""}"`);
            } catch (e) {
                log(`  -> Whisper échoué : ${e.message}`);
                transcript = `(échec transcription: ${e?.message || "inconnue"})`;
            }

            const gpt = await extractInfoGPT(transcript);
            log(`  -> GPT : ${gpt.motive_legend} | urgent: ${gpt.is_urgent}`);

            db.prepare(`INSERT OR IGNORE INTO calls (call_sid, from_number, to_number, start_time, end_time, duration, status, has_message, garage_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
              .run(CallSid, From, To, isoDate, isoDate, duration, "processed", 1, garage.name, sqliteDate);
            db.prepare(`INSERT INTO messages (call_sid, garage_id, from_number, transcript, analysis, sent_at, created_at) VALUES (?,?,?,?,?,?,?)`)
              .run(CallSid, garage.name, From, transcript, JSON.stringify(gpt), isoDate, sqliteDate);
            upsertAutoContact(garage.name, From, gpt.name);
            log(`  -> Inséré en BDD (created_at = ${sqliteDate})`);

            if (!noDelete) {
                try { await twilioClient.recordings(RecordingSid).remove(); log(`  -> Supprimé de Twilio`); }
                catch (e) { log(`  -> Suppression Twilio échouée : ${e.message}`); }
            }

            ok++;
        } catch (err) {
            log(`  -> ERREUR : ${err.message}`);
            failed++;
        }

        await new Promise(r => setTimeout(r, 600));
    }

    log(`\n=== Terminé : ${ok} insérés, ${skipped} ignorés, ${failed} erreurs ===`);
    res.end();
});

// --- Handler d'erreurs Express global ---
app.use(async (err, req, res, next) => {
    console.error("💥 Erreur Express non gérée:", err.message);
    logServerError(req.path, err.message, err.stack);
    try {
        await sgMail.send({
            to: "cbecker.piaf@gmail.com",
            from: "louis.becker@student-cs.fr",
            subject: "🚨 PitCall — Erreur serveur",
            html: `<p><strong>Route :</strong> ${req.method} ${req.path}</p><p><strong>Message :</strong> ${err.message}</p><pre style="font-size:12px;color:#666;">${err.stack}</pre>`
        });
    } catch {}
    if (!res.headersSent) res.status(500).json({ error: "Erreur interne." });
});

// ✅ Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur voicemail en ligne sur le port ${PORT}`));