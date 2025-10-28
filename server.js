// server.js
import express from "express";
import axios from "axios";
import FormData from "form-data";
import sgMail from "@sendgrid/mail";
import fs from "fs";
import dotenv from "dotenv";
import { extractInfoFr, extractNameFr, detectPriority, escapeHtml, normalizePhone } from "./utils/extractors.js";

// 🧩 Import des fonctions de la BDD locale SQLite
import { saveCall, saveMessage, getAllCalls } from "./db.js";

dotenv.config();

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

  // ✅ Toujours récupérer du texte brut
  if (typeof raw !== "string") {
    raw = raw?.body || "";
  }

  // ✅ Convertir les retours à la ligne en &
  const normalized = raw.replace(/\n/g, "&").trim();

  // ✅ Décoder les paramètres Twilio
  const payload = Object.fromEntries(new URLSearchParams(normalized));

  console.log("📩 Corps Twilio reçu et décodé :", payload);

  const { RecordingSid, From, To, CallSid, CallStatus, CallDuration } = payload;

  if (!To) {
    console.warn("⚠️ Requête incomplète :", payload);
    return res.status(400).json({ error: "Requête invalide" });
  }

  // ✅ Nettoyer et normaliser le numéro Twilio
  let cleanTo = (To || "").trim().replace(/\s+/g, ""); // supprime espaces, tab, etc.
  if (!cleanTo.startsWith("+")) {
    cleanTo = "+" + cleanTo;
  }

  const garage = GARAGES[cleanTo];
  if (!garage) {
    console.warn(`⚠️ Numéro Twilio inconnu après normalisation : '${cleanTo}'`);
    return res.status(400).json({ error: "Numéro Twilio inconnu" });
  }

  console.log(`📞 Nouveau message pour ${garage.name} (${To}) de ${From}`);

  try {
    // ✅ Étape 1 : sauvegarder l’appel en base (même sans message)
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

    // Si aucun message vocal : envoi d’un mail spécifique
    if (!RecordingSid) {
      console.log("📭 Aucun message enregistré – envoi mail d’appel manqué");
      await sgMail.send({
        to: garage.to_email,
        bcc: "louis.becker0503@gmail.com",
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

    // ✅ Étape 2 : téléchargement du message audio Twilio
    const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${process.env.ACCOUNT_SID}/Recordings/${RecordingSid}.mp3`;
    const audioRes = await axios.get(recordingUrl, {
      responseType: "arraybuffer",
      auth: { username: process.env.ACCOUNT_SID, password: process.env.AUTH_TOKEN },
      timeout: 10000,
    });
    const audioBuffer = Buffer.from(audioRes.data);

    // ✅ Étape 3 : transcription Whisper
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

    // ✅ Étape 4 : analyse du texte
    const usableText = transcript.startsWith("(échec") ? "" : transcript;
    const { cause, date } = extractInfoFr(usableText);
    const callerName = extractNameFr(usableText);
    const { urgent, rentable, pickup, plate } = detectPriority(usableText);
    const fromPhone = normalizePhone(From);

    // ⚡ Tags d’urgence / récupération
    const priorityTag = urgent ? "🚨 URGENT" : "";
    const pickupTag = pickup ? "🚗 À RÉCUPÉRER" : "";
    const tagLine = [priorityTag, pickupTag].filter(Boolean).join(" ");

    // 📨 Format d’e-mail identique à l’ancienne Twilio Function
    const subject = `📞 [${cause.toUpperCase()}] ${callerName} (${fromPhone}) - ${date} ${tagLine ? "· " + tagLine : ""}`;

    // 📧 Contenu du mail
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

    // ✅ Étape 5 : envoi de l’email avec la transcription
    await sgMail.send({
      to: garage.to_email,
      bcc: "louis.becker0503@gmail.com",
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

    // ✅ Étape 6 : sauvegarder le message transcrit en base
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

// ✅ Route de test (ping)
app.get("/", (req, res) => {
  res.send("🚀 Serveur voicemail opérationnel");
});

// ✅ Endpoint de vérification du serveur
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    message: "🚀 Voicemail backend opérationnel"
  });
});

// ✅ Endpoint d’export CSV (pour Excel / suivi des appels)
app.get("/export", (req, res) => {
  try {
    const calls = getAllCalls();

    if (!calls.length) {
      return res.status(200).send("Aucune donnée à exporter pour le moment.");
    }

    // Génère l'en-tête CSV automatiquement
    const headers = Object.keys(calls[0]).join(";");

    // Convertit les lignes en texte CSV
    const csvRows = calls.map(row =>
      Object.values(row)
        .map(v => (v === null ? "" : `"${String(v).replace(/"/g, '""')}"`))
        .join(";")
    );

    const csvContent = [headers, ...csvRows].join("\n");

    // Configure la réponse HTTP
    res.header("Content-Type", "text/csv; charset=utf-8");
    res.attachment("voicemails_export.csv");
    res.send(csvContent);

    console.log("✅ Export CSV généré et envoyé au client.");
  } catch (error) {
    console.error("❌ Erreur export CSV :", error.message);
    res.status(500).send("Erreur lors de l'export CSV.");
  }
});

// Démarrage du serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Serveur voicemail en ligne sur le port ${PORT}`));