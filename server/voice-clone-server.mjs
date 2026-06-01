/**
 * Voice Clone Server
 * Provides voice model training, voice conversion (VC), and text-to-speech (TTS).
 * Supports three backends:
 *   - Fish Audio (cloud API, requires API key) — TTS only
 *   - GPT-SoVITS (local deployment, requires running instance)
 *   - RVC (Retrieval-based Voice Conversion, local) — VC + TTS
 *
 * Endpoints:
 *   GET  /status          — server health + backend availability
 *   GET  /models          — list trained voice models
 *   POST /train           — upload audio files to train a new voice model
 *   POST /tts             — text-to-speech with a trained model
 *   POST /convert         — voice conversion on an uploaded audio file
 *   DELETE /models/:id    — delete a trained model
 */

import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, createReadStream, createWriteStream } from "node:fs";
import { dirname, join, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  checkRemoteServiceAuth,
  getServiceBindHost,
  remoteServiceAuthFailureResponse,
} from "./fmz-remote-service-auth.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.VOICE_CLONE_PORT || "8793", 10);

// ─── Data directories ───────────────────────────────────────────────────────
const DATA_DIR = join(__dirname, "data", "voice-clone");
const MODELS_DIR = join(DATA_DIR, "models");
const UPLOADS_DIR = join(DATA_DIR, "uploads");
const OUTPUT_DIR = join(DATA_DIR, "output");

for (const d of [DATA_DIR, MODELS_DIR, UPLOADS_DIR, OUTPUT_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ─── Keys file (same pattern as ai-agent-keys.json) ─────────────────────────
const KEYS_FILE = join(__dirname, "data", "voice-clone-keys.json");
let fileKeys = {};
try {
  if (existsSync(KEYS_FILE)) {
    const raw = readFileSync(KEYS_FILE, "utf-8").replace(/^\uFEFF/, "");
    fileKeys = JSON.parse(raw);
    console.log(`[voice-clone] Loaded API keys from ${KEYS_FILE}`);
  }
} catch (err) {
  console.warn(`[voice-clone] Failed to read ${KEYS_FILE}:`, err.message);
}

/** Resolve Fish Audio API key: env var > keys file > config.json */
function resolveFishAudioKey(configValue) {
  const fromEnv = (process.env.FISH_AUDIO_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const fromFile = typeof fileKeys.fishAudio === "string" ? fileKeys.fishAudio.trim() : "";
  if (fromFile) return fromFile;
  return configValue || "";
}

// ─── Config ─────────────────────────────────────────────────────────────────
const CONFIG_PATH = join(DATA_DIR, "config.json");

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return {
      backend: "rvc", // "fish-audio" | "gpt-sovits" | "rvc"
      fishAudio: {
        apiKey: resolveFishAudioKey(""),
        baseUrl: "https://api.fish.audio",
      },
      gptSovits: {
        baseUrl: "http://127.0.0.1:9880",
      },
      rvc: {
        baseUrl: "http://127.0.0.1:7865",
        pitchShift: 0,
        indexRate: 0.75,
        filterRadius: 3,
        rmsMixRate: 0.25,
        protect: 0.33,
      },
    };
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  // Ensure rvc config exists for older config files
  if (!cfg.rvc) {
    cfg.rvc = {
      baseUrl: "http://127.0.0.1:7865",
      pitchShift: 0,
      indexRate: 0.75,
      filterRadius: 3,
      rmsMixRate: 0.25,
      protect: 0.33,
    };
  }
  // Resolve fishAudio apiKey from env / keys file / config (priority order)
  if (cfg.fishAudio) {
    cfg.fishAudio.apiKey = resolveFishAudioKey(cfg.fishAudio.apiKey);
  }
  return cfg;
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

// ─── Models registry ────────────────────────────────────────────────────────
const MODELS_REGISTRY_PATH = join(DATA_DIR, "models-registry.json");

function loadModelsRegistry() {
  if (!existsSync(MODELS_REGISTRY_PATH)) return [];
  return JSON.parse(readFileSync(MODELS_REGISTRY_PATH, "utf-8"));
}

function saveModelsRegistry(models) {
  writeFileSync(MODELS_REGISTRY_PATH, JSON.stringify(models, null, 2), "utf-8");
}

// ─── Multipart parser (simple boundary-based) ───────────────────────────────
function parseContentType(ct) {
  const m = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(ct || "");
  return m ? (m[1] || m[2]) : null;
}

async function collectBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Minimal multipart/form-data parser.
 * Returns { fields: Record<string, string>, files: Array<{name, filename, data: Buffer, mime}> }
 */
function parseMultipart(body, boundary) {
  const sep = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = body.indexOf(sep) + sep.length;

  while (true) {
    // skip CRLF after boundary
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    const end = body.indexOf(sep, start);
    if (end === -1) break;
    const part = body.slice(start, end - 2); // -2 for trailing CRLF before next boundary
    parts.push(part);
    start = end + sep.length;
    // check if this is the closing boundary (--)
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
  }

  const fields = {};
  const files = [];

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerStr = part.slice(0, headerEnd).toString("utf-8");
    const data = part.slice(headerEnd + 4);

    const nameMatch = /name="([^"]+)"/.exec(headerStr);
    const filenameMatch = /filename="([^"]*)"/.exec(headerStr);
    const mimeMatch = /Content-Type:\s*(.+)/i.exec(headerStr);

    if (!nameMatch) continue;
    const name = nameMatch[1];

    if (filenameMatch) {
      files.push({
        name,
        filename: filenameMatch[1],
        data,
        mime: mimeMatch ? mimeMatch[1].trim() : "application/octet-stream",
      });
    } else {
      fields[name] = data.toString("utf-8");
    }
  }

  return { fields, files };
}

