/**
 * AI Agent Proxy Server
 * Holds API keys server-side; frontend only selects model ID.
 * Exposes:
 *   GET  /models  — list available models（仅含当前可达、且已配置密钥的条目；meta.reachability 为心跳状态）
 *   POST /chat    — proxy chat completion (streaming SSE)（不可达模型返回 404）
 */

import http from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { geminiEligibleForOpenAiCompatTextChat } from "./gemini-openai-compat-chat-filter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.AI_AGENT_PORT || "8792", 10);

const LOCAL_AI_AGENT_ENV = join(__dirname, "local-ai-agent.env");

/**
 * Optional `server/local-ai-agent.env` (gitignored): KEY=value lines.
 * Only assigns `process.env[key]` when the key is not already set (CLI / 系统环境优先).
 */
function loadOptionalLocalAiAgentEnv() {
  if (!existsSync(LOCAL_AI_AGENT_ENV)) return;
  let count = 0;
  const text = readFileSync(LOCAL_AI_AGENT_ENV, "utf-8").replace(/^\uFEFF/, "");
  for (const line of text.split(/\n/)) {
    const t = line.replace(/\r$/, "").trim();
    if (!t || t.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (
      (val.startsWith("\"") && val.endsWith("\""))
      || (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
      count += 1;
    }
  }
  if (count > 0) {
    console.log(`[ai-agent] 已从 local-ai-agent.env 补充 ${count} 个环境变量（不覆盖已存在的变量）`);
  }
}

/** 专门给 Gemini 出站（list models / chat）用的本地 HTTP 混合端口；优先级最高，覆盖 Windows 注册表里的系统代理 */
function localMixedProxyEnvUrl() {
  return process.env.FMZ_AI_AGENT_LOCAL_PROXY?.trim() || "";
}

function outboundProxyEnvUrl() {
  return (
    process.env.FMZ_AI_AGENT_HTTPS_PROXY?.trim()
    || process.env.HTTPS_PROXY?.trim()
    || process.env.https_proxy?.trim()
    || process.env.FMZ_AI_AGENT_HTTP_PROXY?.trim()
    || process.env.HTTP_PROXY?.trim()
    || process.env.http_proxy?.trim()
    || ""
  );
}

const WIN_INET_HKCU = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const WIN_INET_HKLM = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

function regQueryLine(hivePath, valueName) {
  try {
    return execFileSync("reg.exe", ["query", hivePath, "/v", valueName], {
      encoding: "utf-8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function regQueryDword(hivePath, valueName) {
  const out = regQueryLine(hivePath, valueName);
  if (!out) return null;
  const re = new RegExp(`${valueName}\\s+REG_DWORD\\s+0x([0-9a-fA-F]+)`, "i");
  const m = re.exec(out);
  return m ? Number.parseInt(m[1], 16) : null;
}

function regQuerySz(hivePath, valueName) {
  const out = regQueryLine(hivePath, valueName);
  if (!out) return null;
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(valueName) || !line.includes("REG_SZ")) continue;
    const idx = line.indexOf("REG_SZ");
    return line.slice(idx + 6).trim();
  }
  return null;
}

/** 将「Internet 设置」里的 ProxyServer 转成 undici ProxyAgent 可用的 URL */
function proxyServerRegistryToUndiciUrl(proxyServer) {
  if (!proxyServer || typeof proxyServer !== "string") return "";
  const s = proxyServer.trim();
  if (!s) return "";

  if (/^https?:\/\//i.test(s)) return s;

  if (s.includes("=")) {
    const parts = s.split(";").map((p) => p.trim()).filter(Boolean);
    const https = parts.find((p) => /^https=/i.test(p));
    const http = parts.find((p) => /^http=/i.test(p));
    const socks = parts.find((p) => /^socks5?=/i.test(p));
    const pick = https || http || socks || parts[0];
    const eq = pick.indexOf("=");
    if (eq === -1) return "";
    const scheme = pick.slice(0, eq).toLowerCase().trim();
    const rest = pick.slice(eq + 1).trim().replace(/^\/\//, "");
    if (!rest) return "";
    if (scheme === "socks" || scheme === "socks5") return `socks5://${rest}`;
    if (scheme === "http" || scheme === "https") return rest.includes("://") ? rest : `http://${rest}`;
    return "";
  }

  return `http://${s.replace(/^\/\//, "")}`;
}

/** 读取 Windows「系统代理」模式写入的注册表（依赖 reg.exe，无额外依赖） */
function tryWindowsSystemProxyUrl() {
  if (process.platform !== "win32") return "";
  if (process.env.FMZ_AI_AGENT_SKIP_SYSTEM_PROXY === "1") return "";

  for (const hivePath of [WIN_INET_HKCU, WIN_INET_HKLM]) {
    const enable = regQueryDword(hivePath, "ProxyEnable");
    if (enable !== 1) continue;
    const server = regQuerySz(hivePath, "ProxyServer");
    const url = proxyServerRegistryToUndiciUrl(server || "");
    if (url) {
      console.log(`[ai-agent] 已读取 Windows 系统代理（${hivePath}）`);
      return url;
    }
  }

  const pac = regQuerySz(WIN_INET_HKCU, "AutoConfigURL") || regQuerySz(WIN_INET_HKLM, "AutoConfigURL");
  if (pac && !outboundProxyEnvUrl()) {
    console.warn(
      "[ai-agent] 检测到 PAC 自动代理（AutoConfigURL），无法自动转为 Node 代理；请在 local-ai-agent.env 或环境变量中设置 HTTPS_PROXY。",
    );
  }
  return "";
}

function redactProxyUrlForLog(url) {
  try {
    const u = new URL(url);
    const host = u.hostname + (u.port ? `:${u.port}` : "");
    if (u.username || u.password) return `${u.protocol}//****@${host}`;
    return `${u.protocol}//${host}`;
  } catch {
    return "(无效的代理 URL)";
  }
}

/** Node fetch → Undici；优先：FMZ_AI_AGENT_LOCAL_PROXY（本地混合端口）→ 其它环境变量 → Windows 系统代理 */
function installUndiciOutboundProxy() {
  let proxyUrl = localMixedProxyEnvUrl();
  let source = "FMZ_AI_AGENT_LOCAL_PROXY（本地混合端口）";
  if (!proxyUrl) {
    proxyUrl = outboundProxyEnvUrl();
    source = "环境变量 / local-ai-agent.env";
  }
  if (!proxyUrl) {
    proxyUrl = tryWindowsSystemProxyUrl();
    source = "Windows 系统代理";
  }
  if (!proxyUrl) return;
  try {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log(`[ai-agent] 出站请求走代理（${source}）: ${redactProxyUrlForLog(proxyUrl)}`);
  } catch (err) {
    console.warn("[ai-agent] 代理不可用，仍将直连上游 API:", err.message);
  }
}

loadOptionalLocalAiAgentEnv();
installUndiciOutboundProxy();

/* ------------------------------------------------------------------ */
/*  Load API keys from config file or environment variables           */
/* ------------------------------------------------------------------ */

const KEYS_FILE = join(__dirname, "data", "ai-agent-keys.json");
let fileKeys = {};
try {
  if (existsSync(KEYS_FILE)) {
    const raw = readFileSync(KEYS_FILE, "utf-8").replace(/^\uFEFF/, "");
    fileKeys = JSON.parse(raw);
    console.log(`[ai-agent] Loaded API keys from ${KEYS_FILE}`);
  }
} catch (err) {
  console.warn(`[ai-agent] Failed to read ${KEYS_FILE}:`, err.message);
}

/** Resolve an API key: env var takes priority, then config file */
function resolveKey(envVar, fileField) {
  const fromEnv = (process.env[envVar] || "").trim();
  if (fromEnv) return fromEnv;
  const fromFile = fileKeys[fileField];
  return typeof fromFile === "string" ? fromFile.trim() : "";
}

/* ------------------------------------------------------------------ */
/*  Model Providers Configuration                                     */
/*  API keys are read from environment variables or hardcoded below.  */
/* ------------------------------------------------------------------ */

const GEMINI_CHAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

/** 逗号/分号/空白分隔的 model id，不出现在 /models 与 /chat（本机仅 2.0 无额度时可填 gemini-2.0-flash） */
function parseDisabledGeminiModelIds() {
  const raw = (
    process.env.FMZ_AI_AGENT_DISABLED_MODEL_IDS?.trim()
    || process.env.GEMINI_DISABLED_MODEL_IDS?.trim()
    || ""
  );
  if (!raw) return new Set();
  return new Set(
    raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean),
  );
}

const DISABLED_GEMINI_MODEL_IDS = parseDisabledGeminiModelIds();

/**
 * Gemini — OpenAI 兼容 Chat（静态回退清单）。
 * 优先级策略见 geminiPreferenceRank：3 Flash → 2.5 Flash → 2.5 Flash Lite → 2.0 / 1.5 等。
 * 若某 id 在当前 Key 下不可用，定时心跳探测会将其移出 /models 直至恢复。
 */
const GEMINI_VARIANTS_ALL = [
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash（预览）", model: "gemini-3-flash-preview" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", model: "gemini-2.5-flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash‑Lite", model: "gemini-2.5-flash-lite" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", model: "gemini-2.0-flash" },
  { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash‑Lite", model: "gemini-2.0-flash-lite" },
  { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro", model: "gemini-1.5-pro" },
  { id: "gemini-1.5-flash-8b", label: "Gemini 1.5 Flash‑8B", model: "gemini-1.5-flash-8b" },
  { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash", model: "gemini-1.5-flash" },
];

const GEMINI_VARIANTS = GEMINI_VARIANTS_ALL.filter((v) => !DISABLED_GEMINI_MODEL_IDS.has(v.id));

if (DISABLED_GEMINI_MODEL_IDS.size > 0) {
  console.log(`[ai-agent] 已禁用模型（不出现在列表）: ${[...DISABLED_GEMINI_MODEL_IDS].join(", ")}`);
}

const GEMINI_SHARED_KEY = () => resolveKey("GEMINI_API_KEY", "gemini");

const OPENAI_SHARED_KEY = () => resolveKey("OPENAI_API_KEY", "openai");

/** 千问 / DashScope OpenAI 兼容：环境变量 DASHSCOPE_API_KEY 或 QWEN_API_KEY；文件字段 qwen */
function resolveQwenDashScopeKey() {
  const a = (process.env.DASHSCOPE_API_KEY || "").trim();
  if (a) return a;
  const b = (process.env.QWEN_API_KEY || "").trim();
  if (b) return b;
  const f = fileKeys.qwen;
  return typeof f === "string" ? f.trim() : "";
}

/** 兼容自建 / Azure OpenAI：`https://your-resource.openai.azure.com/openai/deployments/name` → 仍可设 OPENAI_BASE_URL 为前缀；默认官方 v1 */
function openAiChatCompletionsUrl() {
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  return `${base}/chat/completions`;
}

const GEMINI_LIST_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/** OpenAI Chat Completions 模型（与 TRIGGER_AI、`POST /chat` 的 modelId 一致） */
const OPENAI_VARIANTS = [
  { id: "gpt-4o", label: "GPT-4o · OpenAI", model: "gpt-4o" },
  { id: "gpt-4o-mini", label: "GPT-4o mini · OpenAI", model: "gpt-4o-mini" },
  { id: "gpt-4-turbo", label: "GPT-4 Turbo · OpenAI", model: "gpt-4-turbo" },
  { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo · OpenAI", model: "gpt-3.5-turbo" },
];

/** 通义千问（DashScope 兼容 OpenAI）；降级顺序：Long → Plus → Max → Turbo */
const QWEN_VARIANTS = [
  { id: "qwen-long", label: "通义千问 Long · DashScope", model: "qwen-long" },
  { id: "qwen-plus", label: "通义千问 Plus · DashScope", model: "qwen-plus" },
  { id: "qwen-max", label: "通义千问 Max · DashScope", model: "qwen-max" },
  { id: "qwen-turbo", label: "通义千问 Turbo · DashScope", model: "qwen-turbo" },
];

/** OpenAI：`Authorization: Bearer` + 官方 /v1/chat/completions；无密钥则不注册 */
function buildOpenAiProviders() {
  const apiKey = OPENAI_SHARED_KEY();
  if (!apiKey) return [];
  const apiUrl = openAiChatCompletionsUrl();
  return OPENAI_VARIANTS.map((v) => ({
    id: v.id,
    label: v.label,
    provider: "OpenAI",
    apiUrl,
    apiKey,
    model: v.model,
  }));
}

/** 中国大陆默认 dashscope.aliyuncs.com；国际区可设 QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1 */
function qwenDashScopeChatCompletionsUrl() {
  const base = (
    process.env.QWEN_BASE_URL?.trim()
    || process.env.DASHSCOPE_COMPATIBLE_BASE?.trim()
    || "https://dashscope.aliyuncs.com/compatible-mode/v1"
  ).replace(/\/+$/, "");
  return `${base}/chat/completions`;
}

/** 与 OpenAI SDK 兼容的模型名（DashScope 控制台 / 文档）；无密钥则不注册 */
function buildQwenProviders() {
  const apiKey = resolveQwenDashScopeKey();
  if (!apiKey) return [];
  const apiUrl = qwenDashScopeChatCompletionsUrl();
  return QWEN_VARIANTS.map((v) => ({
    id: v.id,
    label: v.label,
    provider: "Qwen",
    apiUrl,
    apiKey,
    model: v.model,
  }));
}

function finalizeProvidersFromGeminiList(geminiList) {
  const merged = [...geminiList, ...buildOpenAiProviders(), ...buildQwenProviders()];
  const deduped = dedupeProvidersById(merged);
  sortProvidersByFmzPolicy(deduped);
  return deduped;
}

function providerFamilyOrder(providerName) {
  const p = String(providerName || "");
  if (p === "Google") return 0;
  if (p === "Qwen") return 1;
  if (p === "OpenAI") return 2;
  return 3;
}

/** 数字越小越优先（Gemini 3 Flash → 2.5 Flash → 2.5 Flash Lite → …） */
function geminiPreferenceRank(id) {
  const s = String(id || "").toLowerCase();
  if (/gemini[-_]3/.test(s) && /flash/.test(s) && !/lite/.test(s)) return 0;
  if (/gemini[-_]3/.test(s) && /flash/.test(s)) return 1;
  if (/2[._]5/.test(s) && /flash/.test(s) && !/lite/.test(s) && !/flash[-_]?lite/.test(s)) return 10;
  if (/2[._]5/.test(s) && (/flash[-_]?lite|flashlite/).test(s)) return 11;
  if (/2[._]0/.test(s) && /flash/.test(s) && !/lite/.test(s) && !/flash[-_]?lite/.test(s)) return 20;
  if (/2[._]0/.test(s) && (/flash[-_]?lite|flashlite/).test(s)) return 21;
  if (/1[._]5/.test(s) && /pro/.test(s)) return 30;
  if (/1[._]5/.test(s) && /8b/.test(s)) return 31;
  if (/1[._]5/.test(s) && /flash/.test(s)) return 32;
  return 80;
}

function qwenPreferenceRank(id) {
  const s = String(id || "").toLowerCase();
  if (s.includes("qwen-long")) return 0;
  if (s.includes("qwen-plus")) return 1;
  if (s.includes("qwen-max")) return 2;
  if (s.includes("qwen-turbo")) return 3;
  return 50;
}

function openAiPreferenceRank(id) {
  const order = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"];
  const i = order.indexOf(String(id));
  return i === -1 ? 40 : i;
}

function sortProvidersByFmzPolicy(arr) {
  arr.sort((a, b) => {
    const pf = providerFamilyOrder(a.provider) - providerFamilyOrder(b.provider);
    if (pf !== 0) return pf;
    if (a.provider === "Google") {
      const d = geminiPreferenceRank(a.id) - geminiPreferenceRank(b.id);
      return d !== 0 ? d : a.id.localeCompare(b.id);
    }
    if (a.provider === "Qwen") {
      const d = qwenPreferenceRank(a.id) - qwenPreferenceRank(b.id);
      return d !== 0 ? d : a.id.localeCompare(b.id);
    }
    if (a.provider === "OpenAI") {
      const d = openAiPreferenceRank(a.id) - openAiPreferenceRank(b.id);
      return d !== 0 ? d : a.id.localeCompare(b.id);
    }
    return a.id.localeCompare(b.id);
  });
}

function dedupeProvidersById(arr) {
  const seen = new Set();
  return arr.filter((p) => {
    if (!p?.id || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

/** 仅含 Google 条目时使用（动态 list 拉回后、与 OpenAI/Qwen 合并前） */
function sortGeminiProvidersFromGoogleList(arr) {
  sortProvidersByFmzPolicy(arr);
}

/** list models 不返回剩余额度；仅作说明给前端 */
const MODELS_QUOTA_NOTE =
  "Generative Language API 的 GET /v1beta/models 只返回模型元数据，不包含剩余配额。额度请查看 AI Studio、Google Cloud 配额/计费页；每次请求的 limit 可能在响应头或错误体中体现。";

let modelsListMeta = {
  source: "static",
  lastRemoteError: null,
  quotaNote: MODELS_QUOTA_NOTE,
};

function buildStaticModelProviders() {
  return GEMINI_VARIANTS.map((v) => ({
    id: v.id,
    label: v.label,
    provider: "Google",
    apiUrl: GEMINI_CHAT_URL,
    apiKey: GEMINI_SHARED_KEY(),
    model: v.model,
  }));
}

/** 分页拉取当前 Key 在 Google 侧可见的全部 models */
async function fetchAllGeminiModelsPaged(apiKey) {
  const collected = [];
  let pageToken = "";
  for (let page = 0; page < 64; page++) {
    const u = new URL(GEMINI_LIST_MODELS_URL);
    u.searchParams.set("pageSize", "100");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const res = await fetch(u.toString(), {
      headers: { "x-goog-api-key": apiKey },
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`list models HTTP ${res.status}: ${raw.slice(0, 300)}`);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("list models 返回非 JSON");
    }
    collected.push(...(data.models || []));
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return collected;
}

function googleListItemToProvider(m, apiKey) {
  const full = typeof m.name === "string" ? m.name : "";
  const id = full.replace(/^models\//, "");
  if (!id || DISABLED_GEMINI_MODEL_IDS.has(id)) return null;
  if (!geminiEligibleForOpenAiCompatTextChat(id)) return null;
  const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
  if (!methods.includes("generateContent")) return null;
  if (/embed/i.test(id)) return null;
  if (!/^gemini/i.test(id)) return null;
  const label = String(m.displayName || id).trim();
  return {
    id,
    label,
    provider: "Google",
    apiUrl: GEMINI_CHAT_URL,
    apiKey,
    model: id,
  };
}

let MODEL_PROVIDERS = finalizeProvidersFromGeminiList(buildStaticModelProviders());

async function refreshModelProvidersFromGoogle() {
  modelsListMeta.lastRemoteError = null;
  if (process.env.FMZ_AI_AGENT_MODELS_SOURCE === "static") {
    modelsListMeta.source = "static";
    MODEL_PROVIDERS = finalizeProvidersFromGeminiList(buildStaticModelProviders());
    return;
  }
  const key = GEMINI_SHARED_KEY();
  if (!key) {
    MODEL_PROVIDERS = finalizeProvidersFromGeminiList(buildStaticModelProviders());
    modelsListMeta.source = "static";
    return;
  }
  try {
    const rawModels = await fetchAllGeminiModelsPaged(key);
    const providers = rawModels
      .map((item) => googleListItemToProvider(item, key))
      .filter(Boolean);
    if (providers.length === 0) {
      console.warn("[ai-agent] list models 解析后为 0 条，使用内置静态列表");
      MODEL_PROVIDERS = finalizeProvidersFromGeminiList(buildStaticModelProviders());
      modelsListMeta.source = "static_fallback_empty_api";
      return;
    }
    sortGeminiProvidersFromGoogleList(providers);
    MODEL_PROVIDERS = finalizeProvidersFromGeminiList(providers);
    modelsListMeta.source = "google_list_models";
    console.log(`[ai-agent] 已从 Google GET /v1beta/models 加载 ${providers.length} 个模型`);
  } catch (err) {
    modelsListMeta.lastRemoteError = err?.message || String(err);
    console.warn("[ai-agent] 拉取模型列表失败，使用内置静态列表:", modelsListMeta.lastRemoteError);
    MODEL_PROVIDERS = finalizeProvidersFromGeminiList(buildStaticModelProviders());
    modelsListMeta.source = "static_fallback_error";
  }
}

function hasUsableApiKey(m) {
  return typeof m.apiKey === "string" && m.apiKey.trim().length > 0;
}

function probeDisabled() {
  return /^1|true|yes$/i.test(String(process.env.FMZ_AI_AGENT_PROBE_DISABLED || "").trim());
}

function probeIntervalMs() {
  const n = parseInt(String(process.env.FMZ_AI_AGENT_PROBE_INTERVAL_MS || "300000"), 10);
  return Number.isFinite(n) && n >= 60_000 ? n : 300_000;
}

function probeTimeoutMs() {
  const n = parseInt(String(process.env.FMZ_AI_AGENT_PROBE_TIMEOUT_MS || "22000"), 10);
  return Number.isFinite(n) && n >= 3000 ? n : 22_000;
}

function probeStaggerMs() {
  const n = parseInt(String(process.env.FMZ_AI_AGENT_PROBE_STAGGER_MS || "450"), 10);
  return Number.isFinite(n) && n >= 0 ? n : 450;
}

/** 最近一次心跳判定为不可达的 modelId（不出现在 /models，且 POST /chat 拒绝） */
const modelUnreachable = new Set();
let lastReachabilityProbeAt = 0;
let reachabilityProbeRunning = false;

function isModelReachable(id) {
  if (probeDisabled()) return true;
  return !modelUnreachable.has(String(id));
}

function pruneUnreachableToKnownProviders() {
  const ids = new Set(MODEL_PROVIDERS.map((p) => p.id));
  for (const x of modelUnreachable) {
    if (!ids.has(x)) modelUnreachable.delete(x);
  }
}

async function probeProviderReachability(provider) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.apiKey}`,
  };
  const tMs = probeTimeoutMs();
  const payloadBase = {
    model: provider.model,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 4,
  };
  try {
    const res = await fetch(provider.apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...payloadBase, stream: false }),
      signal: AbortSignal.timeout(tMs),
    });
    const _txt = await res.text();
    if (res.ok) return;
  } catch (e) {
    if (e?.name === "AbortError" || e?.name === "TimeoutError") throw new Error("probe timeout");
  }

  const res2 = await fetch(provider.apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...payloadBase, max_tokens: 8, stream: true }),
    signal: AbortSignal.timeout(tMs),
  });
  if (!res2.ok) {
    const t = await res2.text().catch(() => "");
    throw new Error(`HTTP ${res2.status}: ${t.slice(0, 280)}`);
  }
  const reader = res2.body?.getReader();
  if (!reader) throw new Error("no stream body");
  const decoder = new TextDecoder();
  let ok = false;
  for (let n = 0; n < 500; n++) {
    const { done, value } = await reader.read();
    if (done) break;
    if (decoder.decode(value, { stream: true }).includes("data:")) {
      ok = true;
      break;
    }
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  if (!ok) throw new Error("stream produced no tokens");
}

async function runReachabilityProbeRound() {
  if (probeDisabled()) return;
  if (reachabilityProbeRunning) return;
  reachabilityProbeRunning = true;
  pruneUnreachableToKnownProviders();
  const targets = MODEL_PROVIDERS.filter(hasUsableApiKey);
  const delayMs = probeStaggerMs();
  if (targets.length) {
    console.log(`[ai-agent] 模型可达性探测开始（${targets.length} 个，超时 ${probeTimeoutMs()}ms）…`);
  }
  for (const p of targets) {
    try {
      await probeProviderReachability(p);
      modelUnreachable.delete(p.id);
    } catch (err) {
      const msg = err?.message || String(err);
      modelUnreachable.add(p.id);
      console.warn(`[ai-agent] reachability ✗ ${p.id}: ${msg.slice(0, 220)}`);
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  lastReachabilityProbeAt = Date.now();
  reachabilityProbeRunning = false;
  const bad = [...modelUnreachable].sort();
  if (bad.length) {
    console.warn(`[ai-agent] 当前不可达已屏蔽（${bad.length}）：${bad.join(", ")}`);
  } else if (targets.length) {
    console.log("[ai-agent] 模型可达性探测完成：均可达");
  }
}

/** Only expose models that have a valid API key configured and passed reachability */
function getAvailableModels() {
  return MODEL_PROVIDERS.filter((m) => hasUsableApiKey(m) && isModelReachable(m.id)).map((m) => ({
    id: m.id,
    label: m.label,
    provider: m.provider,
  }));
}

function findModel(id) {
  return MODEL_PROVIDERS.find((m) => m.id === id && hasUsableApiKey(m) && isModelReachable(id));
}

function buildModelsJsonPayload() {
  return {
    models: getAvailableModels(),
    meta: {
      listSource: modelsListMeta.source,
      quotaNote: modelsListMeta.quotaNote,
      listModelsReference:
        "GET https://generativelanguage.googleapis.com/v1beta/models（x-goog-api-key，与 chat 相同 Key）；不返回剩余配额。",
      ...(modelsListMeta.lastRemoteError ? { listModelsError: modelsListMeta.lastRemoteError } : {}),
      reachability: {
        disabled: probeDisabled(),
        intervalMs: probeIntervalMs(),
        lastRoundAt: lastReachabilityProbeAt || null,
        probing: reachabilityProbeRunning,
        unreachableIds: [...modelUnreachable].sort(),
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/*  HTTP Server                                                       */
/* ------------------------------------------------------------------ */

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
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

  // GET /models  （?refresh=1 时重新拉取 Google 模型列表）
  if (req.method === "GET" && url.pathname === "/models") {
    if (url.searchParams.get("refresh") === "1") {
      await refreshModelProvidersFromGoogle();
      if (!probeDisabled()) void runReachabilityProbeRound();
    }
    return sendJson(res, 200, buildModelsJsonPayload());
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
      const c = err?.cause;
      const code = c?.code || c?.errno;
      const causeMsg = c && typeof c === "object" && "message" in c ? String(c.message) : c ? String(c) : "";
      const detail = [err?.message, code && `code=${code}`, causeMsg && `cause=${causeMsg}`]
        .filter(Boolean)
        .join(" | ");
      console.error("[ai-agent] Upstream fetch failed:", detail);
      if (!res.headersSent) {
        const causeStr = String(causeMsg || "");
        const localProxyDead =
          code === "ECONNREFUSED"
          && /127\.0\.0\.1|localhost/i.test(causeStr);
        const hint =
          code === "ENOTFOUND"
            ? "（DNS 无法解析上游域名，请检查网络/DNS）"
            : localProxyDead
              ? "（本机 HTTP 代理端口未监听或未启动混合端口：可注释 server/local-ai-agent.env 中的 HTTPS_PROXY 后重启以走直连/TUN，或先在 VPN 客户端开启对应端口并核对端口号）"
              : code === "ECONNREFUSED" || code === "ETIMEDOUT"
                ? "（连接被拒或超时，检查防火墙、代理或本地区是否可达 Google API）"
                : code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || /cert|TLS|SSL/i.test(String(causeMsg))
                  ? "（TLS/证书校验失败，检查系统时间、公司中间人证书）"
                  : "";
        sendJson(res, 502, {
          error: `无法连接上游 API：${detail || err?.message}${hint}`,
        });
      } else {
        res.end();
      }
    }
    return;
  }

  // 404
  sendJson(res, 404, { error: "Not found" });
});

(async () => {
  await refreshModelProvidersFromGoogle();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[ai-agent] 🤖 AI Agent proxy server running on http://127.0.0.1:${PORT}`);
    const available = getAvailableModels();
    if (available.length === 0) {
      console.log(
        "[ai-agent] ⚠️  No API keys configured! Set GEMINI_API_KEY / OPENAI_API_KEY / DASHSCOPE_API_KEY (或 QWEN_API_KEY) / server/data/ai-agent-keys.json（gemini / openai / qwen）。",
      );
    } else {
      const ids = available.map((m) => m.id);
      const idLine
        = ids.length > 28
          ? `${ids.slice(0, 28).join(", ")} … (+${ids.length - 28})`
          : ids.join(", ");
      console.log(`[ai-agent]    模型列表来源: ${modelsListMeta.source} — 共 ${available.length} 个`);
      console.log(`[ai-agent]    ids: ${idLine}`);
    }
    if (modelsListMeta.lastRemoteError) {
      console.warn(`[ai-agent]    list models 未成功（已回退静态）: ${modelsListMeta.lastRemoteError}`);
    }
    if (!probeDisabled()) {
      console.log(
        `[ai-agent]    可达性心跳：每 ${Math.round(probeIntervalMs() / 1000)}s 探测；跳过不可达模型直至恢复。禁用：FMZ_AI_AGENT_PROBE_DISABLED=1`,
      );
      void runReachabilityProbeRound();
      setInterval(() => void runReachabilityProbeRound(), probeIntervalMs());
    }
  });
})();
