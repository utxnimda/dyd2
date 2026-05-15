/**
 * AI Agent Proxy Server
 * Holds API keys server-side; frontend only selects model ID.
 * Exposes:
 *   GET  /models  — list available models
 *   POST /chat    — proxy chat completion (streaming SSE)
 */

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.AI_AGENT_PORT || "8792", 10);

/* ------------------------------------------------------------------ */
/*  Load API keys from config file or environment variables           */
/* ------------------------------------------------------------------ */

const KEYS_FILE = join(__dirname, "data", "ai-agent-keys.json");
let fileKeys = {};
try {
  if (existsSync(KEYS_FILE)) {
    fileKeys = JSON.parse(readFileSync(KEYS_FILE, "utf-8"));
    console.log(`[ai-agent] Loaded API keys from ${KEYS_FILE}`);
  }
} catch (err) {
  console.warn(`[ai-agent] Failed to read ${KEYS_FILE}:`, err.message);
}

/** Resolve an API key: env var takes priority, then config file */
function resolveKey(envVar, fileField) {
  return process.env[envVar] || fileKeys[fileField] || "";
}

/* ------------------------------------------------------------------ */
/*  Model Providers Configuration                                     */
/*  API keys are read from environment variables or hardcoded below.  */
/* ------------------------------------------------------------------ */

/**
 * Each provider entry:
 *   id       — unique model identifier (sent from frontend)
 *   label    — display name
 *   provider — provider name for grouping
 *   apiUrl   — chat completions endpoint (OpenAI-compatible)
 *   apiKey   — bearer token
 *   model    — model name to send in the request body
 */
const MODEL_PROVIDERS = [
  {
    id: "gemini-2.0-flash",
    label: "Gemini",
    provider: "Google",
    apiUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    apiKey: resolveKey("GEMINI_API_KEY", "gemini"),
    model: "gemini-2.0-flash",
  },
];

/** Only expose models that have a valid API key configured */
function getAvailableModels() {
  return MODEL_PROVIDERS.filter((m) => m.apiKey).map((m) => ({
    id: m.id,
    label: m.label,
    provider: m.provider,
  }));
}

function findModel(id) {
  return MODEL_PROVIDERS.find((m) => m.id === id && m.apiKey);
}

/* ------------------------------------------------------------------ */
/*  HTTP Server                                                       */
/* ------------------------------------------------------------------ */

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // GET /models
  if (req.method === "GET" && url.pathname === "/models") {
    return sendJson(res, 200, { models: getAvailableModels() });
  }

  // POST /chat
  if (req.method === "POST" && url.pathname === "/chat") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "Invalid JSON body" });
    }

    const { modelId, messages } = body;
    if (!modelId || !Array.isArray(messages)) {
      return sendJson(res, 400, { error: "Missing modelId or messages" });
    }

    const provider = findModel(modelId);
    if (!provider) {
      return sendJson(res, 404, { error: `Model "${modelId}" not available` });
    }

    // Proxy to upstream with streaming
    try {
      const upstream = await fetch(provider.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          messages,
          stream: true,
        }),
      });

      if (!upstream.ok) {
        const errText = await upstream.text();
        return sendJson(res, upstream.status, {
          error: `Upstream error (${upstream.status}): ${errText.slice(0, 500)}`,
        });
      }

      // Stream SSE back to client
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
      }

      res.end();
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: `Proxy error: ${err.message}` });
      } else {
        res.end();
      }
    }
    return;
  }

  // 404
  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[ai-agent] 🤖 AI Agent proxy server running on http://127.0.0.1:${PORT}`);
  const available = getAvailableModels();
  if (available.length === 0) {
    console.log("[ai-agent] ⚠️  No API keys configured! Set GEMINI_API_KEY env var or edit data/ai-agent-keys.json.");
  } else {
    console.log(`[ai-agent]    Available models: ${available.map((m) => m.id).join(", ")}`);
  }
});
