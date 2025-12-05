import Fastify from "fastify";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import { registerInboundRoutes } from "./inbound-calls.js";
import { registerOutboundRoutes } from "./outbound-calls.js";
import { registerSearchRoute } from "./tooling.js";
import dbConnect from "./config/dbConnection.js";
import WebSocket from "ws"; // top of your file
import cors from "@fastify/cors";



// Load environment variables
dotenv.config();

// Initialize Fastify
const fastify = Fastify({
  logger: true,
});

// Register plugins
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// DB connect before every request (only first time)
fastify.addHook("onRequest", async (request, reply) => {
  if (!fastify.mongoConnected) {
    await dbConnect(process.env.MONGODB_URI);
    fastify.mongoConnected = true;
    console.log("MongoDB Connected (Fastify Hook)");
  }
});

const PORT = 5000;



fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// fastify.register(async function (fastify) {
//   fastify.get('/websocket', { websocket: true }, (ws, request) => {

//     let streamSid = null;
//     let callSid = null;
//     let elevenLabsWs = null;
//     let customParameters = null;
//     let flag = false;
//     let eleven_AUDIO_COUNT = -1;
//     let twilio_AUDIO_COUNT = 0;

//     const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, WEITZMANGROUP_AGENT_ID, WEITZMANGROUP_API_KEY } = process.env;

//     if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !WEITZMANGROUP_AGENT_ID || !WEITZMANGROUP_API_KEY) {
//       console.error("Missing required environment variables");
//       throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID");
//     }


//     async function endTwilioInboundCall(callSid) {
//       try {
//         if (!callSid) {
//           console.error("❌ endTwilioInboundCall: Missing CallSid");
//           return;
//         }

//         // Initialize Twilio client inside the same function
//         const client = Twilio(
//           process.env.TWILIO_ACCOUNT_SID,
//           process.env.TWILIO_AUTH_TOKEN
//         );

//         await client.calls(callSid).update({ status: "completed" });

//       } catch (err) {
//         console.error("❌ Failed to end inbound call:", err);
//       }
//     }

//     async function getSignedUrl(caseType) {

//       try {
//         let parameters = ELEVENLABS_AGENT_ID;
//         let api = ELEVENLABS_API_KEY;
//         if (caseType === "weitzmangroup") {
//           parameters = WEITZMANGROUP_AGENT_ID;
//           api = WEITZMANGROUP_API_KEY;
//         }
//         const response = await fetch(
//           `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${parameters}`,
//           {
//             method: 'GET',
//             headers: {
//               'xi-api-key': api
//             }
//           }
//         );

//         if (!response.ok) {
//           throw new Error(`Failed to get signed URL: ${response.statusText}`);
//         }

//         const data = await response.json();
//         return data.signed_url;
//       } catch (error) {
//         console.error("Error getting signed URL:", error);
//         throw error;
//       }
//     }

//     const setupElevenLabs = async () => {
//       try {
//         const signedUrl = await getSignedUrl("weitzmangroup");
//         elevenLabsWs = new WebSocket(signedUrl, {
//           handshakeTimeout: 20000
//         });

//         elevenLabsWs.on("open", () => {
//           console.log("[ElevenLabs] Connected to Conversational AI");

//           const initialConfig = {
//             type: "conversation_initiation_client_data"
//           };

//           elevenLabsWs.send(JSON.stringify(initialConfig));
//         });

//         elevenLabsWs.on("message", async (data) => {
//           try {
//             const message = JSON.parse(data);
//             let outboundChunkCounter = 0;

//             console.log("___message___");
//             console.log(message);

//             switch (message.type) {
//               case "conversation_initiation_metadata":
//                 console.log("[ElevenLabs] Received initiation metadata");
//                 break;

//               case "audio":
//                 if (message.audio?.chunk) {

//                   const original = message.audio.chunk;

//                   console.log("🎙️ [Agent] Speaking detected — stopping background...");
//                   // BackgroundController.stop();

//                   ws.send(JSON.stringify({
//                     event: "incomming_call",
//                     mark: { name: "agent_inclomming" }
//                   }));

//                   // const ulaw = Buffer.from(original, "base64");

//                   // const mixed = mixChunk(ulaw);

//                   const audioData = {
//                     event: "media",
//                     media: {
//                       payload: original,
//                       track: "outbound",
//                       timestamp: Date.now().toString()
//                     },
//                   };
//                   ws.send(JSON.stringify(audioData));
//                   ws.send(JSON.stringify({
//                     event: "mark",
//                     mark: { name: "agent_done" }
//                   }));
//                   ++eleven_AUDIO_COUNT

//                 }
//                 else if (message.audio_event?.audio_base_64) {
//                   // 1. Original inbound from ElevenLabs
//                   const original = message.audio_event.audio_base_64;
//                   console.log("🎙️ [Agent] Speaking detected — stopping background...");
//                   // BackgroundController.stop();
//                   ws.send(JSON.stringify({
//                     event: "incomming_call",
//                     streamSid,
//                     mark: { name: "agent_inclomming" }
//                   }));

//                   const audioData = {
//                     event: "media",
//                     streamSid,
//                     media: {
//                       payload: original,  
//                       track: "outbound",   
//                       timestamp: Date.now().toString()
//                     },
//                   };
//                   ws.send(JSON.stringify(audioData));
//                   ws.send(JSON.stringify({
//                     event: "mark",
//                     streamSid,
//                     mark: { name: "agent_done" }
//                   }));
//                   ++eleven_AUDIO_COUNT
//                 }
//                 else {
//                   console.log("[ElevenLabs] Received audio but base_64 chunk missing");
//                 }
//                 break;

