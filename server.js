// server.js
import express from "express";
import axios from "axios";
import FormData from "form-data";
import sgMail from "@sendgrid/mail";
import fs from "fs";
import dotenv from "dotenv";
import { extractInfoFr, extractNameFr, detectPriority, escapeHtml, normalizePhone } from "./utils/extractors.js";
import { saveCall, saveMessage, getAllCalls } from "./db.js";

dotenv.config();

const BCC_MONITOR = "louis.becker0503@gmail.com";

const app = express();

// ✅ Middleware pour accepter tous les formats Twilio (form, json, texte brut)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.text({ type: "*/*" })); // important pour Twilio

// Charger la configuration des garages
const GARAGES = JSON.parse(fs.readFileSync("./garages.json", "utf-8"));

// Configurer SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_SECRET);

// ✅ Route principale : reçoit les notifications Twilio
app.post("/email-voicemail", async (req, res) => {
  let raw = req.body;
  if (typeof raw !== "string") raw = raw?.body || "";
  const normalized = raw.replace(/\n/g, "&").trim();
  const payload = Object.fromEntries(new URLSearchParams(normalized));

  console.log("📩 Corps Twilio reçu et décodé :", payload);

  // 🧠 Étape de rattrapage Twilio — certains callbacks manquent les champs To/From
  let { RecordingSid, From, To, CallSid, CallStatus, CallDuration } = payload;

  // Si Twilio a oublié d’envoyer To/From (souvent le cas quand l’appelant raccroche), on va les récupérer via l’API
  if ((!To || !From) && CallSid) {
    try {
      console.log("🔍 Tentative de récupération des infos d’appel via l’API Twilio...");
      const twilioRes = await axios.get(
        `https://api.twilio.com/2010-04-01/Accounts/${process.env.ACCOUNT_SID}/Calls/${CallSid}.json`,
        {
          auth: { username: process.env.ACCOUNT_SID, password: process.env.AUTH_TOKEN },
        }
      );

      // Twilio renvoie les vrais numéros dans la réponse JSON
      To = twilioRes.data.to;
      From = twilioRes.data.from;

      console.log(`✅ Infos d’appel récupérées depuis Twilio : From=${From}, To=${To}`);
    } catch (err) {
      console.warn("⚠️ Impossible de récupérer les infos via Twilio API :", err.message);
    }
  }

  // Si après récupération il manque toujours le numéro destinataire, on ignore proprement
  if (!To) {
    console.debug("↩️ Requête Twilio ignorée (aucun numéro destinataire trouvé).");
    return res.status(204).end();
  }

  // ✅ Normalisation du numéro Twilio
  let cleanTo = (To || "").trim().replace(/\s+/g, "");
  if (!cleanTo.startsWith("+")) cleanTo = "+" + cleanTo;

  const garage = GARAGES[cleanTo];
  if (!garage) {
    console.warn(`⚠️ Numéro Twilio inconnu après normalisation : '${cleanTo}'`);
    return res.status(400).json({ error: "Numéro Twilio inconnu" });
  }

  console.log(`📞 Nouveau message pour ${garage.name} (${To}) de ${From}`);

  try {
    // ✅ Étape 1 : Sauvegarder l’appel (même sans message)
    saveCall({
      call_sid: CallSid || RecordingSid || `no-sid-${Date.now()}`,
      from_number: From,
      to_number: To,
      start_time: new Date().toISOString(),
      end_time: null,
      duration: CallDuration ? parseInt(CallDuration) : null,
      status: CallStatus || "received",
      has_message: RecordingSid ? 1 : 0,
      garage_id: garage.name || "garage_inconnu"
    });

    // ✅ Cas 1 : Aucun message laissé
    if (!RecordingSid) {
      console.log("📭 Aucun message enregistré – envoi mail d’appel manqué");
      await sgMail.send({
        to: garage.to_email,
        bcc: BCC_MONITOR,
        from: garage.from_email,
        subject: `📞 Appel manqué sans message de ${From}`,
        html: `
          <p><strong>Appelant :</strong> ${From}</p>
          <p><strong>Numéro Twilio :</strong> ${To}</p>
          <p>Aucun message n’a été laissé.</p>
        `
      });
      return res.json({ success: true, note: "Appel sans message enregistré." });
    }

    // ✅ Étape 2 : Télécharger l’audio
    const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.ACCOUNT_SID}/Recordings/${RecordingSid}.mp3`;
    console.log("🎧 Tentative de téléchargement audio :", recordingUrl);
    const audioRes = await axios.get(recordingUrl, {
      responseType: "arraybuffer",
      auth: { username: process.env.ACCOUNT_SID, password: process.env.AUTH_TOKEN },
      timeout: 10000,
    });
    const audioBuffer = Buffer.from(audioRes.data);

    // ✅ Étape 3 : Transcription via Whisper
    let transcript = "(transcription indisponible)";
    try {
      const form = new FormData();
      form.append("file", audioBuffer, {
        filename: `voicemail-${RecordingSid}.mp3`,
        contentType: "audio/mpeg",
      });
      form.append("model", "whisper-1");
      form.append("language", "fr");

      const sttRes = await axios.post("https://api.openai.com/v1/audio/transcriptions", form, {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...form.getHeaders(),
        },
        timeout: 20000,
      });

      transcript = sttRes.data.text?.trim() || transcript;
    } catch (err) {
      console.error("❌ Erreur transcription :", err.message);
    }

  // ✅ Étape 4 : Détection stricte des transcriptions purement parasites
const invalidTranscripts = [
  "sous-titres réalisés par la communauté d’amara.org",
  "sous titres réalisés par la communauté d'amara.org",
  "sous-titres réalisés para la comunidad de amara.org",
  "sous-titres réalisés para la communauté d’amara.org",
  "musique",
  "bruit de fond",
  "aucun son détecté",
  "aucun message",
  "aucune parole",
  "pas de voix",
  "voix inaudible",
  "no speech detected",
  "background noise",
  "silence",
  "empty recording",
  "no audio detected"
];

const lowerTranscript = transcript.toLowerCase().trim();

// ✅ On supprime toute ponctuation / espace / accents pour comparaison plus robuste
const normalizedTranscript = lowerTranscript
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[.,;:!?'"()\[\]\s]/g, "");

// ✅ Si la transcription correspond *exactement* à une phrase parasite, on la rejette
const isPurelyInvalid = invalidTranscripts.some(t => {
  const norm = t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,;:!?'"()\[\]\s]/g, "");
  return normalizedTranscript === norm;
});

if (isPurelyInvalid) {
  console.warn("⚠️ Transcription parasite détectée – traité comme appel sans message.");
  await sgMail.send({
    to: garage.to_email,
    bcc: "louis.becker0503@gmail.com",
    from: garage.from_email,
    subject: `📞 Appel manqué sans message de ${From}`,
    html: `
      <p><strong>Appelant :</strong> ${From}</p>
      <p><strong>Numéro Twilio :</strong> ${To}</p>
      <p>Aucun message n’a été laissé (transcription parasite détectée).</p>
    `
  });
  return res.json({ success: true, note: "Appel sans message (transcription parasite)" });
}

    // ✅ Étape 5 : Analyse du texte
    const usableText = transcript.startsWith("(échec") ? "" : transcript;
    const { cause, date } = extractInfoFr(usableText);
    const callerName = extractNameFr(usableText);
    const { urgent, rentable, pickup, plate } = detectPriority(usableText);
    const fromPhone = normalizePhone(From);

    const priorityTag = urgent ? "🚨 URGENT" : "";
    const pickupTag = pickup ? "🚗 À RÉCUPÉRER" : "";
    const tagLine = [priorityTag, pickupTag].filter(Boolean).join(" ");

    const subject = `📞 [${cause.toUpperCase()}] ${callerName} (${fromPhone}) - ${date} ${tagLine ? "· " + tagLine : ""}`;

    const summaryLines = [
      tagLine && `**${tagLine}**`,
      `**Motif :** ${cause}`,
      `**Date souhaitée :** ${date}`,
      `**Appelant :** ${callerName} (${fromPhone})`,
      plate && `**Immatriculation :** ${plate}`,
      `—`,
      `Rappel rapide recommandé.`,
    ].filter(Boolean);

    const html = `
      <div style="font-family: Arial, sans-serif; line-height:1.6; color:#222; font-size:15px; max-width:600px;">
        ${summaryLines.map(l => {
          if (l === "—") return '<hr style="border:none;border-top:1px solid #ddd;margin:12px 0;">';
          const clean = escapeHtml(l.replace(/\*\*/g, ""));
          return `<p style="margin:0 0 4px 0;"><strong>${clean}</strong></p>`;
        }).join('')}
        <p style="margin:14px 0 4px 0;"><strong>Transcription :</strong></p>
        <p style="margin:0; padding-left:10px; border-left:3px solid #ccc;">
          ${escapeHtml(transcript).replace(/\n+/g, '<br>').replace(/([.?!])\s/g, '$1&nbsp;')}
        </p>
      </div>
    `;

    // ✅ Étape 6 : Envoi d’email + BCC
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
          disposition: "attachment",
        },
      ],
    });

    console.log(`✅ Email envoyé à ${garage.to_email}`);

    // ✅ Étape 7 : Sauvegarder la transcription en BDD
    const callRecord = getAllCalls().find(c => c.call_sid === (CallSid || RecordingSid));
    if (callRecord) {
      saveMessage({
        call_id: callRecord.id,
        recording_url: recordingUrl,
        transcription: transcript,
        motif: cause,
        nom_detecte: callerName,
        fidelity: "ok",
        confidence: null,
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("💥 Erreur serveur :", err.message);
    res.status(500).json({ error: "Erreur interne du serveur" });
  }
});

// ✅ Routes utilitaires
app.get("/", (_, res) => res.send("🚀 Serveur voicemail opérationnel"));
app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() }));

// ✅ Export CSV
app.get("/export", (_, res) => {
  try {
    const calls = getAllCalls();
    if (!calls.length) return res.status(200).send("Aucune donnée à exporter pour le moment.");

    const headers = Object.keys(calls[0]).join(";");
    const csvRows = calls.map(row => Object.values(row).map(v => (v === null ? "" : `"${String(v).replace(/"/g, '""')}"`)).join(";"));
    const csvContent = [headers, ...csvRows].join("\n");

    res.header("Content-Type", "text/csv; charset=utf-8");
    res.attachment("voicemails_export.csv");
    res.send(csvContent);
    console.log("✅ Export CSV généré et envoyé au client.");
  } catch (error) {
    console.error("❌ Erreur export CSV :", error.message);
    res.status(500).send("Erreur lors de l'export CSV.");
  }
});

