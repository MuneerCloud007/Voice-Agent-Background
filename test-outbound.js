
import WebSocket from "ws";
import Twilio from "twilio";
import { PassThrough } from 'stream';
import ffmpeg from 'fluent-ffmpeg';
import fs from "fs";

// ---------- μ-law decode (ITU G.711) ----------
export function mulawDecode(uLawByte) {
  uLawByte = ~uLawByte & 0xff;
  const sign = (uLawByte & 0x80) ? -1 : 1;
  let exponent = (uLawByte >> 4) & 0x07;
  let mantissa = uLawByte & 0x0F;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  return sign * sample;
}

// ---------- μ-law encode (ITU G.711) ----------
export function mulawEncode(sample) {
  const BIAS = 0x84;
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  sample += BIAS;
  if (sample > 0x7FFF) sample = 0x7FFF;

  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}

  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

// ------------ Load background PCM 16-bit mono 8000Hz ------------
const bg = fs.readFileSync("./assets/office.raw");  // PCM s16le
let bgOffset = 0;

// FFT-equivalent volumes from your ffmpeg pipeline
const VOICE_VOL = 1.0;
const BG_VOL = 0.3;

// ---------------------------------------------------------------
// EXACT FFmpeg-style amix in JavaScript
// ---------------------------------------------------------------
export function mixChunk(ulawChunk) {
  const len = ulawChunk.length;
  const pcm = new Int16Array(len);

  // 1. decode u-law→PCM16
  for (let i = 0; i < len; i++) {
    pcm[i] = mulawDecode(ulawChunk[i]) * VOICE_VOL;
  }

  // 2. mix background PCM16
  for (let i = 0; i < len; i++) {
    if (bgOffset >= bg.length) bgOffset = 0;

    const bgSample = bg.readInt16LE(bgOffset) * BG_VOL;
    bgOffset += 2;

    let mixed = pcm[i] + bgSample;

    // Clamp 16-bit like FFmpeg
    if (mixed > 32767) mixed = 32767;
    if (mixed < -32768) mixed = -32768;

    pcm[i] = mixed;
  }

  // 3. encode back to μ-law
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    out[i] = mulawEncode(pcm[i]);
  }

  return out; // raw bytes → send base64 to Twilio
}


