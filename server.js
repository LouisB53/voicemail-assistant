// server.js (Code COMPLET refactorisé et finalisé)

import express from "express";
import axios from "axios";
import FormData from "form-data";
import sgMail from "@sendgrid/mail";
import fs from "fs";
import dotenv from "dotenv";
// Import de l'extracteur GPT et des utilitaires nécessaires
import { extractInfoGPT } from "./utils/gpt-extractor.js"; 
import { saveCall, saveMessage, getAllCalls } from "./db.js"; // Assurez-vous que la BDD est accessible
import { escapeHtml, normalizePhone } from "./utils/extractors.js";
import Twilio from "twilio"; // Ajout de Twilio pour la gestion API

dotenv.config();

const BCC_MONITOR = "louis.becker0503@gmail.com";

const app = express();

// Configuration Twilio
const twilioClient = Twilio(process.env.ACCOUNT_SID, process.env.AUTH_TOKEN);

// Middleware pour accepter tous les formats Twilio
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.text({ type: "*/*" }));

// --- DÉBUT DU BLOC MODIFIÉ POUR LA SÉCURITÉ ET AZURE APP SERVICE ---

// Charger la configuration des garages (priorité à la variable d'environnement Azure pour la sécurité)
let GARAGES;
const configString = process.env.GARAGES_CONFIG;

if (configString) {
    try {
        GARAGES = JSON.parse(configString);
        console.log("✅ Configuration des garages chargée depuis la variable d'environnement Azure.");
    } catch (error) {
        console.error("❌ ERREUR: Impossible de parser la variable GARAGES_CONFIG. Utilisation du fichier local.", error);
        // Fallback si le JSON est mal formaté (utile pour les tests locaux)
        GARAGES = JSON.parse(fs.readFileSync("./garages.json", "utf-8")); 
    }
} else {
    // Si la variable n'existe pas (par exemple, en développement local), utilise le fichier.
    console.warn("⚠️ Variable GARAGES_CONFIG non trouvée. Utilisation du fichier local garages.json.");
    GARAGES = JSON.parse(fs.readFileSync("./garages.json", "utf-8"));
}

// Configurer SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_SECRET);

// --- FIN DU BLOC MODIFIÉ ---

/**
 * ⚙️ Fonction de Traitement Lourd Asynchrone (Whisper, GPT, Email)
 * Cette fonction est appelée sans "await" par la route Twilio.
 */
async function processVoicemail(payload) {
    let { RecordingSid, From, To, CallSid, CallStatus, RecordingDuration } = payload;
    
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

    // --- 2. Sauvegarder l’appel ---
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

    // --- 3. Gestion des Appels Manqués (si pas d'enregistrement valide) ---
    const hasValidRecording = RecordingSid && durationSeconds > 3;

    if (!hasValidRecording) {
        console.log("📭 Appel Manqué / Silence détecté – envoi mail d’appel manqué");
        await sgMail.send({
            to: garage.to_email,
            bcc: BCC_MONITOR,
            from: garage.from_email,
            subject: `📞 Appel manqué sans message de ${From}`,
            html: `
                <p><strong>Appelant :</strong> ${From}</p>
                <p><strong>Numéro Twilio :</strong> ${To}</p>
                <p>Aucun message n’a été laissé (ou message vide).</p>
            `
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
        // --- 4. Télécharger l’audio ---
        const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.ACCOUNT_SID}/Recordings/${RecordingSid}.mp3`;
        const audioRes = await axios.get(recordingUrl, {
            responseType: "arraybuffer",
            auth: { username: process.env.ACCOUNT_SID, password: process.env.AUTH_TOKEN },
            timeout: 10000,
        });
        const audioBuffer = Buffer.from(audioRes.data);
        console.log(`✅ Téléchargement audio réussi: ${RecordingSid}`);
        
        // --- 5. Transcription via Whisper (Réactivation de l'API OpenAI) ---
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

        // --- 6. Analyse du texte via GPT (CLÉ DE L'AMÉLIORATION) ---
        // On récupère l'objet complet d'analyse GPT
        const gptAnalysis = await extractInfoGPT(transcript);
        
        name = gptAnalysis.name;
        motive_legend = gptAnalysis.motive_legend; // 💡 MODIFICATION: Assignation de la catégorie stricte
        motive_details = gptAnalysis.motive_details; // 💡 MODIFICATION: Assignation du détail
        date_preference = gptAnalysis.date_preference;
        is_urgent = gptAnalysis.is_urgent;
        plate_number = gptAnalysis.plate_number;

        // --- 7. Construction et Envoi d’Email ---
        const fromPhone = normalizePhone(From);
        const priorityTag = is_urgent ? "🚨 URGENT" : "";
        const tagLine = [priorityTag].filter(Boolean).join(" ");

        // Utilisation de motive_legend dans l'objet et motive_details dans l'en-tête
        // 💡 MODIFICATION: Utilisation de motive_legend dans le sujet pour la catégorisation stricte
        const subject = `📞 [${motive_legend.toUpperCase()}] ${name} (${fromPhone}) - ${date_preference} ${tagLine ? "· " + tagLine : ""}`;

        const summaryLines = [
            priorityTag && `**${priorityTag}**`, // Affiche l'urgence si nécessaire
            `**Catégorie :** ${motive_legend}`, // 💡 MODIFICATION: Afficher la catégorie stricte
            `**Motif détaillé :** ${motive_details}`, // Afficher les détails concis
            `**Date souhaitée :** ${date_preference}`,
            `**Appelant :** ${name} (${fromPhone})`,
            plate_number && `**Immatriculation :** ${plate_number}`,
            `—`,
            `Rappel rapide recommandé.`,
        ].filter(Boolean);

        const html = `
            <div style="font-family: Arial, sans-serif; line-height:1.6; color:#222; font-size:15px; max-width:600px;">
                ${summaryLines.map(l => {
                    if (l === "—") return '<hr style="border:none;border-top:1px solid #ddd;margin:12px 0;">';
                    const clean = escapeHtml(l.replace(/\*\*/g, ''));
                    // Logique pour mettre en gras le titre de chaque ligne (ex: "Catégorie :")
                    const match = clean.match(/^([^:]+):\s*(.*)/);
                    if (match) {
                        return `<p style="margin:0 0 4px 0;"><strong>${match[1]}:</strong> ${match[2]}</p>`;
                    }
                    return `<p style="margin:0 0 4px 0;"><strong>${clean}</strong></p>`;
                }).join('')}
                <p style="margin:14px 0 4px 0;"><strong>Transcription :</strong></p>
                <p style="margin:0; padding-left:10px; border-left:3px solid #ccc;">
                    ${escapeHtml(transcript).replace(/\n+/g, '<br>').replace(/([.?!])\s/g, '$1&nbsp;')}
                </p>
            </div>
        `;

        await sgMail.send({
            to: garage.to_email,
            bcc: BCC_MONITOR,
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
        
        // --- 8. Sauvegarder en BDD ---
        // 🚨 BRIQUE MANQUANTE AJOUTÉE ICI 🚨
        saveMessage({
            call_sid: callUniqueId,
            garage_id: garage.name,
            from_number: From,
            transcript: transcript,
            // 💡 MODIFICATION: Sauvegarde de l'objet gptAnalysis complet et mis à jour
            analysis: JSON.stringify(gptAnalysis),
            sent_at: new Date().toISOString()
        });

        // --- 9. SUPPRESSION RGPD DE L'ENREGISTREMENT ---
        try {
            await twilioClient.recordings(RecordingSid).remove();
            console.log(`✅ Enregistrement Twilio ${RecordingSid} supprimé pour des raisons RGPD.`);
        } catch (err) {
            console.warn(`⚠️ ERREUR: Impossible de supprimer l'enregistrement ${RecordingSid} sur Twilio:`, err.message);
        }

    } catch (err) {
        console.error("💥 Erreur serveur pendant le traitement lourd:", err.message);
        // Alertes ici
    }
}


