// ambient-generator-and-stream.ts
import * as fs from "fs";



export function generateWhiteNoise(
  numSamples,
  amplitude 
){
  const noise = new Int16Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    // Generate white noise and scale to desired amplitude
    noise[i] = Math.round((Math.random() * 2 - 1) * amplitude);
  }

  return noise;
}




/* -------------------------
   Pink noise generator (Paul Kellet)
   ------------------------- */
function generatePinkSample(state) {
  // state holds b0..b5
  const white = Math.random() * 2 - 1;

  state.b0 = 0.99886 * state.b0 + white * 0.0555179;
  state.b1 = 0.99332 * state.b1 + white * 0.0750759;
  state.b2 = 0.96900 * state.b2 + white * 0.1538520;
  state.b3 = 0.86650 * state.b3 + white * 0.3104856;
  state.b4 = 0.55000 * state.b4 + white * 0.5329522;
  state.b5 = -0.7616 * state.b5 - white * 0.0168980;

  const pink = state.b0 + state.b1 + state.b2 + state.b3 + state.b4 + state.b5 + white * 0.5362;
  // pink center roughly around 0, typically in [-3..3], we'll scale later
  return pink;
}

/* -------------------------
   Create office ambient raw (s16le @ 8kHz)
   ------------------------- */
/**
 * Generate a telephony-friendly office ambient raw file (s16le 8kHz mono).
 *
 * @param outPath path to write .raw (s16le) e.g. "./background.raw"
 * @param durationSec length of the loop in seconds (e.g. 10)
 * @param options object: noiseAmplitude (0..1), humAmplitude, typingProbability, typingAmplitude
 */
export function generateOfficeAmbientRaw(
  outPath = "./background.raw",
  durationSec = 10,
  options= {}
) {
  const SAMPLE_RATE = 8000;
  const numSamples = Math.floor(SAMPLE_RATE * durationSec);

  const noiseAmplitude = options.noiseAmplitude ?? 0.35; // main pink noise level
  const humAmplitude = options.humAmplitude ?? 0.08; // low freq hum level
  const typingProbability = options.typingProbability ?? 1.2; // expected clicks per second
  const typingAmplitude = options.typingAmplitude ?? 0.9; // transient amplitude

  const samples = new Int16Array(numSamples);

  // Pink noise filter state
  const state = { b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0 };

  // Hum parameters (sine)
  const humFreq = 120; // in Hz (120Hz survives telephony better than 60Hz)
  const humAngular = (2 * Math.PI * humFreq) / SAMPLE_RATE;
  let humPhase = Math.random() * Math.PI * 2;

  // Typing schedule: precompute some click times
  const totalClicks = Math.round(typingProbability * durationSec);
  const clickTimes = new Set();
  for (let i = 0; i < totalClicks; i++) {
    const t = Math.floor(Math.random() * numSamples);
    clickTimes.add(t);
  }

  for (let i = 0; i < numSamples; i++) {
    // Pink noise
    const pink = generatePinkSample(state) * noiseAmplitude;

    // Hum (sine)
    const hum = Math.sin(humPhase) * humAmplitude;
    humPhase += humAngular;
    if (humPhase > Math.PI * 2) humPhase -= Math.PI * 2;

    // Click (typing) transient - short exponential decay
    let click = 0;
    if (clickTimes.has(i)) {
      // create a short click of ~40 samples (5ms at 8kHz)
      const clickLen = 40;
      for (let k = 0; k < clickLen && i + k < numSamples; k++) {
        // transient amplitude decays quickly
        const decay = Math.exp(-k / 8); // adjust decay
        const impulse = (Math.random() * 2 - 1) * typingAmplitude * 32000 * decay;
        // we add directly into samples buffer later; to keep simple, we add to pink/hum now for first sample only
        if (k === 0) {
          click += impulse;
        } else {
          // add a small immediate neighbor effect (makes click realistic)
          // we'll incorporate by directly modifying future sample (guard when within range)
          const idx = i + k;
          if (idx < numSamples) {
            // accumulate in samples array (will be added again when idx loop arrives)
            // but to avoid double-calc complexity, store into samples directly:
            samples[idx] = Math.max(-32768, Math.min(32767, Math.round((samples[idx] || 0) + impulse)));
          }
        }
      }
    }

    // Combine components
    // Base sum: pink + hum + click
    let value = pink * 3000 + hum * 3000 + click; 
    // scale pink/hum to audible PCM range. 3000 is experimental; adjust if needed.

    // Clip to 16-bit
    if (value > 32767) value = 32767;
    if (value < -32768) value = -32768;

    // If earlier clicks wrote into samples[idx] we might overwrite; but that's fine for this generator (clicks are rare)
    // Write value to samples[i] if not already set by click spill
    if (!samples[i]) {
      samples[i] = Math.round(value);
    } else {
      // if there was a pre-added click spill, combine
      const sum = samples[i] + Math.round(value);
      samples[i] = Math.max(-32768, Math.min(32767, sum));
    }
  }

  // Write as s16le raw
  fs.writeFileSync(outPath, Buffer.from(samples.buffer));
  console.log(`Generated ${outPath} (s16le 8kHz mono, ${durationSec}s)`);
}

