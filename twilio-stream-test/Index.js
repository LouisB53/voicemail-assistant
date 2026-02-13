import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();

// 1) Endpoint HTTP Twilio -> renvoie TwiML qui démarre un stream
app.post("/twilio/incoming", (req, res) => {
  // IMPORTANT: Remplace PUBLIC_WSS_URL après avoir lancé ngrok (étape 4)
  const PUBLIC_WSS_URL = process.env.PUBLIC_WSS_URL;

  if (!PUBLIC_WSS_URL) {
    res.type("text/xml").send(`
      <Response>
        <Say language="fr-FR">Erreur: PUBLIC_WSS_URL non configuré.</Say>
        <Hangup/>
      </Response>
    `);
    return;
  }

  res.type("text/xml").send(`
    <Response>
      <Say language="fr-FR">Test media stream.</Say>
      <Connect>
        <Stream url="${PUBLIC_WSS_URL}/twilio/media" />
      </Connect>
    </Response>
  `);
});

// 2) Serveur HTTP + WebSocket (WS) sur le même port
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio/media" });

wss.on("connection", (ws) => {
  console.log("✅ WS connected (Twilio Stream opened)");

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.event === "start") {
        console.log("📞 start:", msg.start?.callSid, msg.start?.streamSid);
      } else if (msg.event === "media") {
        // On ne log pas tout sinon c’est énorme
        console.log("🎧 media chunk received (payload bytes):", msg.media?.payload?.length);
      } else if (msg.event === "stop") {
        console.log("🛑 stop:", msg.stop?.callSid, msg.stop?.streamSid);
      } else {
        console.log("ℹ️ event:", msg.event);
      }
    } catch (e) {
      console.log("⚠️ Non-JSON WS message received");
    }
  });

  ws.on("close", () => console.log("❌ WS closed"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log("➡️ POST /twilio/incoming returns TwiML with <Stream>");
});