// ✅ Nouvelle route TwiML pour enregistrer le message vocal de manière fiable
app.post("/twiml/voicemail/:to", async (req, res) => {
  try {
    const to = decodeURIComponent(req.params.to);
    const garage = GARAGES[to];

    if (!garage) {
      console.warn(`⚠️ Numéro Twilio inconnu pour route TwiML : ${to}`);
      return res.type("text/xml").send(`
        <Response>
          <Say>Numéro de garage inconnu. Merci de réessayer plus tard.</Say>
        </Response>
      `);
    }

    const callbackUrl = "https://voicemail-assistant-hwa4dpesahema3aa.francecentral-01.azurewebsites.net/email-voicemail";

    res.type("text/xml");
    res.send(`
      <Response>
        <Say voice="alice">Merci, laissez votre message après le bip.</Say>
        <Record
          maxLength="120"
          playBeep="true"
          recordingStatusCallback="${callbackUrl}"
          recordingStatusCallbackMethod="POST"
        />
      </Response>
    `);
  } catch (err) {
    console.error("💥 Erreur dans /twiml/voicemail :", err.message);
    res.type("text/xml").send(`<Response><Say>Erreur interne, désolé.</Say></Response>`);
  }
});

// ✅ Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur voicemail en ligne sur le port ${PORT}`));