// ─── Fish Audio backend ─────────────────────────────────────────────────────
async function fishAudioTrain(modelName, audioFiles, config) {
  const { apiKey, baseUrl } = config.fishAudio;
  if (!apiKey) throw new Error("Fish Audio API key not configured");

  // Create a model via Fish Audio API
  const boundary = `----FishBoundary${Date.now()}`;
  const parts = [];

  // Add model name field
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="visibility"\r\n\r\nprivate`,
    `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ntts`,
    `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${modelName}`,
    `--${boundary}\r\nContent-Disposition: form-data; name="train_mode"\r\n\r\nfast`,
  );

  // Add audio files
  for (const file of audioFiles) {
    const ext = extname(file.filename).toLowerCase() || ".wav";
    const mime = file.mime || "audio/wav";
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="voices"; filename="${file.filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    );
  }

  // Build the multipart body manually with binary data
  const textParts = parts.map((p) => Buffer.from(p + "\r\n", "utf-8"));
  const bodyParts = [];
  let fileIdx = 0;
  const numTextFields = 4; // visibility, type, title, train_mode
  for (let i = 0; i < textParts.length; i++) {
    bodyParts.push(textParts[i]);
    // After the text field parts, attach file data for each file header
    if (i >= numTextFields) {
      bodyParts.push(audioFiles[fileIdx].data);
      bodyParts.push(Buffer.from("\r\n", "utf-8"));
      fileIdx++;
    }
  }
  bodyParts.push(Buffer.from(`--${boundary}--\r\n`, "utf-8"));
  const body = Buffer.concat(bodyParts);

  const resp = await fetch(`${baseUrl}/model`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Fish Audio train failed (${resp.status}): ${errText}`);
  }

  const result = await resp.json();
  return {
    id: result._id || result.id || randomUUID(),
    remoteId: result._id || result.id,
    backend: "fish-audio",
  };
}