export function mixWithBackground(base64Voice, backgroundPath) {
  return new Promise((resolve, reject) => {
    const voiceBuffer = Buffer.from(base64Voice, "base64");

    // Convert Twilio MULAW → WAV PCM (in-memory)
    const mulawStream = new PassThrough();
    mulawStream.end(voiceBuffer);

    const wavStream = new PassThrough();
    const wavChunks = [];

    wavStream.on("data", (c) => wavChunks.push(c));
    wavStream.on("end", () => {
      const wavBuffer = Buffer.concat(wavChunks);

      const voiceWavStream = new PassThrough();
      voiceWavStream.end(wavBuffer);

      // FINAL OUTPUT STREAM
      const output = new PassThrough();
      const finalChunks = [];

      // IMPORTANT: attach listeners BEFORE piping
      output.on("data", (c) => finalChunks.push(c));
      output.on("error", reject);
      output.on("end", () => {
        const mixed = Buffer.concat(finalChunks);
        resolve(mixed.toString("base64"));
      });

      // MIX WAV + BACKGROUND → MULAW
      ffmpeg()
        .addInput(voiceWavStream)
        .inputOptions(["-f wav"])
        .addInput(backgroundPath)
        .addOptions(["-nostdin"])
        .audioFilters([
          "volume=1.0[a0]",
          "volume=0.25[a1]",
          "[a0][a1]amix=inputs=2:duration=first[aout]"
        ])
        .outputOptions([
          "-map [aout]",
          "-c:a pcm_mulaw",
          "-ar 8000",
          "-ac 1",
          "-f mulaw",
        ])
        .output("-")          // ← SUPER IMPORTANT FIX
        .on("error", reject)
        .pipe(output, { end: true });
    });

    wavStream.on("error", reject);

    // FFmpeg mulaw → wav convert
    ffmpeg(mulawStream)
      .inputOptions(["-f mulaw", "-ar 8000", "-ac 1"])
      .addOptions(["-nostdin"])
      .audioCodec("pcm_s16le")
      .audioFrequency(8000)
      .audioChannels(1)
      .format("wav")
      .on("error", reject)
      .pipe(wavStream, { end: true });
  });
}
export function registerOutboundRoutes(fastify) {
  // Check for required environment variables
  const {
    ELEVENLABS_API_KEY,
    ELEVENLABS_AGENT_ID,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER
  } = process.env;

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error("Missing required environment variables");
    throw new Error("Missing required environment variables");
  }

  // Initialize Twilio client
  const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  // Helper function to get signed URL for authenticated conversations
  async function getSignedUrl() {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
        {
          method: 'GET',
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to get signed URL: ${response.statusText}`);
      }

      const data = await response.json();
      return data.signed_url;
    } catch (error) {
      console.error("Error getting signed URL:", error);
      throw error;
    }
  }

  // Route to initiate outbound calls
  fastify.post("/outbound-call", async (request, reply) => {
    const { number, prompt } = request.body;

    if (!number) {
      return reply.code(400).send({ error: "Phone number is required" });
    }

    try {
      const call = await twilioClient.calls.create({
        from: TWILIO_PHONE_NUMBER,
        to: number,
        url: `https://${request.headers.host}/outbound-call-twiml`
      });

      reply.send({
        success: true,
        message: "Call initiated",
        callSid: call.sid
      });
    } catch (error) {
      console.error("Error initiating outbound call:", error);
      reply.code(500).send({
        success: false,
        error: "Failed to initiate call"
      });
    }
  });

  // TwiML route for outbound calls
  fastify.all("/outbound-call-twiml", async (request, reply) => {
    const prompt = request.query.prompt || '';

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream">
            <Parameter name="prompt" value="${prompt}" />
          </Stream>
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  });

  // WebSocket route for handling media streams
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/outbound-media-stream", { websocket: true }, (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      // Variables to track the call
      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;  // Add this to store parameters

      // Handle WebSocket errors
      ws.on('error', console.error);

      // Set up ElevenLabs connection
      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            // Send initial configuration with prompt and first message
            const initialConfig = {
              type: "conversation_initiation_client_data"
            };


            // Send the configuration to ElevenLabs
            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", async (data) => {
            try {
              const message = JSON.parse(data);

              console.log("ELEVEN LABS MESSAGE");
              console.log(message);
              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata");
                  break;

                case "audio":
                  if (streamSid) {
                    if (message.audio?.chunk) {
                      // 1. Get original audio chunk
                      const original = message.audio.chunk;

                      // 2. Mix with background
                      const ulaw = Buffer.from(original, "base64");

                      const mixed = mixChunk(ulaw);
                      // 3. Send mixed audio back
                      console.log("SENDING MIXED AUDIO CHUNK");
                      console.log(mixed.toString("base64"));
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: mixed.toString("base64"),   // <<< mixed instead of original
                        },
                      };
                      ws.send(JSON.stringify(audioData));

                    } else if (message.audio_event?.audio_base_64) {
                      // 1. Original inbound from ElevenLabs
                      const original = message.audio_event.audio_base_64;

                      // 2. Mix
                      const ulaw = Buffer.from(original, "base64");

                      const mixed = mixChunk(ulaw);
                       console.log("SENDING MIXED AUDIO CHUNK");
                      console.log(mixed.toString("base64"));
                      // 3. Send mixed audio
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: mixed.toString("base64"),
                        },
                      };
                      ws.send(JSON.stringify(audioData));

                    }
                  } else {
                    console.log("[ElevenLabs] Received audio but no StreamSid yet");
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(JSON.stringify({
                      event: "clear",
                      streamSid
                    }));
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(JSON.stringify({
                      type: "pong",
                      event_id: message.ping_event.event_id
                    }));
                  }
                  break;

                default:
                  console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", () => {
            console.log("[ElevenLabs] Disconnected");
          });

        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      // Set up ElevenLabs connection
      setupElevenLabs();

      // Handle messages from Twilio
      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);


          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;  // Store parameters
              console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
              console.log('[Twilio] Start parameters:', customParameters);
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      // Handle WebSocket closure
      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    });
  });
}