/* -------------------------
   µ-law encoder (PCM16 -> 8bit u-law)
   ------------------------- */
function muLawEncode(sample) {
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;

  let sign = (sample < 0) ? 0x80 : 0x00;
  if (sign) sample = -sample;

  // bias
  const BIAS = 0x84; // 132
  let value = sample + BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (value & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (value >> (exponent + 3)) & 0x0F;
  const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return ulawByte;
}

export function encodeMuLawBuffer(pcm) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = muLawEncode(pcm[i]);
  }
  return out;
}
       let outboundChunkCounter = 0;

/* -------------------------
   Stream background.raw -> Twilio media stream
   connection: object { ws: WebSocket, streamSid: string }
   ------------------------- */


   const BackgroundController = {
  running: false,
  cancel: false,

  start() {
    if (this.running && !this.cancel) {
      console.log("⚠️ [BG] start() ignored — background already running");
      return;
    }
    console.log("▶️ [BG] Background STARTED");
    this.running = true;
    this.cancel = false;
  },

  stop() {
    if (this.cancel === true) {
      console.log("⚠️ [BG] stop() ignored — background already stopped");
      return;
    }
    console.log("⛔ [BG] STOP REQUESTED");
    this.cancel = true;
  }
};

export async function streamBackgroundToTwilio(
  connection,
  rawPath = "./background.raw",
  volumeFactor = 1.0,     // <-- real volume multiplier
  loop = true
) {
  if (!connection || !connection.streamSid || !connection.ws) {
    console.error("❌ [BG] Cannot start — missing Twilio connection");
    return;
  }

  BackgroundController.start();

  console.log(`🔊 [BG] Loading raw file: ${rawPath}`);

  const pcmBuf = fs.readFileSync(rawPath);
  const SAMPLES = 160; // 20ms
  const FRAME = SAMPLES * 2;

  let offset = 0;
  let frameCount = 0;

  console.log("🎧 [BG] Streaming started…");

  while (BackgroundController.running && !BackgroundController.cancel) {

    if (offset + FRAME > pcmBuf.length) {
      if (loop) {
        console.log("🔁 [BG] Looping background audio…");
        offset = 0;
      } else {
        console.log("📦 [BG] Reached end of file — stopping");
        break;
      }
    }

    // Extract PCM samples
    const samples = new Int16Array(
      pcmBuf.buffer,
      pcmBuf.byteOffset + offset,
      SAMPLES
    );

    // REAL VOLUME CONTROL — dim the background
    if (volumeFactor !== 1.0) {
      for (let i = 0; i < samples.length; i++) {
        let v = samples[i] * volumeFactor;

        // clip to avoid distortion
        if (v > 32767) v = 32767;
        if (v < -32768) v = -32768;

        samples[i] = v;
      }
    }

    // µ-law encoding
    const payload = encodeMuLawBuffer(samples).toString("base64");

    connection.ws.send(
      JSON.stringify({
        event: "media",
        streamSid: connection.streamSid,
        media: { payload, track: "background" }
      })
    );

    frameCount++;
    console.log(`📨 [BG] Sent frame #${frameCount}, offset=${offset}, volume=${volumeFactor}`);

    offset += FRAME;

    await new Promise((r) => setTimeout(r, 10));
  }

  BackgroundController.running = false;
  console.log("🛑 [BG] Background FULLY STOPPED (loop exited)");
}



export {
  BackgroundController
}