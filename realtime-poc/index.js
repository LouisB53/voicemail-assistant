import express from "express";
import http from "http";
import dotenv from "dotenv";
import { WebSocketServer, WebSocket } from "ws";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/twilio/media" });

/**
 * Route Twilio: renvoie TwiML <Stream>
 */
app.post("/twilio/incoming", (req, res) => {
  const { PUBLIC_BASE_URL } = process.env;
  if (!PUBLIC_BASE_URL) {
    res
      .type("text/xml")
      .send(`<Response><Say>Missing PUBLIC_BASE_URL</Say><Hangup/></Response>`);
    return;
  }

  const wssUrl = PUBLIC_BASE_URL.replace("https://", "wss://");
  res.type("text/xml").send(`
    <Response>
      <Connect>
        <Stream url="${wssUrl}/twilio/media" />
      </Connect>
    </Response>
  `);
});

/**
 * Twilio <-> OpenAI Realtime
 */
wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio WS connected");

  // ✅ PER-CALL state (important)
  let streamSid = null;
  let outAudioChunks = 0;
  let assistantSpeaking = false;

  const callState = {
    startedAt: Date.now(),
    transcript: "",
    warned: false,
  };

  const rtWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  function softClose(reason) {
    try {
      console.log("🔚 Closing call:", reason);
      twilioWs.close();
      rtWs.close();
    } catch {}
  }

  rtWs.on("open", () => {
    console.log("✅ Realtime WS open");

    rtWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad", create_response: true },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: "alloy",
          input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
          instructions: `
Tu es la secrétaire digitale d’un garage automobile en France.
Objectif: en moins de 45 secondes, capturer un message exploitable.

Règles:
- Laisse l’appelant parler. Ne pose pas de questions tant qu’il n’a pas fini.
- Maximum 2 questions au total.
- Priorité: (1) motif (2) nom (3) date souhaitée (4) véhicule/immat seulement si l’appelant l’a sous la main.
- Si l’appelant dit "je préfère qu’on me rappelle" ou refuse de donner des infos: accepte immédiatement et clôture.
- Toujours finir par: "Très bien, je transmets au garage, on vous rappelle rapidement." puis raccrocher.
- Pas de blabla, pas d’excuses, pas de discours sur l’IA.
          `.trim(),
        },
      })
    );

    // Ouverture courte
    rtWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Dis une phrase d'ouverture courte (<= 1.5s) : Bonjour, je prends votre demande et le garage vous rappelle. Puis tais-toi.",
        },
      })
    );
  });

  rtWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    // Marque fin de réponse (évite barge-in agressif)
    if (msg.type === "response.done" || msg.type === "response.completed") {
      assistantSpeaking = false;
    }

    // ✅ Audio out (supporte ancien + nouveau nom d’event)
    const audioDelta =
      msg.type === "response.output_audio.delta" && msg.delta
        ? msg.delta
        : msg.type === "response.audio.delta" && msg.delta
        ? msg.delta
        : null;

    if (audioDelta) {
      assistantSpeaking = true;

      if (streamSid) {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: audioDelta },
          })
        );
        outAudioChunks++;
        if (outAudioChunks % 50 === 0) {
          console.log("🔊 audio chunks out:", outAudioChunks);
        }
      }
      return;
    }

    // Transcription (utile plus tard)
    if (
      msg.type === "conversation.item.input_audio_transcription.delta" &&
      msg.delta
    ) {
      callState.transcript += msg.delta;
      return;
    }

    if (
      msg.type === "conversation.item.input_audio_transcription.completed" &&
      msg.transcript
    ) {
      callState.transcript += "\n" + msg.transcript;
      return;
    }

    if (msg.type === "error") {
      console.log("❌ Realtime error:", msg.error);
    }
  });

  twilioWs.on("message", (data) => {
    const msg = JSON.parse(data.toString());

    // Twilio envoie parfois "connected" avant "start"
    if (msg.event === "connected") {
      console.log("🔌 twilio connected");
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || msg.streamSid || null;
      console.log("📞 start:", msg.start?.callSid, streamSid);
      return;
    }

    if (msg.event === "media") {
      // ✅ Forward incoming audio to Realtime input buffer
      if (rtWs.readyState === WebSocket.OPEN) {
        rtWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload, // base64 g711_ulaw (Twilio)
          })
        );
      }

      const elapsed = (Date.now() - callState.startedAt) / 1000;

      // Soft cap 45s: close nicely once
      if (!callState.warned && elapsed > 45) {
        callState.warned = true;
        if (rtWs.readyState === WebSocket.OPEN) {
          rtWs.send(
            JSON.stringify({
              type: "response.create",
              response: {
                modalities: ["audio", "text"],
                instructions:
                  "On arrive au terme de l’appel. Je transmets votre demande au garage, on vous rappelle rapidement. Merci.",
              },
            })
          );
        }
      }

      // Hard cap 60s: close no matter what
      if (elapsed > 60) {
        softClose("hard_timeout_60s");
      }

      return;
    }

    if (msg.event === "stop") {
      console.log("🛑 stop");
      softClose("twilio_stop");
    }
  });

  twilioWs.on("close", () => {
    console.log("❌ Twilio WS closed");
    try {
      rtWs.close();
    } catch {}
  });

  rtWs.on("close", () => {
    console.log("❌ Realtime WS closed");
    try {
      twilioWs.close();
    } catch {}
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 POC running on http://localhost:${PORT}`)
);