async function fishAudioTTS(text, modelId, config) {
  const { apiKey, baseUrl } = config.fishAudio;
  if (!apiKey) throw new Error("Fish Audio API key not configured");

  const resp = await fetch(`${baseUrl}/v1/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      reference_id: modelId,
      format: "mp3",
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Fish Audio TTS failed (${resp.status}): ${errText}`);
  }

  return resp;
}

async function fishAudioConvert(audioBuffer, modelId, config) {
  const { apiKey, baseUrl } = config.fishAudio;
  if (!apiKey) throw new Error("Fish Audio API key not configured");

  const boundary = `----FishBoundary${Date.now()}`;
  const bodyParts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reference_id"\r\n\r\n${modelId}\r\n`, "utf-8"),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n\r\n`, "utf-8"),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="input.wav"\r\nContent-Type: audio/wav\r\n\r\n`, "utf-8"),
    audioBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8"),
  ];
  const body = Buffer.concat(bodyParts);

  const resp = await fetch(`${baseUrl}/v1/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Fish Audio VC failed (${resp.status}): ${errText}`);
  }

  return resp;
}

// ─── GPT-SoVITS backend ─────────────────────────────────────────────────────
async function gptSovitsTTS(text, modelInfo, config) {
  const { baseUrl } = config.gptSovits;

  const resp = await fetch(`${baseUrl}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      text_lang: "zh",
      ref_audio_path: modelInfo.refAudioPath || "",
      prompt_text: modelInfo.promptText || "",
      prompt_lang: "zh",
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`GPT-SoVITS TTS failed (${resp.status}): ${errText}`);
  }

  return resp;
}

async function gptSovitsConvert(audioBuffer, modelInfo, config) {
  const { baseUrl } = config.gptSovits;

  // GPT-SoVITS voice conversion endpoint
  const boundary = `----SoVITSBoundary${Date.now()}`;
  const bodyParts = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="ref_audio_path"\r\n\r\n${modelInfo.refAudioPath || ""}\r\n`, "utf-8"),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="input.wav"\r\nContent-Type: audio/wav\r\n\r\n`, "utf-8"),
    audioBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8"),
  ];
  const body = Buffer.concat(bodyParts);

  const resp = await fetch(`${baseUrl}/voice_conversion`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`GPT-SoVITS VC failed (${resp.status}): ${errText}`);
  }

  return resp;
}

// ─── RVC backend ────────────────────────────────────────────────────────────
/**
 * RVC voice conversion: sends audio to local RVC-WebUI via Gradio API.
 * Uses fn_index=2 (vc_single) which accepts:
 *   [sid, input_audio_path, f0_up_key, f0_file, f0_method,
 *    file_index, file_index2, index_rate, filter_radius,
 *    resample_sr, rms_mix_rate, protect]
 * Returns: [info_text, audio_output]
 */
async function rvcConvert(audioBuffer, modelInfo, config) {
  const { baseUrl, pitchShift, indexRate, filterRadius, rmsMixRate, protect } = config.rvc;

  // Save input audio to a temp file (RVC-WebUI reads from local path)
  const inputPath = join(UPLOADS_DIR, `rvc_input_${Date.now()}.wav`);
  writeFileSync(inputPath, audioBuffer);

  try {
    // Call RVC-WebUI Gradio API (fn_index=2 = vc_single)
    const resp = await fetch(`${baseUrl}/api/predict/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fn_index: 2,
        data: [
          modelInfo.rvcModelName || modelInfo.name || "0",  // sid (speaker/model name from dropdown)
          inputPath.replace(/\\/g, "/"),                     // input_audio_path
          pitchShift || 0,                                   // f0_up_key (pitch shift in semitones)
          null,                                              // f0_file (optional F0 curve)
          "rmvpe",                                           // f0_method (best quality)
          modelInfo.rvcIndexPath || "",                      // file_index (index file path)
          "",                                                // file_index2 (fallback index)
          indexRate ?? 0.75,                                  // index_rate
          filterRadius ?? 3,                                  // filter_radius
          0,                                                 // resample_sr (0 = no resample)
          rmsMixRate ?? 0.25,                                 // rms_mix_rate
          protect ?? 0.33,                                    // protect
        ],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`RVC-WebUI Gradio API failed (${resp.status}): ${errText}`);
    }

    const result = await resp.json();
    // result.data = [info_text, {name: filepath, data: null, is_file: true}]
    const audioOutput = result.data?.[1];

    if (!audioOutput) {
      const infoText = result.data?.[0] || "Unknown error";
      throw new Error(`RVC conversion failed: ${infoText}`);
    }

    // audioOutput can be: {name: "path/to/file.wav", data: null, is_file: true}
    // or {name: "path", data: "base64...", is_file: false}
    let audioData;
    if (audioOutput.is_file && audioOutput.name) {
      // File is on disk, try to read it directly or fetch from Gradio file server
      const filePath = audioOutput.name;
      if (existsSync(filePath)) {
        audioData = readFileSync(filePath);
      } else {
        // Try fetching from Gradio's file endpoint
        const fileResp = await fetch(`${baseUrl}/file=${filePath}`);
        if (!fileResp.ok) throw new Error(`Failed to fetch RVC output file: ${fileResp.status}`);
        audioData = Buffer.from(await fileResp.arrayBuffer());
      }
    } else if (audioOutput.data) {
      // Base64 encoded audio data
      const base64Data = audioOutput.data.replace(/^data:audio\/\w+;base64,/, "");
      audioData = Buffer.from(base64Data, "base64");
    } else {
      throw new Error("RVC returned unexpected output format");
    }

    // Cleanup input temp file
    try { unlinkSync(inputPath); } catch {}

    return new Response(audioData, {
      headers: { "content-type": "audio/wav" },
    });
  } catch (err) {
    // Cleanup on error
    try { unlinkSync(inputPath); } catch {}
    throw err;
  }
}

