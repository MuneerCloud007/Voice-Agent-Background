import WebSocket from "ws";
import Twilio from "twilio";
import { PassThrough } from 'stream';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import {

  streamBackgroundToTwilio,
  generateWhiteNoise,
  encodeMuLawBuffer,
  BackgroundController

} from "./audioUtil.js";
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
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) { }

  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

const bg = fs.readFileSync("./assets/office.raw");
let bgOffset = 0;

const VOICE_VOL = 1;
const BG_VOL = 0.35;

let prevVoiceSample = 0;
let prevBgSample = 0;
let dcFilterState = 0;

function lowPassFilter(current, previous, alpha = 0.15) {
  return previous + alpha * (current - previous);
}

function removeDCOffset(sample) {
  const DC_COEFF = 0.995;
  const filtered = sample - dcFilterState;
  dcFilterState = dcFilterState * DC_COEFF + sample * (1 - DC_COEFF);
  return filtered;
}

function softLimit(sample) {
  const threshold = 26000;
  const ratio = 3.0;

  if (sample > threshold) {
    const excess = sample - threshold;
    return threshold + Math.tanh(excess / 5000) * 6767;
  } else if (sample < -threshold) {
    const excess = sample + threshold;
    return -threshold + Math.tanh(excess / 5000) * 6767;
  }

  return sample;
}


export function mixChunk(ulawChunk) {
  const len = ulawChunk.length;
  const pcm = new Int16Array(len);

  // 1. Decode μ-law → PCM16 with smoothing
  for (let i = 0; i < len; i++) {
    const decoded = mulawDecode(ulawChunk[i]) * VOICE_VOL;
    // Apply low-pass filter for smoothness
    const smoothed = lowPassFilter(decoded, prevVoiceSample, 0.18);
    prevVoiceSample = smoothed;
    pcm[i] = smoothed;
  }

  // 2. Mix background PCM16 with smoothing
  for (let i = 0; i < len; i++) {
    // Loop background audio
    if (bgOffset >= bg.length) {
      bgOffset = 0;
    }

    const rawBgSample = bg.readInt16LE(bgOffset) * BG_VOL;
    bgOffset += 2;

    // Smooth background audio (less aggressive filtering)
    const smoothBg = lowPassFilter(rawBgSample, prevBgSample, 0.3);
    prevBgSample = smoothBg;

    // Mix samples
    let mixed = pcm[i] + smoothBg;

    // Remove DC offset (prevents clicks and pops)
    mixed = removeDCOffset(mixed);

    // Apply soft limiting
    mixed = softLimit(mixed);

    // Hard clamp as final safety
    if (mixed > 32767) mixed = 32767;
    if (mixed < -32768) mixed = -32768;

    pcm[i] = Math.round(mixed);
  }

  // 3. Encode back to μ-law
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    out[i] = mulawEncode(pcm[i]);
  }

  return out;
}

export function resetBackgroundOffset() {
  bgOffset = 0;
  prevVoiceSample = 0;
  prevBgSample = 0;
  dcFilterState = 0;
}
function mixWithBackground(base64Voice, backgroundPath) {
  return new Promise((resolve, reject) => {
    const voiceBuffer = Buffer.from(base64Voice, "base64");

    const voiceStream = new PassThrough();
    voiceStream.end(voiceBuffer);

    const outputStream = new PassThrough();
    const chunks = [];

    outputStream.on("data", (c) => chunks.push(c));
    outputStream.on("end", () => {
      const finalBuffer = Buffer.concat(chunks);
      resolve(finalBuffer.toString("base64"));
    });
    outputStream.on("error", reject);

    ffmpeg()
      .input(voiceStream)
      .inputOptions(["-f mulaw", "-ar 8000", "-ac 1"])   // Twilio inbound = mulaw 8k
      .input(backgroundPath)                             // your background.wav file
      .complexFilter([
        { filter: "volume", options: { volume: 1.0 }, inputs: "0:a", outputs: "v0" },
        { filter: "volume", options: { volume: 0.3 }, inputs: "1:a", outputs: "bg" },
        { filter: "amix", options: { inputs: 2, duration: "first" }, inputs: ["v0", "bg"], outputs: "mixed" }
      ])
      .outputOptions(["-map [mixed]", "-c:a pcm_mulaw", "-ar 8000", "-ac 1"])  // return mulaw back
      .format("mulaw")
      .pipe(outputStream, { end: true });
  });
}







