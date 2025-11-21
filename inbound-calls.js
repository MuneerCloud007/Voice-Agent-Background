// Code for authenticated inbound calls & setting custom parameters with your agent

import WebSocket from "ws";
import {

  streamBackgroundToTwilio,
} from "./audioUtil.js";

export function registerInboundRoutes(fastify) {
  const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID } = process.env;

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
    console.error("Missing required environment variables");
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID");
  }

  // Helper function to get signed URL
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

  // Route to handle incoming calls from Twilio
  fastify.all("/incoming-call-eleven", async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
    <Stream  url="wss://${request.headers.host}/media-stream" />
        </Connect>
      </Response>`

    reply.type("text/xml").send(twimlResponse);
  });

  // WebSocket route for handling media streams
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/media-stream", { websocket: true }, async (ws, req) => {
      console.info("[Server] Twilio connected to media stream.");

      try {
        let streamSid = null;
        let callSid = null;
        let elevenLabsWs = null;
        let customParameters = null;  // Add this to store parameters
        // Get authenticated WebSocket URL
        ws.on('error', console.error);

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
                        // const mixed = await mixWithBackground(original, "./background.wav");

                        // 3. Send mixed audio back
                        const audioData = {
                          event: "media",
                          streamSid,
                          media: {
                            payload: original,   // <<< mixed instead of original
                          },
                        };
                        ws.send(JSON.stringify(audioData));

                      } else if (message.audio_event?.audio_base_64) {
                        // 1. Original inbound from ElevenLabs
                        const original = message.audio_event.audio_base_64;


                        // 2. Mix
                        // const mixed = await mixWithBackground(original, "./background.wav");

                        // 3. Send mixed audio
                        const audioData = {
                          event: "media",
                          streamSid,
                          media: {
                            payload: original,
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

                  case "agent_response":
                    console.log("[ElevenLabs] Agent response event:", message.agent_response_event);
                    ws.send(JSON.stringify({
                      event: "mark",
                      streamSid,
                      mark: { name: "agent_done" }
                    }));
                    break;

                  case "ping":
                    console.log("[ElevenLabs] Received ping, sending pong");
                    if (message.ping_event?.event_id) {
                      elevenLabsWs.send(JSON.stringify({
                        type: "pong",
                        event_id: message.ping_event.event_id
                      }));


                      // const mixed = await extractBackgroundNoise("./background.wav");
                      // const audioData = {
                      //   event: "media",
                      //   streamSid,
                      //   media: {
                      //     payload: mixed,   // <<< mixed instead of original
                      //   },
                      // };
                      // ws.send(JSON.stringify(audioData));


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

        const connection = {
          ws,
          streamSid: null,
          callSid: null,
          phoneNumber: null,
        };

        // Handle messages from Twilio
        ws.on("message", async (message) => {
          try {
            const data = JSON.parse(message);

            if (data.event === "start") {
              console.log("START EVENT");
            }

            switch (data.event) {
              case "start":
                console.log(data);
                streamSid = data.start.streamSid;
                callSid = data.start.callSid;
                customParameters = data.start.customParameters;  // Store parameters
                console.log(`[Twilio] Stream started with ID: ${streamSid}`);
                connection["streamSid"] = streamSid;
                connection['callSid'] = callSid;
                streamBackgroundToTwilio(
                  connection,
                  "./assets/typing.raw", 2.0, true)
                break;
              case "media":
                if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                  const audioMessage = {
                    user_audio_chunk: Buffer.from(data.media.payload, "base64").toString("base64")
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
                console.log(`[Twilio] Received unhandled event: ${data.event}`);
            }
          } catch (error) {
            console.error("[Twilio] Error processing message:", error);
          }
        });

        ws.on("close", () => {
          console.log("[Twilio] Client disconnected");
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