// --- ROUTE PRINCIPALE TWILIO : Réponse Immédiate (Asynchrone) ---
app.post("/email-voicemail", async (req, res) => {
    // 💡 Simplification du parsing : req.body est déjà l'objet POST de Twilio
    const payload = req.body; 
    
    // Vous pouvez garder cette ligne pour le debug
    console.log("📩 Corps Twilio reçu et décodé :", payload); 

    // 🚨 CLÉ DE LA ROBUSTESSE : Réponse IMMÉDIATE à Twilio avec TwiML de Raccrochage
    // Twilio attend un TwiML (XML) en réponse à l'action Record.
    res.type('text/xml');
    res.send('<Response><Hangup/></Response>');

    // 🚀 Déclenchement Asynchrone : On lance le travail lourd sans bloquer la route
    processVoicemail(payload);
    
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
app.get("/export", async (req, res) => {
    try {
        const calls = await getAllCalls(); // Assurez-vous que cette fonction est implémentée dans db.js
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


// --- ROUTE TWIML POUR ENREGISTREMENT FIABLE ---
app.post("/twiml/voicemail/:to", async (req, res) => {
    try {
        const to = decodeURIComponent(req.params.to);
        const garage = GARAGES[to];

        if (!garage) {
            console.warn(`⚠️ Numéro Twilio inconnu pour route TwiML : ${to}`);
            return res.type("text/xml").send(`<Response><Say>Numéro de garage inconnu. Merci de réessayer plus tard.</Say></Response>`);
        }

        // 💡 Assurez-vous que cette URL est l'adresse publique de la route ASYNCHRONE !
        const callbackUrl = process.env.PUBLIC_SERVER_URL + "/email-voicemail"; 

        res.type("text/xml");
        res.send(`
            <Response>
                <Say language="fr-FR" voice="alice">Merci, laissez votre message après le bip.</Say>
                <Record
                    maxLength="120"
                    playBeep="true"
                    trim="trim-silence"
                    action="${callbackUrl}"
                    method="POST"
                />
                <Say language="fr-FR" voice="alice">Au revoir.</Say>
                <Hangup/>
            </Response>
        `);
    } catch (err) {
        console.error("💥 Erreur dans /twiml/voicemail :", err.message);
        res.type("text/xml").send(`<Response><Say>Erreur interne, désolé.</Say></Response>`);
    }
});

// --- NOUVELLE ROUTE : GESTION DES CHANGEMENTS DE STATUT D'APPEL ---
app.post("/missed-call-email", async (req, res) => {
    // 1. Réponse immédiate à Twilio pour éviter les timeouts
    res.json({ received: true }); 

    const payload = req.body;
    const { CallSid, CallStatus, From, To } = payload;
    
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
        
        // Envoi de l'email d'appel manqué
        await sgMail.send({
            to: garage.to_email,
            bcc: BCC_MONITOR,
            from: garage.from_email,
            subject: `📞 Appel manqué sans message de ${From}`,
            html: `
                <p><strong>Appelant :</strong> ${From}</p>
                <p>Aucun message n’a été laissé.</p>
            `
        });

    } catch (err) {
        console.error("❌ Erreur dans le traitement de l'état de l'appel:", err.message);
    }
});

// ✅ Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur voicemail en ligne sur le port ${PORT}`));