/**
 * RVC model training: sends audio files to RVC for training.
 * Returns model info with paths to the trained .pth and .index files.
 */
async function rvcTrain(modelName, audioFiles, config) {
  const { baseUrl } = config.rvc;

  // Save audio files locally for RVC training
  const modelId = randomUUID();
  const modelDir = join(MODELS_DIR, modelId);
  const datasetDir = join(modelDir, "dataset");
  mkdirSync(datasetDir, { recursive: true });

  for (let i = 0; i < audioFiles.length; i++) {
    const ext = extname(audioFiles[i].filename) || ".wav";
    const savePath = join(datasetDir, `audio_${i}${ext}`);
    writeFileSync(savePath, audioFiles[i].data);
  }

  try {
    // Call RVC training API
    const resp = await fetch(`${baseUrl}/train`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model_name: modelName,
        dataset_path: datasetDir,
        epochs: 50,
        batch_size: 8,
        sample_rate: 40000,
      }),
    });

    if (resp.ok) {
      const result = await resp.json();
      return {
        id: modelId,
        rvcModelPath: result.model_path || "",
        rvcIndexPath: result.index_path || "",
        rvcModelName: modelName,
        backend: "rvc",
      };
    }

    // If training API not available, save files and mark as pending
    console.warn("[voice-clone] RVC training API not available, saving dataset for manual training");
    return {
      id: modelId,
      rvcModelPath: "",
      rvcIndexPath: "",
      rvcModelName: modelName,
      datasetDir,
      backend: "rvc",
    };
  } catch (err) {
    console.warn("[voice-clone] RVC training API error:", err.message);
    // Still save the model entry with dataset for manual training
    return {
      id: modelId,
      rvcModelPath: "",
      rvcIndexPath: "",
      rvcModelName: modelName,
      datasetDir,
      backend: "rvc",
    };
  }
}

// ─── HTTP Server ────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-FMZ-Remote-Secret");
}

function json(res, data, status = 200) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res, msg, status = 500) {
  json(res, { error: msg }, status);
}

const BIND_HOST = getServiceBindHost("127.0.0.1");