let noiseInterval = null;

export function registerInboundRoutes(fastify) {
  const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, WEITZMANGROUP_AGENT_ID,WEITZMANGROUP_API_KEY } = process.env;

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !WEITZMANGROUP_AGENT_ID || !WEITZMANGROUP_API_KEY) {
    console.error("Missing required environment variables");
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID");
  }

  async function endTwilioInboundCall(callSid) {
    try {
      if (!callSid) {
        console.error("❌ endTwilioInboundCall: Missing CallSid");
        return;
      }

      // Initialize Twilio client inside the same function
      const client = Twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );


      await client.calls(callSid).update({ status: "completed" });

    } catch (err) {
      console.error("❌ Failed to end inbound call:", err);
    }
  }


  // Helper function to get signed URL
  async function getSignedUrl(caseType) {

    try {
      let parameters = ELEVENLABS_AGENT_ID;
      let api = ELEVENLABS_API_KEY;
      if (caseType === "weitzmangroup") {
        parameters = WEITZMANGROUP_AGENT_ID;
        api = WEITZMANGROUP_API_KEY;
      }
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${parameters}`,
        {
          method: 'GET',
          headers: {
            'xi-api-key': api
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

  fastify.all("/incoming-call-eleven", async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
    <Stream  url="wss://${request.headers.host}/media-stream" />
        </Connect>
      </Response>`

    reply.type("text/xml").send(twimlResponse);
  });

  fastify.all("/incoming-call-weitzmangroup", async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
    <Connect>
    <Stream  url="wss://${request.headers.host}/weitzmangroup/media-stream" />
    </Connect>
    </Response>`

    reply.type("text/xml").send(twimlResponse);

  })


  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/media-stream", { websocket: true }, async (ws, req) => {
      console.info("[Server] Twilio connected to media stream.");

      try {

        let streamSid = null;
        let callSid = null;
        let elevenLabsWs = null;
        let customParameters = null;
        let flag = false;
        let eleven_AUDIO_COUNT = -1;
        let twilio_AUDIO_COUNT = 0;


        ws.on('error', console.error);

        const setupElevenLabs = async () => {
          try {
            const signedUrl = await getSignedUrl("elevenLabs");
            elevenLabsWs = new WebSocket(signedUrl,{
                handshakeTimeout: 20000 
            });

            elevenLabsWs.on("open", () => {
              console.log("[ElevenLabs] Connected to Conversational AI");

              const initialConfig = {
                type: "conversation_initiation_client_data"
              };

              elevenLabsWs.send(JSON.stringify(initialConfig));
            });

            elevenLabsWs.on("message", async (data) => {
              try {
                const message = JSON.parse(data);
                let outboundChunkCounter = 0;

                switch (message.type) {
                  case "conversation_initiation_metadata":
                    console.log("[ElevenLabs] Received initiation metadata");
                    break;

                  case "audio":
                    if (streamSid) {
                      if (message.audio?.chunk) {

                        const original = message.audio.chunk;

                        console.log("🎙️ [Agent] Speaking detected — stopping background...");
                        BackgroundController.stop();

                        ws.send(JSON.stringify({
                          event: "incomming_call",
                          streamSid,
                          mark: { name: "agent_inclomming" }
                        }));

                        const ulaw = Buffer.from(original, "base64");

                        const mixed = mixChunk(ulaw);

                        const audioData = {
                          event: "media",
                          streamSid,
                          media: {
                            payload: mixed.toString("base64"),
                            track: "outbound",
                            timestamp: Date.now().toString()
                          },
                        };
                        ws.send(JSON.stringify(audioData));
                        ws.send(JSON.stringify({
                          event: "mark",
                          streamSid,
                          mark: { name: "agent_done" }
                        }));
                        ++eleven_AUDIO_COUNT




                      } else if (message.audio_event?.audio_base_64) {
                        // 1. Original inbound from ElevenLabs
                        const original = message.audio_event.audio_base_64;
                        console.log("🎙️ [Agent] Speaking detected — stopping background...");
                        BackgroundController.stop();
                        ws.send(JSON.stringify({
                          event: "incomming_call",
                          streamSid,
                          mark: { name: "agent_inclomming" }
                        }));
                        const ulaw = Buffer.from(original, "base64");

                        const mixed = mixChunk(ulaw);
                        // 3. Send mixed audio
                        const audioData = {
                          event: "media",
                          streamSid,
                          media: {
                            payload: mixed.toString("base64"),   // <<< mixed instead of original
                            track: "outbound",   // <--- send agent voice on outbound track
                            timestamp: Date.now().toString()
                          },
                        };
                        ws.send(JSON.stringify(audioData));
                        ws.send(JSON.stringify({
                          event: "mark",
                          streamSid,
                          mark: { name: "agent_done" }
                        }));
                        ++eleven_AUDIO_COUNT
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

                  case "agent_response":
                    console.log("[ElevenLabs] Agent response event:", message.agent_response_event);
                    break;

                  case "ping":
                    console.log("[ElevenLabs] Received ping, sending pong");
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

        setupElevenLabs();

        const connection = {
          ws,
          streamSid: null,
          callSid: null,
          phoneNumber: null,
        }
        let markFlag = false;
        let callEnd = false;


        let outboundChunkCounter = 0;

        ws.on("message", async (message) => {
          try {
            const msg = JSON.parse(message);

            if (msg.event != "media") {
              console.log("MESSAGE RECEIVED FROM TWILIO:", msg.event);
            }
            if (msg.event == "mark") {
              console.log("EVENT :", msg.event);
            }

            switch (msg.event) {
              case "start":
                streamSid = msg.start.streamSid;
                callSid = msg.start.callSid;
                customParameters = msg.start.customParameters;
                connection["streamSid"] = streamSid;
                connection['callSid'] = callSid;

                console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
                console.log('[Twilio] Start parameters:', customParameters);
                break;



              case "media":
                //ELeven Labs agent is disconnected
                if (markFlag && twilio_AUDIO_COUNT == 0 && eleven_AUDIO_COUNT == -1) {
                  if (!elevenLabsWs || elevenLabsWs.readyState !== 1) {
                    console.log("🔴 ElevenLabs is disconnected — ending Twilio call CASE:Media");

                    if (!callEnd && connection.callSid) {
                      await endTwilioInboundCall(connection.callSid);
                      callEnd = true

                    }
                    return;
                  }
                }
                //Eleven agent is connected
                if (elevenLabsWs?.readyState === WebSocket.OPEN) {

                  const audioMessage = {
                    user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
                  }
                  elevenLabsWs.send(JSON.stringify(audioMessage));
                }
                break;

              case "mark":


                console.log(`ELEVEN LABS CHUNK COUNT, ${eleven_AUDIO_COUNT}`);
                console.log(`TWILIO LABS CHUNK COUNT, ${twilio_AUDIO_COUNT}`);
                markFlag = true;
                if (eleven_AUDIO_COUNT === twilio_AUDIO_COUNT) {
                  console.log("🟢 [Agent] Finished — safe to resume background");
                  BackgroundController.stop(); // ensure old loop dead
                  if (!elevenLabsWs || elevenLabsWs.readyState !== 1) {
                    console.log("🔴 ElevenLabs is disconnected — ending Twilio call");
                    twilio_AUDIO_COUNT = 0;
                    eleven_AUDIO_COUNT = -1

                    if (!callEnd && connection.callSid) {
                      await endTwilioInboundCall(connection.callSid);
                      callEnd = true

                    }
                    return;
                  }
                  streamBackgroundToTwilio(connection, "./assets/office.raw", 0.2, true);
                  twilio_AUDIO_COUNT = 0;
                  eleven_AUDIO_COUNT = -1
                }
                else {
                  twilio_AUDIO_COUNT++;
                }
                console.log("✔ All audio finished playing to caller!");
                break;



              case "stop":
                console.log(`[Twilio] Stream ${streamSid} ended`);
                twilio_AUDIO_COUNT = 0;
                eleven_AUDIO_COUNT = -1;
                BackgroundController.stop();

                if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                  elevenLabsWs.close();
                }
                break;

              default:
                console.log(`[Twilio] Unhandled event: ${msg.event}`);
            }
          } catch (error) {
            BackgroundController.stop(); // ensure old loop dead
            twilio_AUDIO_COUNT = 0;
            eleven_AUDIO_COUNT = -1;

            console.error("[Twilio] Error processing message:", error);
          }
        });
        ws.on("close", () => {
          console.log("[Twilio] Client disconnected");
          callEnd = false;
          markFlag = false;
          if (elevenLabsWs?.readyState === WebSocket.OPEN) {
            elevenLabsWs.close();
          }
        });

        // Handle errors

        ws.on("error", (error) => {
          console.error("[Twilio] WebSocket error:", error);
        });

      } catch (error) {
        console.error("[Server] Error initializing conversation:", error);

      }
    });

    fastifyInstance.get("/weitzmangroup/media-stream", { websocket: true }, async (ws, req) => {
      console.info("[Server] Twilio connected to weitzmangroup media stream.");

      try {

        let streamSid = null;
        let callSid = null;
        let elevenLabsWs = null;
        let customParameters = null;
        let flag = false;
        let eleven_AUDIO_COUNT = -1;
        let twilio_AUDIO_COUNT = 0;


        ws.on('error', console.error);

        const setupElevenLabs = async () => {
          try {
            const signedUrl = await getSignedUrl("weitzmangroup");
            elevenLabsWs = new WebSocket(signedUrl);

            elevenLabsWs.on("open", () => {
              console.log("[ElevenLabs] Connected to Conversational AI");

              const initialConfig = {
                type: "conversation_initiation_client_data"
              };

              elevenLabsWs.send(JSON.stringify(initialConfig));
            });

            elevenLabsWs.on("message", async (data) => {
              try {
                const message = JSON.parse(data);
                let outboundChunkCounter = 0;

                switch (message.type) {
                  case "conversation_initiation_metadata":
                    console.log("[ElevenLabs] Received initiation metadata");
                    break;

                  case "audio":
                    if (streamSid) {
                      if (message.audio?.chunk) {

                        const original = message.audio.chunk;

                        console.log("🎙️ [Agent] Speaking detected — stopping background...");
                        BackgroundController.stop();

                        ws.send(JSON.stringify({
                          event: "incomming_call",
                          streamSid,
                          mark: { name: "agent_inclomming" }
                        }));

                        const ulaw = Buffer.from(original, "base64");

                        const mixed = mixChunk(ulaw);

                        const audioData = {
                          event: "media",
                          streamSid,
                          media: {
                            payload: mixed.toString("base64"),
                            track: "outbound",
                            timestamp: Date.now().toString()
                          },
                        };
                        ws.send(JSON.stringify(audioData));
                        ws.send(JSON.stringify({
                          event: "mark",
                          streamSid,
                          mark: { name: "agent_done" }
                        }));
                        ++eleven_AUDIO_COUNT




                      } else if (message.audio_event?.audio_base_64) {
                        // 1. Original inbound from ElevenLabs
                        const original = message.audio_event.audio_base_64;
                        console.log("🎙️ [Agent] Speaking detected — stopping background...");
                        BackgroundController.stop();
                        ws.send(JSON.stringify({
                          event: "incomming_call",
                          streamSid,
                          mark: { name: "agent_inclomming" }
                        }));
                        const ulaw = Buffer.from(original, "base64");

                        const mixed = mixChunk(ulaw);
                        // 3. Send mixed audio
                        const audioData = {
                          event: "media",
                          streamSid,
                          media: {
                            payload: mixed.toString("base64"),   // <<< mixed instead of original
                            track: "outbound",   // <--- send agent voice on outbound track
                            timestamp: Date.now().toString()
                          },
                        };
                        ws.send(JSON.stringify(audioData));
                        ws.send(JSON.stringify({
                          event: "mark",
                          streamSid,
                          mark: { name: "agent_done" }
                        }));
                        ++eleven_AUDIO_COUNT
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

                  case "agent_response":
                    console.log("[ElevenLabs] Agent response event:", message.agent_response_event);
                    break;

                  case "ping":
                    console.log("[ElevenLabs] Received ping, sending pong");
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

        setupElevenLabs();

        const connection = {
          ws,
          streamSid: null,
          callSid: null,
          phoneNumber: null,
        }
        let markFlag = false;
        let callEnd = false;


        let outboundChunkCounter = 0;

        ws.on("message", async (message) => {
          try {
            const msg = JSON.parse(message);

            if (msg.event != "media") {
              console.log("MESSAGE RECEIVED FROM TWILIO:", msg.event);
            }
            if (msg.event == "mark") {
              console.log("EVENT :", msg.event);
            }

            switch (msg.event) {
              case "start":
                streamSid = msg.start.streamSid;
                callSid = msg.start.callSid;
                customParameters = msg.start.customParameters;
                connection["streamSid"] = streamSid;
                connection['callSid'] = callSid;

                console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
                console.log('[Twilio] Start parameters:', customParameters);
                break;



              case "media":
                //ELeven Labs agent is disconnected
                if (markFlag && twilio_AUDIO_COUNT == 0 && eleven_AUDIO_COUNT == -1) {
                  if (!elevenLabsWs || elevenLabsWs.readyState !== 1) {

                    if (!callEnd && connection.callSid) {
                      console.log("🔴 ElevenLabs is disconnected — ending Twilio call CASE:Media");

                      await endTwilioInboundCall(connection.callSid);
                      callEnd = true

                    }
                    return;
                  }
                }
                //Eleven agent is connected
                if (elevenLabsWs?.readyState === WebSocket.OPEN) {

                  const audioMessage = {
                    user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
                  }
                  if (eleven_AUDIO_COUNT == -1 && twilio_AUDIO_COUNT == 0) {

                  }


                  elevenLabsWs.send(JSON.stringify(audioMessage));
                }
                break;

              case "mark":


                console.log(`ELEVEN LABS CHUNK COUNT, ${eleven_AUDIO_COUNT}`);
                console.log(`TWILIO LABS CHUNK COUNT, ${twilio_AUDIO_COUNT}`);
                markFlag = true;
                if (eleven_AUDIO_COUNT === twilio_AUDIO_COUNT) {
                  console.log("🟢 [Agent] Finished — safe to resume background");
                  BackgroundController.stop(); // ensure old loop dead
                  if (!elevenLabsWs || elevenLabsWs.readyState !== 1) {
                    console.log("🔴 ElevenLabs is disconnected — ending Twilio call");
                    twilio_AUDIO_COUNT = 0;
                    eleven_AUDIO_COUNT = -1

                    if (!callEnd && connection.callSid) {
                      await endTwilioInboundCall(connection.callSid);
                      callEnd = true

                    }
                    return;
                  }
                  streamBackgroundToTwilio(connection, "./assets/office.raw", 0.2, true);
                  twilio_AUDIO_COUNT = 0;
                  eleven_AUDIO_COUNT = -1
                }
                else {
                  twilio_AUDIO_COUNT++;
                }
                console.log("✔ All audio finished playing to caller!");
                break;



              case "stop":
                console.log(`[Twilio] Stream ${streamSid} ended`);
                twilio_AUDIO_COUNT = 0;
                eleven_AUDIO_COUNT = -1;
                BackgroundController.stop();

                if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                  elevenLabsWs.close();
                }
                break;

              default:
                console.log(`[Twilio] Unhandled event: ${msg.event}`);
            }
          } catch (error) {
            BackgroundController.stop(); // ensure old loop dead
            twilio_AUDIO_COUNT = 0;
            eleven_AUDIO_COUNT = -1;

            console.error("[Twilio] Error processing message:", error);
          }
        });
        ws.on("close", () => {
          console.log("[Twilio] Client disconnected");
          callEnd = false;
          markFlag = false;
          if (elevenLabsWs?.readyState === WebSocket.OPEN) {
            elevenLabsWs.close();
          }
        });

        // Handle errors

        ws.on("error", (error) => {
          console.error("[Twilio] WebSocket error:", error);
        });

      } catch (error) {
        console.error("[Server] Error initializing conversation:", error);

      }
    });

  });
}