//               case "interruption":
//                 ws.send(JSON.stringify({
//                   event: "clear",
//                   streamSid
//                 }));


//                 break;

//               case "agent_response":
//                 console.log("[ElevenLabs] Agent response event:", message.agent_response_event);
//                 break;

//               case "ping":
//                 console.log("[ElevenLabs] Received ping, sending pong");
//                 if (message.ping_event?.event_id) {
//                   elevenLabsWs.send(JSON.stringify({
//                     type: "pong",
//                     event_id: message.ping_event.event_id
//                   }));

//                 }
//                 break;

//               default:
//                 console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
//             }
//           } catch (error) {
//             console.error("[ElevenLabs] Error processing message:", error);
//           }
//         });

//         elevenLabsWs.on("error", (error) => {
//           console.error("[ElevenLabs] WebSocket error:", error);
//         });

//         elevenLabsWs.on("close", () => {
//           console.log("[ElevenLabs] Disconnected");
//         });

//       } catch (error) {
//         console.error("[ElevenLabs] Setup error:", error);
//       }
//     };



//     const connection = {
//       ws,
//     }
//     let markFlag = false;
//     let callEnd = false;



//     ws.on("message", async (message) => {
//       try {
//         const msg = JSON.parse(message);

//         if (msg.event != "media") {
//           console.log("MESSAGE RECEIVED FROM TWILIO:", msg);
//         }
//         if (msg.event == "mark") {
//           console.log("EVENT :", msg.event);
//         }

//         switch (msg.event) {
//           case "start":
//             console.log("WEBAPP:ElevenLabs AI Caller connected");
//             await setupElevenLabs();
//             break;

//           case "media":
//             if (markFlag && twilio_AUDIO_COUNT == 0 && eleven_AUDIO_COUNT == -1) {
//               if (!elevenLabsWs || elevenLabsWs.readyState !== 1) {
//                 console.log("🔴 ElevenLabs is disconnected — ending Twilio call CASE:Media");

//                 if (!callEnd && connection.callSid) {
//                   await endTwilioInboundCall(connection.callSid);
//                   callEnd = true;
//                 }
//                 return;
//               }
//             }
//             if (elevenLabsWs?.readyState === WebSocket.OPEN) {
//               const audioMessage = {
//                 user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
//               };

//              elevenLabsWs.send(
//                 JSON.stringify({
//                   user_audio_chunk: msg.media.payload // base64 audio chunk
//                 })
//               );
//             }

//             break;

//           case "mark":


//             console.log(`ELEVEN LABS CHUNK COUNT, ${eleven_AUDIO_COUNT}`);
//             console.log(`TWILIO LABS CHUNK COUNT, ${twilio_AUDIO_COUNT}`);
//             markFlag = true;
//             if (eleven_AUDIO_COUNT === twilio_AUDIO_COUNT) {
//               console.log("🟢 [Agent] Finished — safe to resume background");
//               // BackgroundController.stop(); // ensure old loop dead
//               if (!elevenLabsWs || elevenLabsWs.readyState !== 1) {
//                 console.log("🔴 ElevenLabs is disconnected — ending Twilio call");
//                 twilio_AUDIO_COUNT = 0;
//                 eleven_AUDIO_COUNT = -1

//                 if (!callEnd && connection.callSid) {
//                   await endTwilioInboundCall(connection.callSid);
//                   callEnd = true

//                 }
//                 return;
//               }
//               twilio_AUDIO_COUNT = 0;
//               eleven_AUDIO_COUNT = -1
//             }
//             else {
//               twilio_AUDIO_COUNT++;
//             }
//             console.log("✔ All audio finished playing to caller!");
//             break;



//           case "stop":
//             console.log(`[Twilio] Stream ended`);
//             twilio_AUDIO_COUNT = 0;
//             eleven_AUDIO_COUNT = -1;
//             // BackgroundController.stop();

//             if (elevenLabsWs?.readyState === WebSocket.OPEN) {
//               elevenLabsWs.close();
//             }
//             break;

//           default:
//             console.log(`[Twilio] Unhandled event: ${msg.event}`);
//         }
//       } catch (error) {
//         // BackgroundController.stop(); // ensure old loop dead
//         twilio_AUDIO_COUNT = 0;
//         eleven_AUDIO_COUNT = -1;

//         console.error("[Twilio] Error processing message:", error);
//       }
//     })

//     ws.on("close", () => {
//       console.log("❌ WebSocket client disconnected");
//     });
//   });
// });
const start = async () => {
  try {
    await fastify.register(cors, {
      origin: "*",      // allow all origins
      methods: ["GET", "POST", "PUT", "DELETE"]
    });

    // Register routes after initialization
    await registerInboundRoutes(fastify);
    await registerOutboundRoutes(fastify);
    await registerSearchRoute(fastify);

    // Start listening
    await fastify.listen({
      port: PORT,
      host: "0.0.0.0",
    });

    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`🔊 WebSocket ready at ws://localhost:${PORT}/voice`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

/* ------------------------------------------------------------------
   🔴 ERROR HANDLING
-------------------------------------------------------------------*/
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
  process.exit(1);
});

start();