const server = http.createServer(async (req, res) => {
  const auth = checkRemoteServiceAuth(req, { bindHost: BIND_HOST, logTag: "voice-clone" });
  if (remoteServiceAuthFailureResponse(req, res, auth, (r, st, d) => json(r, d, st))) return;

  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // ─── GET /status ──────────────────────────────────────────────────
    if (path === "/status" && req.method === "GET") {
      const config = loadConfig();
      const status = { backend: config.backend, ok: true };

      if (config.backend === "fish-audio") {
        status.configured = !!config.fishAudio.apiKey;
        status.capabilities = ["tts"]; // Fish Audio only supports TTS
      } else if (config.backend === "rvc") {
        // Check if RVC-WebUI (Gradio) is reachable via /config endpoint
        try {
          const r = await fetch(`${config.rvc.baseUrl}/config`, { signal: AbortSignal.timeout(3000) });
          status.configured = r.ok;
        } catch {
          // Fallback: try root endpoint
          try {
            const r2 = await fetch(`${config.rvc.baseUrl}/`, { signal: AbortSignal.timeout(3000) });
            status.configured = true; // If it responds at all, it's running
          } catch {
            status.configured = false;
          }
        }
        status.capabilities = ["convert"]; // RVC supports voice conversion only
      } else {
        // Check if GPT-SoVITS is reachable
        try {
          const r = await fetch(`${config.gptSovits.baseUrl}/`, { signal: AbortSignal.timeout(3000) });
          status.configured = r.ok;
        } catch {
          status.configured = false;
        }
        status.capabilities = ["tts", "convert"];
      }
      return json(res, status);
    }

    // ─── GET /config ──────────────────────────────────────────────────
    if (path === "/config" && req.method === "GET") {
      const config = loadConfig();
      // Mask API key
      const safe = { ...config };
      if (safe.fishAudio?.apiKey) {
        safe.fishAudio = { ...safe.fishAudio, apiKey: safe.fishAudio.apiKey.replace(/.(?=.{4})/g, "*") };
      }
      return json(res, safe);
    }

    // ─── PUT /config ──────────────────────────────────────────────────
    if (path === "/config" && req.method === "PUT") {
      const body = await collectBody(req);
      const update = JSON.parse(body.toString("utf-8"));
      const config = loadConfig();
      if (update.backend) config.backend = update.backend;
      if (update.fishAudio) {
        if (update.fishAudio.apiKey !== undefined) config.fishAudio.apiKey = update.fishAudio.apiKey;
        if (update.fishAudio.baseUrl) config.fishAudio.baseUrl = update.fishAudio.baseUrl;
      }
      if (update.gptSovits) {
        if (update.gptSovits.baseUrl) config.gptSovits.baseUrl = update.gptSovits.baseUrl;
      }
      if (update.rvc) {
        if (update.rvc.baseUrl) config.rvc.baseUrl = update.rvc.baseUrl;
        if (update.rvc.pitchShift !== undefined) config.rvc.pitchShift = update.rvc.pitchShift;
        if (update.rvc.indexRate !== undefined) config.rvc.indexRate = update.rvc.indexRate;
        if (update.rvc.filterRadius !== undefined) config.rvc.filterRadius = update.rvc.filterRadius;
        if (update.rvc.rmsMixRate !== undefined) config.rvc.rmsMixRate = update.rvc.rmsMixRate;
        if (update.rvc.protect !== undefined) config.rvc.protect = update.rvc.protect;
      }
      saveConfig(config);
      return json(res, { ok: true });
    }

    // ─── GET /models ──────────────────────────────────────────────────
    if (path === "/models" && req.method === "GET") {
      const models = loadModelsRegistry();
      return json(res, models);
    }

    // ─── POST /train ──────────────────────────────────────────────────
    if (path === "/train" && req.method === "POST") {
      const contentType = req.headers["content-type"] || "";
      const boundary = parseContentType(contentType);
      if (!boundary) return error(res, "Expected multipart/form-data", 400);

      const body = await collectBody(req);
      const { fields, files } = parseMultipart(body, boundary);

      const modelName = fields.name || `Model_${Date.now()}`;
      let audioFiles = files.filter((f) => f.name === "audio" || f.name === "audios");

      // Support libraryPaths: read audio files directly from the local audio library
      const AUDIO_DATA_DIR = join(__dirname, "data", "audio");
      if (fields.libraryPaths) {
        try {
          const paths = JSON.parse(fields.libraryPaths);
          for (const relPath of paths) {
            // relPath format: "{bvid}/music/{filename}" or "{bvid}/p{N}/music/{filename}"
            const fullPath = join(AUDIO_DATA_DIR, relPath);
            if (existsSync(fullPath)) {
              const data = readFileSync(fullPath);
              const filename = basename(relPath);
              audioFiles.push({ name: "audio", filename, data });
            }
          }
        } catch (e) {
          console.warn("[voice-clone] Failed to parse libraryPaths:", e.message);
        }
      }

      if (audioFiles.length === 0) return error(res, "No audio files provided", 400);

      const config = loadConfig();
      const modelId = randomUUID();
      let remoteId = null;
      let refAudioPath = "";

      if (config.backend === "fish-audio") {
        const result = await fishAudioTrain(modelName, audioFiles, config);
        remoteId = result.remoteId;
      } else if (config.backend === "rvc") {
        const result = await rvcTrain(modelName, audioFiles, config);
        const rvcModelEntry = {
          id: result.id,
          name: modelName,
          backend: "rvc",
          rvcModelPath: result.rvcModelPath,
          rvcIndexPath: result.rvcIndexPath,
          rvcModelName: result.rvcModelName,
          audioCount: audioFiles.length,
          createdAt: new Date().toISOString(),
          status: result.rvcModelPath ? "ready" : "pending",
          promptText: fields.promptText || "",
        };
        const models = loadModelsRegistry();
        models.push(rvcModelEntry);
        saveModelsRegistry(models);
        return json(res, rvcModelEntry, 201);
      } else {
        // GPT-SoVITS: save reference audio locally
        const modelDir = join(MODELS_DIR, modelId);
        mkdirSync(modelDir, { recursive: true });
        for (let i = 0; i < audioFiles.length; i++) {
          const ext = extname(audioFiles[i].filename) || ".wav";
          const savePath = join(modelDir, `ref_${i}${ext}`);
          writeFileSync(savePath, audioFiles[i].data);
          if (i === 0) refAudioPath = savePath;
        }
      }

      const modelEntry = {
        id: modelId,
        name: modelName,
        backend: config.backend,
        remoteId,
        refAudioPath,
        promptText: fields.promptText || "",
        audioCount: audioFiles.length,
        createdAt: new Date().toISOString(),
        status: config.backend === "fish-audio" ? "training" : "ready",
      };

      const models = loadModelsRegistry();
      models.push(modelEntry);
      saveModelsRegistry(models);

      return json(res, modelEntry, 201);
    }

    // ─── POST /tts ────────────────────────────────────────────────────
    if (path === "/tts" && req.method === "POST") {
      const body = await collectBody(req);
      const { text, modelId } = JSON.parse(body.toString("utf-8"));

      if (!text) return error(res, "text is required", 400);
      if (!modelId) return error(res, "modelId is required", 400);

      const models = loadModelsRegistry();
      const model = models.find((m) => m.id === modelId);
      if (!model) return error(res, "Model not found", 404);

      const config = loadConfig();
      let audioResp;

      if (model.backend === "fish-audio") {
        audioResp = await fishAudioTTS(text, model.remoteId || model.id, config);
      } else if (model.backend === "rvc") {
        // RVC doesn't natively support TTS, use Fish Audio TTS then convert
        // Or if Fish Audio is not configured, return error
        if (config.fishAudio?.apiKey && model.rvcModelPath) {
          // Generate TTS with Fish Audio, then convert with RVC
          const ttsResp = await fishAudioTTS(text, model.remoteId || "default", config);
          if (ttsResp.ok) {
            const ttsBuffer = Buffer.from(await ttsResp.arrayBuffer());
            audioResp = await rvcConvert(ttsBuffer, model, config);
          } else {
            return error(res, "TTS generation failed for RVC pipeline", 500);
          }
        } else {
          return error(res, "RVC TTS requires a configured Fish Audio API key for text generation, or use voice conversion directly", 400);
        }
      } else {
        audioResp = await gptSovitsTTS(text, model, config);
      }

      // Stream audio response back
      cors(res);
      res.writeHead(200, {
        "Content-Type": audioResp.headers.get("content-type") || "audio/mpeg",
        "Transfer-Encoding": "chunked",
      });

      const reader = audioResp.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
      return;
    }

    // ─── POST /convert ────────────────────────────────────────────────
    if (path === "/convert" && req.method === "POST") {
      const contentType = req.headers["content-type"] || "";
      const boundary = parseContentType(contentType);
      if (!boundary) return error(res, "Expected multipart/form-data", 400);

      const body = await collectBody(req);
      const { fields, files } = parseMultipart(body, boundary);

      const modelId = fields.modelId;
      if (!modelId) return error(res, "modelId is required", 400);

      const audioFile = files.find((f) => f.name === "audio");
      if (!audioFile) return error(res, "audio file is required", 400);

      const models = loadModelsRegistry();
      const model = models.find((m) => m.id === modelId);
      if (!model) return error(res, "Model not found", 404);

      const config = loadConfig();
      let audioResp;

      if (model.backend === "fish-audio") {
        audioResp = await fishAudioConvert(audioFile.data, model.remoteId || model.id, config);
      } else if (model.backend === "rvc") {
        audioResp = await rvcConvert(audioFile.data, model, config);
      } else {
        audioResp = await gptSovitsConvert(audioFile.data, model, config);
      }

      // Stream audio response back
      cors(res);
      res.writeHead(200, {
        "Content-Type": audioResp.headers.get("content-type") || "audio/wav",
        "Transfer-Encoding": "chunked",
      });

      const reader = audioResp.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
      return;
    }

    // ─── DELETE /models/:id ───────────────────────────────────────────
    const deleteMatch = /^\/models\/([a-f0-9-]+)$/.exec(path);
    if (deleteMatch && req.method === "DELETE") {
      const id = deleteMatch[1];
      let models = loadModelsRegistry();
      const model = models.find((m) => m.id === id);
      if (!model) return error(res, "Model not found", 404);

      models = models.filter((m) => m.id !== id);
      saveModelsRegistry(models);

      // Clean up local files if GPT-SoVITS or RVC
      if (model.backend === "gpt-sovits" || model.backend === "rvc") {
        const modelDir = join(MODELS_DIR, id);
        if (existsSync(modelDir)) {
          // Recursively delete model directory
          const deleteDir = (dir) => {
            for (const f of readdirSync(dir, { withFileTypes: true })) {
              const fullPath = join(dir, f.name);
              if (f.isDirectory()) deleteDir(fullPath);
              else unlinkSync(fullPath);
            }
            try { unlinkSync(dir); } catch { /* dir removal */ }
          };
          deleteDir(modelDir);
        }
      }

      return json(res, { ok: true, deleted: id });
    }

    // ─── 404 ─────────────────────────────────────────────────────────
    return error(res, "Not found", 404);

  } catch (err) {
    console.error("[voice-clone] Error:", err);
    return error(res, err.message || "Internal server error", 500);
  }
});

server.listen(PORT, BIND_HOST, () => {
  console.log(`[voice-clone] Voice Clone Server listening on http://${BIND_HOST}:${PORT}`);
  const config = loadConfig();
  console.log(`[voice-clone] Backend: ${config.backend}`);
});
