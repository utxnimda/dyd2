/**
 * douyu-danmaku-server.mjs
 * Douyu live room danmaku capture service.
 *
 * - Connects to Douyu danmaku server via raw TCP socket (multi-room)
 * - Implements Douyu STT (Serialized Text Transport) protocol
 * - Forwards danmaku to frontend via Server-Sent Events (SSE)
 * - Supports 「弹幕触发」(prefix/command) plus 「定时触发」(interval / daily / weekly / cron)
 * - Password protection for adding/removing rooms
 *
 * Port: 8791 (configurable via PORT env)
 */

import http from "node:http";
import net from "node:net";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { geminiEligibleForOpenAiCompatTextChat } from "./gemini-openai-compat-chat-filter.mjs";
import { fmzStaticFileMtimeMs, readDouyuFallbackGiftMetricsFresh } from "./fmz-static.mjs";
import {
  getDreamBusConfigCached,
  getDreamBusLiveState,
  getDreamBusRecords,
  ingestDreamBusSession,
  loadDreamBusRecordsFromDisk,
  bootstrapDreamBusRecordsFromHttp,
} from "./dream-bus-store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8791;
/** 窃听宝语关闭时：仅连房间收 dream_bus_session + 提供 /dream-bus/* API（见 FMZ_DANMAKU_MODE） */
const DANMAKU_MODE = String(process.env.FMZ_DANMAKU_MODE || "").trim().toLowerCase();
const DREAM_BUS_ONLY =
  DANMAKU_MODE === "dream-bus-only" ||
  /^1|true|yes$/i.test(String(process.env.FMZ_DANMAKU_DREAM_BUS_ONLY || ""));
const DREAM_BUS_ROOM_ID = String(process.env.FMZ_DREAM_BUS_ROOM_ID || "9046690").trim();
/** 仓库根（本文件在 server/ 下），不依赖 process.cwd */
const REPO_ROOT = join(__dirname, "..");
const DATA_DIR = join(__dirname, "data", "danmaku");

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

function buildChatmsgDanmaku(msg) {
  return {
    type: "chatmsg",
    uid: msg.uid || "",
    nn: msg.nn || "",
    txt: msg.txt || "",
    level: msg.level || "",
    bnn: msg.bnn || "",
    bl: msg.bl || "",
    rid: msg.rid || "",
    brid: msg.brid || "",
    ts: Date.now(),
    ic: msg.ic || "",
    photo: msg.photo || "",
  };
}

/* ------------------------------------------------------------------ */
/*  Password configuration                                           */
/* ------------------------------------------------------------------ */

const BACKEND_PASSWORD = "lsyfp";

/* ------------------------------------------------------------------ */
/*  Backend rooms persistence                                         */
/* ------------------------------------------------------------------ */

const ROOMS_FILE = join(DATA_DIR, "backend-rooms.json");

function loadSavedRooms() {
  try { if (existsSync(ROOMS_FILE)) return JSON.parse(readFileSync(ROOMS_FILE, "utf-8")); } catch { /* ignore */ }
  return [];
}
function saveRoomsList() {
  const ids = [...backendRooms.keys()];
  writeFileSync(ROOMS_FILE, JSON.stringify(ids, null, 2), "utf-8");
}

/* ------------------------------------------------------------------ */
/*  Room info cache                                                   */
/* ------------------------------------------------------------------ */

const roomInfoCache = new Map(); // roomId -> { data, fetchedAt }
const ROOM_INFO_TTL = 60_000; // 1 minute cache

const giftListCache = new Map(); // roomId -> { data, fetchedAt, manualMtime, fmzStaticMtime }
const GIFT_LIST_TTL = 300_000; // 5 minutes cache

/** 斗鱼 webconf 静态 JSON：背包 / 道具礼（全局，与直播间无关）；JSONP:`DYConfigCallback({...})` */
const PROP_GIFT_CONFIG_URL =
  "https://webconf.douyucdn.cn/resource/common/prop_gift_list/prop_gift_config.json";
const PROP_GIFT_CONFIG_TTL = 3_600_000; // 1h
const propGiftConfigState = {
  /** @type {Record<string, { name: string, pc: number, devote: number, type: number|null, icon: string, raw: object|null }>|null} */
  map: null,
  totalKeys: 0,
  fetchedAt: 0,
  fetchOk: false,
};

/**
 * Parse `DYConfigCallback({ ... })` into a JSON root object (handles quotes / escapes in payload).
 */
function parseDouyuConfigJsonpPayload(text, callbackName = "DYConfigCallback") {
  const trimmed = String(text || "").trim();
  const p = `${callbackName}(`;
  const ia = trimmed.indexOf(p);
  if (ia < 0) return null;
  const jsonStart = trimmed.indexOf("{", ia + p.length);
  if (jsonStart < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = jsonStart; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") esc = true;
      else if (c === "\"") inStr = false;
      continue;
    }
    if (c === "\"") {
      inStr = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(jsonStart, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** giftPhotos_w.json 根对象为 `{ data, callback }`，整段 JSON.parse 比括号扫描更安全 */
function parseGiftPhotosWJsonp(text) {
  const trimmed = String(text || "").trim();
  const re = /^DYConfigCallback\s*\(([\s\S]*)\)\s*;?\s*$/;
  const m = trimmed.match(re);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {
      /* fallthrough */
    }
  }
  return parseDouyuConfigJsonpPayload(trimmed);
}

function pickPropGiftIcon(blob) {
  const s = blob?.cimg || blob?.himg || blob?.bimg || "";
  return typeof s === "string" ? s : "";
}

/** Deep clone CDN gift fragment for debug (JSON-serializable). */
function cloneGiftListRawChunk(obj) {
  if (obj == null || typeof obj !== "object") return obj;
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return { _serializeError: true };
  }
}

/**
 * Normalize prop_gift_config.data[giftId].
 * @returns {{ name: string, pc: number, devote: number, type: number|null, icon: string, raw: object|null }}
 */
function normalizePropGiftEntry(blob) {
  const pcRaw = blob?.pc;
  const devoteRaw = blob?.devote;
  const typeRaw = blob?.type;
  const pc = Number.isFinite(Number(pcRaw)) ? Number(pcRaw) : 0;
  const devote = Number.isFinite(Number(devoteRaw)) ? Number(devoteRaw) : 0;
  const tn = Number(typeRaw);
  return {
    name: typeof blob?.name === "string" ? blob.name : "",
    pc,
    devote,
    type: Number.isFinite(tn) ? tn : null,
    icon: pickPropGiftIcon(blob),
    raw: cloneGiftListRawChunk(blob),
  };
}

async function getPropGiftConfigMapFresh() {
  const resp = await fetch(PROP_GIFT_CONFIG_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  const root = parseDouyuConfigJsonpPayload(text);
  if (!root || Number(root.error) !== 0 || root.data == null || typeof root.data !== "object") {
    throw new Error("unexpected prop JSON");
  }
  /** @type {Record<string, ReturnType<typeof normalizePropGiftEntry>>} */
  const out = {};
  for (const [id, blob] of Object.entries(root.data)) {
    out[id] = normalizePropGiftEntry(blob);
  }
  propGiftConfigState.map = out;
  propGiftConfigState.totalKeys = Object.keys(out).length;
  propGiftConfigState.fetchedAt = Date.now();
  propGiftConfigState.fetchOk = true;
  return propGiftConfigState;
}

/** Global prop config (cached). On failure retains last-good map when present. */
async function getPropGiftConfigMapCached() {
  if (
    propGiftConfigState.map &&
    propGiftConfigState.fetchOk &&
    Date.now() - propGiftConfigState.fetchedAt < PROP_GIFT_CONFIG_TTL
  ) {
    return propGiftConfigState;
  }
  try {
    return await getPropGiftConfigMapFresh();
  } catch (e) {
    console.error(`[danmaku] Failed to fetch prop_gift_config: ${e.message}`);
    if (propGiftConfigState.map) {
      return propGiftConfigState;
    }
    propGiftConfigState.fetchOk = false;
    return { ...propGiftConfigState, map: null, totalKeys: 0 };
  }
}

/** webconf 礼物图鉴写真 JSONP（全局，与房间无关）；供调试面板对照 pgId */
const GIFT_PHOTOS_W_URL = "https://webconf.douyucdn.cn/resource/common/giftPhotos_w.json";
const GIFT_PHOTOS_W_TTL = 3_600_000; // 1h
const giftPhotosWState = {
  /** @type {{ tabInfos: unknown[], pgInfos: unknown[], unlockStar: unknown, awardStar: unknown, skin: unknown, photoSwitch: unknown, allSwitch: unknown, auth: unknown } | null} */
  payload: null,
  fetchedAt: 0,
  fetchOk: false,
};

async function fetchGiftPhotosWPayloadFresh() {
  const resp = await fetch(GIFT_PHOTOS_W_URL);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  const root = parseGiftPhotosWJsonp(text);
  if (!root?.data || typeof root.data !== "object") throw new Error("unexpected giftPhotos_w payload");
  const d = root.data;
  giftPhotosWState.payload = {
    tabInfos: Array.isArray(d.tabInfos) ? d.tabInfos : [],
    pgInfos: Array.isArray(d.pgInfos) ? d.pgInfos : [],
    unlockStar: d.unlockStar ?? null,
    awardStar: d.awardStar ?? null,
    skin: d.skin ?? null,
    photoSwitch: d.photoSwitch ?? null,
    allSwitch: d.allSwitch ?? null,
    auth: d.auth ?? null,
  };
  giftPhotosWState.fetchedAt = Date.now();
  giftPhotosWState.fetchOk = true;
  return giftPhotosWState;
}

async function getGiftPhotosWPayloadCached() {
  if (
    giftPhotosWState.payload &&
    giftPhotosWState.fetchOk &&
    Date.now() - giftPhotosWState.fetchedAt < GIFT_PHOTOS_W_TTL
  ) {
    return giftPhotosWState;
  }
  try {
    return await fetchGiftPhotosWPayloadFresh();
  } catch (e) {
    console.error(`[danmaku] Failed to fetch giftPhotos_w: ${e.message}`);
    if (giftPhotosWState.payload) {
      return giftPhotosWState;
    }
    giftPhotosWState.fetchOk = false;
    giftPhotosWState.payload = null;
    return giftPhotosWState;
  }
}

/**
 * Merged gift info from two Douyu data sources:
 *
 * 1. **v3 CDN API** (`gift.douyucdn.cn/api/gift/v3/web/list?rid=<roomId>`)
 *    - New ID namespace (20000+): 20004=火箭, 20006=赞, etc.
 *    - Room-specific, contains current active gifts
 *    - Icon: picUrlPrefix + basicInfo.giftPic
 *    - Cost: priceInfo.price, Value: growthInfo.contribution
 *    - **priceType**: "YUCHI" (鱼翅/paid) or "YUWAN" (鱼丸/free)
 *
 * 2. **prop_gift_config** (`webconf.douyucdn.cn/.../prop_gift_config.json`)
 *    - Old ID namespace (< 1000 mostly): 192=赞, 195=飞机, 196=火箭, 824=粉丝荧光棒
 *    - Global (not room-specific), contains legacy/backpack gifts
 *    - Icon: cimg / himg / bimg (full URL)
 *    - Cost: pc, Value: devote
 *    - No priceType field; use heuristic: pc >= 100 → paid (YUCHI)
 *
 * The two ID namespaces have ZERO overlap. Danmaku dgb messages use gfid from
 * either namespace, so we must merge both sources into a single lookup map.
 *
 * Revenue classification (isPaid):
 * - v3 gifts: priceType === "YUCHI"（鱼翅）必为付费收益；非 YUWAN 且（contribution>0 或标价 price>0）亦标为付费（覆盖「金币」、部分活动礼在 CDN 里 contribution 为 0 的情况）
 * - prop gifts: pc >= 100 → isPaid=true (heuristic; most low-pc gifts are free items)
 *
 * `source` field: "v3" = from CDN v3 API, "prop" = from prop_gift_config
 *
 * **Manual overlay** (`server/data/douyu-manual-gift-metrics.json`): 与 CDN 条目**同名**则覆盖
 * `value`（收入元/件）与 `intimacyScore`（亲密度）；无同名则插入 `source=manual` 的稳定 gfid 条目，供名称反查与统计。
 *
 * **FMZ fallback** (`shared/fmz-static.json` → `douyuFallbackGiftMetrics`)：CDN/背包合并后、写真保底与手填**之前**。见 `applyFmzFallbackGiftMetricsToMap`：**无收益或标记有收益但 value≤0** 时写入 FMZ 单价；战功礼默认 **cost（观众花费）=0**、**value=revenueYuan（主播收益）**；可选 **viewerSpendYuan** 为非零观众开销；条目可选 **aliases** 参与 `resolveArchivedGiftGfid`；可选 **wireGiftIds** 镜像线路 ID。
 *
 * **giftPhotos_w**（`webconf …/giftPhotos_w.json` → `pgInfos`）：FMZ static **之后**、手填 **之前**，按 **pgId** 补缺条目（主播收入 **value = price÷100** 元，与 v3 `priceInfo.price` 同源刻度）；手填 **之后** 再补 icon，并对 **`source=gift-photos-w`** 强制重申 **price÷100**（防止手填同名覆盖）；对 **`giftPhotosIconFromName`** 行按写真 **price÷100** 写收入（仅针对本轮补图标的行，不误改已有图标的 v3/prop）。
 */

/* ------------------------------------------------------------------ */
/*  Global manual gift metrics (when CDN/prop missing or unreliable)   */
/* ------------------------------------------------------------------ */

const MANUAL_GIFT_METRICS_PATH = join(__dirname, "data", "douyu-manual-gift-metrics.json");

function loadManualGiftMetricsFile() {
  try {
    if (!existsSync(MANUAL_GIFT_METRICS_PATH)) return null;
    const j = JSON.parse(readFileSync(MANUAL_GIFT_METRICS_PATH, "utf-8"));
    if (!j || !Array.isArray(j.entries)) return null;
    return j;
  } catch {
    return null;
  }
}

function getManualGiftMetricsMtimeMs() {
  try {
    if (!existsSync(MANUAL_GIFT_METRICS_PATH)) return 0;
    return statSync(MANUAL_GIFT_METRICS_PATH).mtimeMs;
  } catch {
    return 0;
  }
}

function normalizeGiftNameForManual(s) {
  return String(s ?? "").trim().toLowerCase();
}

/**
 * 合并 `douyu-manual-gift-metrics.json`：与现有礼单**同名**则覆盖 value、亲密度与 isPaid；否则插入仅手填条目（稳定 gfid）。
 */
function applyManualGiftMetricsToMap(map) {
  const blob = loadManualGiftMetricsFile();
  if (!blob?.entries?.length || !map || typeof map !== "object") return;
  for (const entry of blob.entries) {
    const name = String(entry.name ?? "").trim();
    const gfidManual = String(entry.gfid ?? "").trim();
    if (!name || !gfidManual) continue;
    const rev = Number(entry.revenueYuan);
    const inti = Number(entry.intimacyScore);
    const revN = Number.isFinite(rev) ? rev : 0;
    const intiN = Number.isFinite(inti) ? inti : 0;
    const kn = normalizeGiftNameForManual(name);
    let hitId = null;
    for (const [id, info] of Object.entries(map)) {
      if (!info || typeof info !== "object") continue;
      if (normalizeGiftNameForManual(info.name) === kn) {
        hitId = id;
        break;
      }
    }
    if (hitId != null) {
      map[hitId].value = revN;
      map[hitId].intimacyScore = intiN;
      map[hitId].isPaid = revN > 0;
      map[hitId].manualMetrics = true;
      if (!map[hitId].priceType) map[hitId].priceType = "MANUAL";
    } else {
      map[gfidManual] = {
        name,
        icon: "",
        cost: 0,
        value: revN,
        intimacyScore: intiN,
        from: 1,
        source: "manual",
        isPaid: revN > 0,
        priceType: "MANUAL",
        raw: null,
        manualMetrics: true,
      };
    }
  }
}

/**
 * 「战功礼」等对 CDN contribution/标价缺失或矛盾（免费、或标记有收益却 value≤0）时的保底刻度。
 * 数据来自仓库 `shared/fmz-static.json` 的 douyuFallbackGiftMetrics。
 * — 先于 `applyManualGiftMetricsToMap` 调用；手填表仍优先生效覆盖。
 */
function shouldOverlayFmzFallbackCatalogEntry(info, revenueYuanN) {
  if (!info || !(revenueYuanN > 0)) return false;
  if (info.manualMetrics) return false;
  const v = Number(info.value ?? 0);
  if (!info.isPaid) return true;
  if (!Number.isFinite(v) || v <= 0) return true;
  return false;
}

/**
 * 斗鱼 CDN/prop 礼单缺失、但弹幕 `pid`/回填 gfid 会出现的线路礼物 ID → 镜像一条与 canonical 行相同的合并礼单行，
 * 便于 `/gift-list` 明细里可按数字 ID 查到（统计 resolve 已与展示名对齐）。
 * @param {Record<string, object>} map
 * @param {{ name?: string, wireGiftIds?: unknown }} entry fmz-static 单条
 * @param {string} canonicalKey 镜像源：`hitId`（CDN 同名命中）或 `gfidFb`（仅占位兜底）
 */
function applyFmzFallbackWireGiftIds(map, entry, canonicalKey) {
  const wires = Array.isArray(entry.wireGiftIds) ? entry.wireGiftIds : [];
  if (!wires.length) return;
  const canonical = map[canonicalKey];
  if (!canonical || typeof canonical !== "object") return;
  const primaryNameNorm = normalizeGiftNameForManual(entry.name);

  for (const w of wires) {
    const wid = String(w ?? "").trim();
    if (!wid || wid === "0" || wid === canonicalKey) continue;
    const existing = map[wid];
    if (existing && typeof existing === "object") {
      const en = normalizeGiftNameForManual(existing.name);
      if (en && en !== primaryNameNorm) {
        console.warn(`[danmaku] Fallback wireGiftIds id=${wid} already used by "${existing.name}", skip "${entry.name}"`);
        continue;
      }
    }
    map[wid] = { ...canonical };
  }
}

/**
 * 战功等活动礼：弹幕线路 ID（gfidFb）常与 CDN 「同名不同号」条目并存。
 * 命中 hitId 时若仅 overlay CDN 行、`gfidFb` 不落盘，则归档里 pid→3393 无法在合并礼单中解析 → 统计缺失。
 */
function upsertFmzFallbackCanonicalPidRow(map, gfidFb, name, costN, revN, intimacyN) {
  const kn = normalizeGiftNameForManual(name);
  const existingByGfid = map[gfidFb];
  if (existingByGfid?.manualMetrics) return;
  if (existingByGfid) {
    const en = normalizeGiftNameForManual(existingByGfid.name);
    if (en !== kn && en !== "") {
      console.warn(
        `[danmaku] FMZ fallback canonical pid gfid=${gfidFb} already used by "${existingByGfid.name}", skip duplicate "${name}"`,
      );
      return;
    }
  }
  map[gfidFb] = {
    name,
    icon: existingByGfid?.icon ?? "",
    cost: costN,
    value: revN,
    intimacyScore: intimacyN > 0 ? intimacyN : (existingByGfid?.intimacyScore ?? 0),
    from: existingByGfid?.from ?? 1,
    source: "fmz-fallback",
    isPaid: revN > 0,
    priceType: "FMZ_FALLBACK",
    raw: existingByGfid?.raw ?? null,
    fallbackMetrics: true,
  };
}

function applyFmzFallbackGiftMetricsToMap(map, fmzFallbackList = readDouyuFallbackGiftMetricsFresh()) {
  if (!map || typeof map !== "object") return;
  const list = fmzFallbackList;
  if (!Array.isArray(list) || !list.length) return;

  for (const entry of list) {
    const name = String(entry.name ?? "").trim();
    const gfidFb = String(entry.gfid ?? "").trim();
    if (!name || !gfidFb) continue;

    const rev = Number(entry.revenueYuan);
    const contrib = Number(entry.contributionRaw);
    const revN = Number.isFinite(rev) ? rev : 0;
    const intimacyN = Number.isFinite(contrib) ? contrib : 0;
    /** 战功礼：主播收益 value=revenueYuan；观众侧「花费」cost 默认 0（非鱼翅口径）。可选 viewerSpendYuan≥0 覆盖。 */
    const vsRaw = Number(entry.viewerSpendYuan);
    const costN =
      Number.isFinite(vsRaw) && vsRaw >= 0 ? vsRaw : 0;

    const kn = normalizeGiftNameForManual(name);
    let hitId = null;
    for (const [id, info] of Object.entries(map)) {
      if (!info || typeof info !== "object") continue;
      if (normalizeGiftNameForManual(info.name) === kn) {
        hitId = id;
        break;
      }
    }

    if (hitId != null) {
      const ex = map[hitId];
      if (ex.manualMetrics) continue;
      if (shouldOverlayFmzFallbackCatalogEntry(ex, revN)) {
        ex.value = revN;
        ex.cost = costN;
        ex.isPaid = revN > 0;
        if (intimacyN > 0) ex.intimacyScore = intimacyN;
        else if (ex.intimacyScore == null) ex.intimacyScore = 0;
        ex.fallbackMetrics = true;
        if (!ex.priceType) ex.priceType = "FMZ_FALLBACK";
      }
      upsertFmzFallbackCanonicalPidRow(map, gfidFb, name, costN, revN, intimacyN);
      applyFmzFallbackWireGiftIds(map, entry, gfidFb);
      continue;
    }

    const existingByGfid = map[gfidFb];
    if (existingByGfid) {
      const en = normalizeGiftNameForManual(existingByGfid.name);
      if (en !== kn && en !== "") {
        console.warn(`[danmaku] Fallback gift gfid ${gfidFb} already used by "${existingByGfid.name}", skip "${name}"`);
        continue;
      }
    }

    map[gfidFb] = {
      name,
      icon: "",
      cost: costN,
      value: revN,
      intimacyScore: intimacyN,
      from: 1,
      source: "fmz-fallback",
      isPaid: revN > 0,
      priceType: "FMZ_FALLBACK",
      raw: null,
      fallbackMetrics: true,
    };
    applyFmzFallbackWireGiftIds(map, entry, gfidFb);
  }
}

/** @returns {number} 主播侧单价（元）；写真 webconf `price` 与 v3 **标价 raw** 同源刻度 → **÷100**。 */
function giftPhotosStreamerYuanFromRow(row) {
  const n = Number(row?.price);
  return Number.isFinite(n) ? n / 100 : 0;
}

/**
 * giftPhotos_w（pgInfos）：在 FMZ static 之后执行；仅当 map 尚无该 pgId 时补一条（pid-only / CDN·prop 均无号）。
 * 主播收益 value = price÷100（元）；观众花费 cost = 0。手填 manual 在其后仍可覆盖同名条目。
 * @returns {number} 新增条数
 */
function applyGiftPhotosWFallbackToMap(map, pgInfos) {
  if (!map || typeof map !== "object" || !Array.isArray(pgInfos)) return 0;
  let added = 0;
  for (const row of pgInfos) {
    const id = String(row?.pgId ?? "").trim();
    if (!id || id === "0") continue;
    if (map[id]) continue;
    const valueYuan = giftPhotosStreamerYuanFromRow(row);
    const intimacyRaw = Number(row?.intimacy);
    const intimacyScore = Number.isFinite(intimacyRaw) ? intimacyRaw : 0;
    const name = String(row?.name ?? "").trim();
    map[id] = {
      name: name || `写真#${id}`,
      icon: typeof row.pic === "string" ? row.pic : "",
      cost: 0,
      value: valueYuan,
      intimacyScore,
      from: 1,
      source: "gift-photos-w",
      isPaid: valueYuan > 0,
      priceType: "PHOTO_FALLBACK",
      raw: cloneGiftListRawChunk(row),
      giftPhotosFallback: true,
    };
    added++;
  }
  return added;
}

/**
 * 写真目录：礼物名归一化 → 首张非空 `pic` + `price`（同名多条时先到先得）。
 * @returns {Record<string, { pic: string, price: number }>} price 可为 NaN 表示该行无数
 */
function buildGiftPhotosNameOverlayIndex(pgInfos) {
  /** @type {Record<string, { pic: string, price: number }>} */
  const idx = {};
  if (!Array.isArray(pgInfos)) return idx;
  for (const row of pgInfos) {
    const name = String(row?.name ?? "").trim();
    if (!name) continue;
    const kn = normalizeGiftNameForManual(name);
    const pic = typeof row.pic === "string" ? row.pic.trim() : "";
    const priceRaw = Number(row?.price);
    const priceNum = Number.isFinite(priceRaw) ? priceRaw : Number.NaN;
    if (!idx[kn]) {
      idx[kn] = { pic, price: priceNum };
      continue;
    }
    if (!idx[kn].pic && pic) idx[kn].pic = pic;
    if (!Number.isFinite(idx[kn].price) && Number.isFinite(priceNum)) idx[kn].price = priceNum;
  }
  return idx;
}

/**
 * 手填之后：① 尚无 icon 则按写真名补图；② `gift-photos-w`（pgId 键）强制 value=price÷100；
 * ③ `giftPhotosIconFromName` 行按写真 price÷100 写收入（跳过 fmz-fallback / fallbackMetrics / manual）。
 */
function applyGiftPhotosPostManualOverlay(map, pgInfos, overlayIdx) {
  let iconsFilled = 0;
  let pgIdStreamerRepair = 0;
  let valueFromPhotoName = 0;
  if (!map || typeof map !== "object") {
    return { iconsFilled, pgIdStreamerRepair, valueFromPhotoName };
  }
  const ov = overlayIdx && typeof overlayIdx === "object" ? overlayIdx : {};

  for (const info of Object.values(map)) {
    if (!info || typeof info !== "object") continue;
    const ic = typeof info.icon === "string" ? info.icon.trim() : "";
    if (ic) continue;
    const name = String(info.name ?? "").trim();
    if (!name) continue;
    const slot = ov[normalizeGiftNameForManual(name)];
    const pic = slot?.pic && String(slot.pic).trim();
    if (!pic) continue;
    info.icon = pic;
    info.giftPhotosIconFromName = true;
    iconsFilled++;
  }

  if (Array.isArray(pgInfos)) {
    for (const row of pgInfos) {
      const id = String(row?.pgId ?? "").trim();
      if (!id || id === "0") continue;
      const info = map[id];
      if (!info || info.source !== "gift-photos-w") continue;
      const yuan = giftPhotosStreamerYuanFromRow(row);
      info.value = yuan;
      info.isPaid = yuan > 0;
      pgIdStreamerRepair++;
    }
  }

  for (const info of Object.values(map)) {
    if (!info || typeof info !== "object") continue;
    if (!info.giftPhotosIconFromName) continue;
    if (info.manualMetrics || info.source === "fmz-fallback" || info.fallbackMetrics) continue;
    const name = String(info.name ?? "").trim();
    if (!name) continue;
    const slot = ov[normalizeGiftNameForManual(name)];
    if (!slot || !Number.isFinite(slot.price)) continue;
    const yuan = giftPhotosStreamerYuanFromRow({ price: slot.price });
    info.value = yuan;
    info.isPaid = yuan > 0;
    info.giftPhotosValueFromName = true;
    valueFromPhotoName++;
  }

  return { iconsFilled, pgIdStreamerRepair, valueFromPhotoName };
}

/**
 * Build merged gift map: v3 API (room-specific) + prop_gift_config (global legacy).
 * Returns { gifts, stats } or null on total failure.
 */
async function fetchGiftListPayload(roomId) {
  const cached = giftListCache.get(roomId);
  const manualMtime = getManualGiftMetricsMtimeMs();
  const fmzStaticMtime = fmzStaticFileMtimeMs();
  if (
    cached &&
    Date.now() - cached.fetchedAt < GIFT_LIST_TTL &&
    cached.manualMtime === manualMtime &&
    cached.fmzStaticMtime === fmzStaticMtime
  ) {
    return cached.data;
  }
  try {
    // Fetch both sources in parallel
    const [propCfg, v3Result] = await Promise.all([
      getPropGiftConfigMapCached(),
      fetchV3GiftList(roomId),
    ]);
    const propMap = propCfg.map;

    /** @type {Record<string, { name: string, icon: string, cost: number, value: number, from: number, source: string, isPaid: boolean, priceType?: string, raw: object|null, propRaw?: object|null }>} */
    const map = {};

    // --- Source 1: prop_gift_config (old IDs, global) ---
    // These are backpack/legacy gifts (from=2)
    // Unit conversion: pc/100 = 元 (cost), devote/10 = 元 (value)
    // Revenue heuristic: pc >= 100 → isPaid (most free items have pc=10~20)
    let propCount = 0;
    if (propMap) {
      for (const [id, pv] of Object.entries(propMap)) {
        propCount++;
        const pc = pv.pc || 0;
        map[id] = {
          name: pv.name || "",
          icon: pv.icon || "",
          cost: pc / 100,
          value: (pv.devote || 0) / 10,
          from: 2,
          source: "prop",
          isPaid: pc >= 100,
          raw: pv.raw ?? null,
        };
      }
    }

    // --- Source 2: v3 CDN API (new IDs, room-specific) ---
    // v3 gifts are all direct (from=1); tabIds=2 is "privilege" tab, not backpack
    // Unit conversion: price/100 = 元 (cost), contribution/10 = 元 (value)
    // Revenue: YUCHI 必为付费；非 YUWAN 且（contribution>0 或标价 price>0）亦计付费，避免「金币」等虚拟币礼 contribution=0 时被误判为免费
    let v3Count = 0;
    if (v3Result) {
      for (const [id, entry] of Object.entries(v3Result)) {
        v3Count++;
        // If prop_gift_config also has this ID, it's a backpack gift (from=2)
        const isBackpack = Boolean(propMap && propMap[id]);
        const fromVal = isBackpack ? 2 : 1;
        // If from=2 and prop_gift_config has this ID, overlay cost/value from prop
        let cost = entry.cost / 100;
        let value = entry.value / 10;
        let propRaw = null;
        if (isBackpack) {
          const pv = propMap[id];
          if (pv.pc) cost = pv.pc / 100;
          if (pv.devote !== undefined) value = pv.devote / 10;
          propRaw = pv.raw ?? null;
        }
        const pt = entry._priceType;
        const rawContrib = Number(entry.value);
        const rawPrice = Number(entry.cost);
        const v3IsPaid =
          pt === "YUCHI" ||
          (pt !== "YUWAN" &&
            ((Number.isFinite(rawContrib) && rawContrib > 0) ||
              (Number.isFinite(rawPrice) && rawPrice > 0)));
        map[id] = {
          name: entry.name,
          icon: entry.icon,
          cost,
          value,
          from: fromVal,
          source: entry.source,
          isPaid: v3IsPaid,
          priceType: pt || undefined,
          raw: entry.raw,
          ...(propRaw ? { propRaw } : {}),
        };
      }
    }

    // Ensure gfid=0 has a fallback (鱼丸, free gift)
    if (!map["0"]) {
      map["0"] = { name: "未知礼物", icon: "", cost: 0, value: 0, from: 1, source: "fallback", isPaid: false, raw: null };
    }

    const fmzFallbackList = readDouyuFallbackGiftMetricsFresh();
    applyFmzFallbackGiftMetricsToMap(map, fmzFallbackList);

    let giftPhotosFallbackAdded = 0;
    /** @type {Record<string, { pic: string, price: number }>|null} */
    let giftPhotosNameOverlayIndex = null;
    /** @type {unknown[]|null} */
    let giftPhotosPgInfosRef = null;
    try {
      const photoSt = await getGiftPhotosWPayloadCached();
      if (photoSt.payload?.pgInfos?.length) {
        const pgInfos = photoSt.payload.pgInfos;
        giftPhotosPgInfosRef = pgInfos;
        giftPhotosFallbackAdded = applyGiftPhotosWFallbackToMap(map, pgInfos);
        giftPhotosNameOverlayIndex = buildGiftPhotosNameOverlayIndex(pgInfos);
      }
    } catch (e) {
      console.warn(`[danmaku] giftPhotos_w catalog fallback skipped: ${e.message}`);
    }

    applyManualGiftMetricsToMap(map);

    let giftPhotosIconsByName = 0;
    let giftPhotosStreamerRepairPgId = 0;
    let giftPhotosValueFromPhotoName = 0;
    if (giftPhotosPgInfosRef?.length) {
      const post = applyGiftPhotosPostManualOverlay(
        map,
        giftPhotosPgInfosRef,
        giftPhotosNameOverlayIndex ?? {},
      );
      giftPhotosIconsByName = post.iconsFilled;
      giftPhotosStreamerRepairPgId = post.pgIdStreamerRepair;
      giftPhotosValueFromPhotoName = post.valueFromPhotoName;
    }

    const fmzFallbackRows = Object.values(map).filter((x) => x?.source === "fmz-fallback").length;

    // --- Build backpackCatalog: from=2 gifts that exist in prop_gift_config ---
    /** @type {Record<string, { name: string, pc: number, devote: number, type: number|null, icon: string, overlaidFromProp: boolean, raw?: object|null }>} */
    const backpackCatalog = {};
    let overlaidFromPropCount = 0;
    const roomBackpackGiftIds = Object.entries(map).filter(([, v]) => v.from === 2).length;
    for (const [id, info] of Object.entries(map)) {
      if (info.from !== 2) continue;
      const inProp = Boolean(propMap && propMap[id]);
      if (inProp) overlaidFromPropCount++;
      const propEntry = propMap && propMap[id];
      backpackCatalog[id] = {
        name: info.name,
        pc: info.cost,
        devote: info.value,
        type: propEntry?.type ?? null,
        icon: info.icon,
        overlaidFromProp: inProp,
        raw: propEntry?.raw ?? null,
      };
    }

    const stats = {
      v3Count,
      propCount,
      totalCount: Object.keys(map).length,
      propConfigOk: Boolean(propMap),
      fmzConfiguredEntries: fmzFallbackList.length,
      fmzFallbackRows,
      giftPhotosFallbackAdded,
      giftPhotosIconsByName,
      giftPhotosStreamerRepairPgId,
      giftPhotosValueFromPhotoName,
    };

    const backpackCatalogStats = {
      totalPropKeys: propCfg.totalKeys || 0,
      roomBackpackGiftIds,
      overlaidFromPropCount,
      propConfigOk: Boolean(propMap),
    };

    const pack = { gifts: map, stats, backpackCatalog, backpackCatalogStats };
    giftListCache.set(roomId, { data: pack, fetchedAt: Date.now(), manualMtime, fmzStaticMtime });
    console.log(
      `[danmaku] Gift list for room ${roomId}: v3=${v3Count}, prop=${propCount}, backpack=${roomBackpackGiftIds}, photoFb=${giftPhotosFallbackAdded}, photoIcon=${giftPhotosIconsByName}, photoValPg=${giftPhotosStreamerRepairPgId}, photoValNm=${giftPhotosValueFromPhotoName}, total=${stats.totalCount}`,
    );
    return pack;
  } catch (e) {
    console.error(`[danmaku] Failed to fetch gift list for ${roomId}:`, e.message);
    return null;
  }
}

/**
 * Fetch room-specific gift list from Douyu CDN v3 API.
 * Returns a map of { [gfid]: { name, icon, cost, value, source:"v3", raw } } or null.
 */
async function fetchV3GiftList(roomId) {
  try {
    const resp = await fetch(`https://gift.douyucdn.cn/api/gift/v3/web/list?rid=${roomId}`);
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json.error !== 0 || !json.data) return null;

    /** @type {Record<string, { name: string, icon: string, cost: number, value: number, source: string, raw: object|null, _tabIds?: number[] }>} */
    const map = {};
    const giftGroups = json.data.giftList || json.data;
    if (Array.isArray(giftGroups)) {
      for (const g of giftGroups) {
        if (g.id) {
          const prefix = g.picUrlPrefix || "https://gfs-op.douyucdn.cn/dygift";
          const pic = g.basicInfo?.giftPic || g.basicInfo?.sendPic || "";
          map[String(g.id)] = {
            name: g.name || "",
            icon: pic ? prefix + pic : "",
            cost: g.priceInfo?.price || 0,
            value: g.growthInfo?.contribution || 0,
            source: "v3",
            raw: cloneGiftListRawChunk(g),
            _tabIds: Array.isArray(g.tabIds) ? g.tabIds : undefined,
            _priceType: g.priceInfo?.priceType || null,
          };
        }
        if (Array.isArray(g.gifts)) {
          for (const sg of g.gifts) {
            if (sg.id) {
              const prefix = sg.picUrlPrefix || g.picUrlPrefix || "https://gfs-op.douyucdn.cn/dygift";
              const pic = sg.basicInfo?.giftPic || sg.basicInfo?.sendPic || "";
              map[String(sg.id)] = {
                name: sg.name || "",
                icon: pic ? prefix + pic : "",
                cost: sg.priceInfo?.price || 0,
                value: sg.growthInfo?.contribution || 0,
                source: "v3",
                raw: cloneGiftListRawChunk(sg),
                _tabIds: Array.isArray(sg.tabIds) ? sg.tabIds : undefined,
                _priceType: sg.priceInfo?.priceType || null,
              };
            }
          }
        }
      }
    }
    return map;
  } catch (e) {
    console.error(`[danmaku] Failed to fetch v3 gift list for ${roomId}:`, e.message);
    return null;
  }
}

async function fetchRoomInfo(roomId) {
  const cached = roomInfoCache.get(roomId);
  if (cached && Date.now() - cached.fetchedAt < ROOM_INFO_TTL) {
    return cached.data;
  }
  try {
    const resp = await fetch(`https://www.douyu.com/betard/${roomId}`);
    if (!resp.ok) return null;
    const json = await resp.json();
    const r = json.room;
    if (!r) return null;
    const info = {
      room_id: r.room_id,
      room_name: (r.room_name || "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
      owner_name: r.owner_name || "",
      owner_uid: r.owner_uid || "",
      show_status: r.show_status, // 1=live, 2=offline
      game_name: r.game_name || r.cate_name || "",
      cate_name: r.cate_name || "",
      online_num: r.online_num || 0,
      fans_num: r.fans_num || 0,
      room_thumb: r.room_thumb || "",
      start_time: r.show_time || 0,
      avatar: r.avatar?.middle || r.avatar?.small || "",
    };
    roomInfoCache.set(roomId, { data: info, fetchedAt: Date.now() });
    return info;
  } catch (e) {
    console.error(`[danmaku] Failed to fetch room info for ${roomId}:`, e.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Danmaku recording (backend mode only)                             */
/* ------------------------------------------------------------------ */

const RECORD_DIR = join(DATA_DIR, "records");
if (!existsSync(RECORD_DIR)) mkdirSync(RECORD_DIR, { recursive: true });

/** Raw message recording: captures ALL STT messages regardless of type for offline analysis */
const RAW_RECORD_DIR = join(DATA_DIR, "raw-records");
if (!existsSync(RAW_RECORD_DIR)) mkdirSync(RAW_RECORD_DIR, { recursive: true });

/**
 * Per-room recording state is stored inside each RoomConnection object.
 */
function startRecordingForRoom(conn) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, "");
  const roomDir = join(RECORD_DIR, String(conn.roomId));
  if (!existsSync(roomDir)) mkdirSync(roomDir, { recursive: true });
  conn.recordFile = join(roomDir, `${dateStr}_${timeStr}.jsonl`);
  conn.recordedCount = 0;
  const header = { _type: "session_start", roomId: conn.roomId, startedAt: now.toISOString(), ts: Date.now() };
  appendFileSync(conn.recordFile, JSON.stringify(header) + "\n", "utf-8");
  // Raw recording: all messages regardless of type
  const rawRoomDir = join(RAW_RECORD_DIR, String(conn.roomId));
  if (!existsSync(rawRoomDir)) mkdirSync(rawRoomDir, { recursive: true });
  conn.rawRecordFile = join(rawRoomDir, `${dateStr}_${timeStr}.jsonl`);
  conn.rawRecordedCount = 0;
  appendFileSync(conn.rawRecordFile, JSON.stringify(header) + "\n", "utf-8");
  console.log(`[danmaku-record] Started recording room ${conn.roomId} (raw: enabled)`);
}

function stopRecordingForRoom(conn) {
  if (!conn.recordFile) return;
  const footer = { _type: "session_end", roomId: conn.roomId, endedAt: new Date().toISOString(), recordedCount: conn.recordedCount, ts: Date.now() };
  try { appendFileSync(conn.recordFile, JSON.stringify(footer) + "\n", "utf-8"); } catch { /* ignore */ }
  // Stop raw recording
  if (conn.rawRecordFile) {
    const rawFooter = { _type: "session_end", roomId: conn.roomId, endedAt: new Date().toISOString(), rawRecordedCount: conn.rawRecordedCount, ts: Date.now() };
    try { appendFileSync(conn.rawRecordFile, JSON.stringify(rawFooter) + "\n", "utf-8"); } catch { /* ignore */ }
  }
  console.log(`[danmaku-record] Stopped recording room ${conn.roomId}. Danmaku: ${conn.recordedCount}, Raw: ${conn.rawRecordedCount || 0}`);
  conn.recordFile = null;
  conn.recordedCount = 0;
  conn.rawRecordFile = null;
  conn.rawRecordedCount = 0;
}

function recordDanmakuForRoom(conn, danmaku) {
  if (!conn.recordFile) return;
  try { appendFileSync(conn.recordFile, JSON.stringify(danmaku) + "\n", "utf-8"); conn.recordedCount++; } catch { /* ignore */ }
}

function listRecordings(roomId) {
  const results = [];
  const rooms = roomId ? [String(roomId)] : (existsSync(RECORD_DIR) ? readdirSync(RECORD_DIR) : []);
  for (const rid of rooms) {
    const roomDir = join(RECORD_DIR, rid);
    if (!existsSync(roomDir)) continue;
    const files = readdirSync(roomDir).filter(f => f.endsWith(".jsonl")).sort().reverse();
    for (const f of files) {
      const match = f.match(/^(\d{4}-\d{2}-\d{2})_(\d{6})\.jsonl$/);
      if (!match) continue;
      const filePath = join(roomDir, f);
      let lineCount = 0; let sessionStart = null; let sessionEnd = null;
      try {
        const content = readFileSync(filePath, "utf-8");
        for (const line of content.trim().split("\n")) {
          try {
            const obj = JSON.parse(line);
            if (obj._type === "session_start") sessionStart = obj;
            else if (obj._type === "session_end") sessionEnd = obj;
            else lineCount++;
          } catch { /* skip */ }
        }
      } catch { /* ignore */ }
      results.push({ roomId: rid, file: f, date: match[1], time: match[2].replace(/(\d{2})(\d{2})(\d{2})/, "$1:$2:$3"), messageCount: lineCount, startedAt: sessionStart?.startedAt || null, endedAt: sessionEnd?.endedAt || null });
    }
  }
  return results;
}

/* ------------------------------------------------------------------ */
/*  Trigger + Action configuration persistence                        */
/* ------------------------------------------------------------------ */

const CONFIG_FILE = join(DATA_DIR, "triggers.json");
const LOG_FILE = join(DATA_DIR, "action-log.json");
const SCHEDULE_STATE_FILE = join(DATA_DIR, "schedule-fire-state.json");
/** AI 日报/周报持久化条目（与前端 AiAgentPanel / SSE ai-report 对齐） */
const AI_REPORTS_FILE = join(DATA_DIR, "ai-reports.json");

/** Available action types for triggers */
const AVAILABLE_ACTIONS = [
  { id: "log", label: "展示" },
  { id: "song-request", label: "点歌" },
  { id: "ai-daily-report", label: "日报" },
  { id: "ai-weekly-report", label: "周报" },
];

const TRIGGER_ACTION_IDS = new Set(["log", "song-request", "ai-daily-report", "ai-weekly-report"]);

function saveTriggers(config) { writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8"); }
function loadActionLog() { try { if (existsSync(LOG_FILE)) return JSON.parse(readFileSync(LOG_FILE, "utf-8")); } catch { /* ignore */ } return []; }
function saveActionLog(log) { writeFileSync(LOG_FILE, JSON.stringify(log.slice(-500), null, 2), "utf-8"); }

function loadScheduleFireState() {
  try {
    if (existsSync(SCHEDULE_STATE_FILE)) return JSON.parse(readFileSync(SCHEDULE_STATE_FILE, "utf-8"));
  } catch { /* ignore */ }
  return {};
}
function saveScheduleFireState() {
  try {
    writeFileSync(SCHEDULE_STATE_FILE, JSON.stringify(scheduleFireState, null, 2), "utf-8");
  } catch (e) {
    console.warn("[danmaku] schedule state save failed:", e.message);
  }
}

function readTriggersFile() {
  try {
    if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch { /* ignore */ }
  return {
    triggers: [{
      id: "default_cmd",
      kind: "danmaku",
      pattern: "#",
      action: "log",
      enabled: true,
      description: "Capture all #command style danmaku and log the content after #",
      roomIds: [],
    }],
  };
}

function normalizeSchedule(s) {
  const d = s && typeof s === "object" ? { ...s } : {};
  const mode = ["interval", "daily", "weekly", "cron"].includes(d.mode) ? d.mode : "interval";
  d.mode = mode;
  let intervalSec = Number(d.intervalSec);
  if (!Number.isFinite(intervalSec)) intervalSec = 3600;
  d.intervalSec = Math.min(Math.max(Math.floor(intervalSec), 30), 604800);
  let hour = Number(d.hour);
  if (!Number.isFinite(hour)) hour = 8;
  d.hour = Math.min(23, Math.max(0, Math.floor(hour)));
  let minute = Number(d.minute);
  if (!Number.isFinite(minute)) minute = 0;
  d.minute = Math.min(59, Math.max(0, Math.floor(minute)));
  d.weekdays = Array.isArray(d.weekdays) && d.weekdays.length > 0
    ? [...new Set(d.weekdays.map(Number).filter((x) => x >= 0 && x <= 6))]
    : [0, 1, 2, 3, 4, 5, 6];
  d.cron = typeof d.cron === "string" && d.cron.trim() ? d.cron.trim() : "0 8 * * *";
  return d;
}

/** True when payload carries a schedule block (even if kind was omitted — avoids mis-classifying as danmaku and deleting schedule). */
function triggerLooksScheduled(raw) {
  const sch = raw && raw.schedule && typeof raw.schedule === "object" ? raw.schedule : null;
  return !!(sch && typeof sch.mode === "string" && ["interval", "daily", "weekly", "cron"].includes(sch.mode));
}

function normalizeTrigger(raw) {
  const t = { ...raw };
  const explicitSchedule =
    typeof t.kind === "string" && String(t.kind).toLowerCase() === "schedule";
  t.kind = explicitSchedule || triggerLooksScheduled(raw) ? "schedule" : "danmaku";
  if (t.kind === "danmaku") {
    if (typeof t.pattern !== "string" || !t.pattern) t.pattern = "#";
    delete t.schedule;
    const pay = typeof raw.payload === "string" ? raw.payload : "";
    const desc = typeof raw.description === "string" ? raw.description : "";
    t.payload = String(pay).trim() !== "" ? pay : desc;
    t.description = "";
  } else {
    t.pattern = "[定时]";
    t.schedule = normalizeSchedule(t.schedule || raw.schedule);
    t.payload = typeof t.payload === "string" ? t.payload : "";
  }
  if (!t.id || typeof t.id !== "string") t.id = `trigger_${Date.now()}`;
  t.action = TRIGGER_ACTION_IDS.has(t.action) ? t.action : "log";
  t.enabled = t.enabled !== false;
  t.description = typeof t.description === "string" ? t.description : "";
  t.roomIds = Array.isArray(t.roomIds) ? t.roomIds.map(String) : [];
  return t;
}

function hydrateTriggerConfig(cfg) {
  const triggers = Array.isArray(cfg.triggers) ? cfg.triggers.map((x) => normalizeTrigger(x)) : [];
  return { triggers };
}

let triggerConfig = hydrateTriggerConfig(readTriggersFile());
let actionLog = loadActionLog();
/** @type {Record<string, { intervalLast?: number, lastSlot?: string }>} */
let scheduleFireState = loadScheduleFireState();

function localMinuteKey(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fieldMatchesCron(spec, value) {
  const s = String(spec).trim();
  if (s === "*" || s === "?") return true;
  if (s.includes("/")) {
    const [base, stepStr] = s.split("/");
    const step = Number(stepStr);
    if (!Number.isFinite(step) || step <= 0) return false;
    if (base === "*") return value % step === 0;
    if (base.includes("-")) {
      const [a, b] = base.split("-").map((x) => Number(String(x).trim()));
      if (Number.isFinite(a) && Number.isFinite(b) && value >= a && value <= b) return (value - a) % step === 0;
    }
    return false;
  }
  for (const part of s.split(",")) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes("-")) {
      const [a, b] = p.split("-").map((x) => Number(String(x).trim()));
      if (Number.isFinite(a) && Number.isFinite(b) && value >= a && value <= b) return true;
    } else {
      const n = Number(p);
      if (Number.isFinite(n) && n === value) return true;
    }
  }
  return false;
}

function cronExpressionMatches(expr, date) {
  const tokens = String(expr).trim().split(/\s+/).filter(Boolean);
  if (tokens.length !== 5) return false;
  const [minute, hour, dom, month, dow] = tokens;
  const m = date.getMinutes();
  const H = date.getHours();
  const D = date.getDate();
  const M = date.getMonth() + 1;
  const w = date.getDay();
  return fieldMatchesCron(minute, m)
    && fieldMatchesCron(hour, H)
    && fieldMatchesCron(dom, D)
    && fieldMatchesCron(month, M)
    && fieldMatchesCron(dow, w);
}

function shouldFireScheduledTrigger(t, nowDate, nowMs) {
  const st = scheduleFireState[t.id] || {};
  const s = t.schedule;
  if (!s || typeof s !== "object") return false;

  switch (s.mode) {
    case "interval": {
      const sec = s.intervalSec ?? 3600;
      let last = st.intervalLast;
      if (last == null) {
        scheduleFireState[t.id] = { ...st, intervalLast: nowMs };
        saveScheduleFireState();
        return false;
      }
      return nowMs - last >= sec * 1000;
    }
    case "daily": {
      const slot = localMinuteKey(nowDate);
      if (nowDate.getHours() !== s.hour || nowDate.getMinutes() !== s.minute) return false;
      return st.lastSlot !== slot;
    }
    case "weekly": {
      const slot = localMinuteKey(nowDate);
      const dow = nowDate.getDay();
      const days = Array.isArray(s.weekdays) && s.weekdays.length > 0 ? s.weekdays : [0, 1, 2, 3, 4, 5, 6];
      if (!days.includes(dow)) return false;
      if (nowDate.getHours() !== s.hour || nowDate.getMinutes() !== s.minute) return false;
      return st.lastSlot !== slot;
    }
    case "cron": {
      if (!cronExpressionMatches(s.cron, nowDate)) return false;
      return st.lastSlot !== localMinuteKey(nowDate);
    }
    default:
      return false;
  }
}

function markScheduleFired(t, nowDate, nowMs) {
  const st = { ...(scheduleFireState[t.id] || {}) };
  const s = t.schedule;
  if (s.mode === "interval") {
    st.intervalLast = nowMs;
  } else {
    st.lastSlot = localMinuteKey(nowDate);
  }
  scheduleFireState[t.id] = st;
  saveScheduleFireState();
}

/** 定时 tick 与 normalizeTrigger 推断一致，避免仅有 schedule 字段但 kind 未写入时不触发 */
function isScheduleTriggerNode(t) {
  return !!(t && (t.kind === "schedule" || triggerLooksScheduled(t)));
}

function triggerActionLabelZh(action) {
  switch (action) {
    case "log":
      return "仅记日志";
    case "song-request":
      return "点歌";
    case "ai-daily-report":
      return "AI 日报";
    case "ai-weekly-report":
      return "AI 周报";
    default:
      return String(action || "unknown");
  }
}

function describeScheduleRule(t) {
  const s = t?.schedule;
  if (!s || typeof s !== "object") return "定时规则未知";
  switch (s.mode) {
    case "interval": {
      const sec = Math.min(Math.max(Number(s.intervalSec) || 3600, 30), 604800);
      if (sec % 86400 === 0) return `固定间隔已满 · 周期为每 ${sec / 86400} 天`;
      if (sec % 3600 === 0) return `固定间隔已满 · 周期为每 ${sec / 3600} 小时`;
      if (sec % 60 === 0) return `固定间隔已满 · 周期为每 ${sec / 60} 分钟`;
      return `固定间隔已满 · 周期为每 ${sec} 秒`;
    }
    case "daily": {
      const h = Math.min(23, Math.max(0, Math.floor(Number(s.hour) || 0)));
      const m = Math.min(59, Math.max(0, Math.floor(Number(s.minute) || 0)));
      return `每日时刻已到 · ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
    case "weekly": {
      const h = Math.min(23, Math.max(0, Math.floor(Number(s.hour) || 0)));
      const m = Math.min(59, Math.max(0, Math.floor(Number(s.minute) || 0)));
      const names = ["日", "一", "二", "三", "四", "五", "六"];
      const days = Array.isArray(s.weekdays) && s.weekdays.length > 0
        ? [...new Set(s.weekdays.map(Number).filter((x) => x >= 0 && x <= 6))].sort((a, b) => a - b)
        : [0, 1, 2, 3, 4, 5, 6];
      const dayStr = days.map((d) => names[d] ?? d).join("、");
      return `每周指定日及时刻已到 · 周${dayStr} · ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
    case "cron":
      return `Cron 规则匹配 · ${typeof s.cron === "string" && s.cron.trim() ? s.cron.trim() : "未配置"}`;
    default:
      return "定时条件已满足";
  }
}

/**
 * 一行说明：哪个触发器、满足什么条件、执行了什么动作（及结果要点）
 * @param {"danmaku"|"schedule"|"web"} source
 */
function buildTriggerLogSummary({ trigger, source, pattern, plainContent, nickname, roomId }) {
  const id = trigger?.id || "?";
  const actionLb = triggerActionLabelZh(trigger?.action);
  const memo = typeof trigger?.payload === "string" ? trigger.payload.trim() : "";
  const memoFrag = memo ? ` · 触发器备注「${memo.length > 120 ? `${memo.slice(0, 120)}…` : memo}」` : "";

  if (source === "schedule") {
    const rule = describeScheduleRule(trigger);
    const roomHint = roomId
      ? `目标房间 ${roomId}`
      : "当前无已连接房间（仅记录日志，未向房间派发动作）";
    const pay = plainContent != null ? String(plainContent).trim() : "";
    let detail = "";
    if (trigger.action === "song-request") {
      detail = pay
        ? `将解析说明为点歌载荷「${pay}」并尝试落库`
        : "动作「点歌」需要填写说明（歌名、歌手等）；本次为空，已跳过写入点歌记录";
    } else if (trigger.action === "log") {
      detail = pay
        ? `日志内容「${pay}」`
        : "无附加说明，仅记录触发事件";
    } else {
      detail = `已排队执行「${actionLb}」（后台异步，失败时见服务端 [ai-report] 日志）`;
    }
    return `[定时触发] 触发器「${id}」· ${rule} · ${roomHint} · 动作：${actionLb} · ${detail}${memoFrag}`;
  }

  if (source === "web") {
    const nick = nickname || "访客";
    const ct = plainContent != null && String(plainContent).trim() ? String(plainContent).trim() : "(空)";
    return `[弹幕采集] 触发器「${id}」· 匹配前缀「${pattern}」· 动作：${actionLb} · ${nick}: ${ct}${memoFrag}`;
  }

  const nick = nickname || "观众";
  const ct = plainContent != null && String(plainContent).trim() ? String(plainContent).trim() : "(空)";
  return `[弹幕] 触发器「${id}」· 匹配前缀「${pattern}」· 动作：${actionLb} · ${nick}: ${ct}${memoFrag}`;
}

/* ------------------------------------------------------------------ */
/*  Song request tracking — per-room persistent data                  */
/* ------------------------------------------------------------------ */

const SONG_DIR = join(DATA_DIR, "song-requests");
if (!existsSync(SONG_DIR)) mkdirSync(SONG_DIR, { recursive: true });

const GIFT_DIR = join(DATA_DIR, "gifts");
if (!existsSync(GIFT_DIR)) mkdirSync(GIFT_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/*  Gift tracking — per-room persistent data                          */
/* ------------------------------------------------------------------ */

/**
 * Gift storage: unlimited, auto-split into numbered files.
 * Files: {roomId}_gifts_0.json, {roomId}_gifts_1.json, ...
 * Each file holds up to GIFT_FILE_LIMIT entries.
 * An index file {roomId}_gifts_index.json tracks { fileCount, totalCount }.
 */
const GIFT_FILE_LIMIT = 5000;

function giftIndexPath(roomId) { return join(GIFT_DIR, `${roomId}_gifts_index.json`); }
function giftChunkPath(roomId, idx) { return join(GIFT_DIR, `${roomId}_gifts_${idx}.json`); }

function loadGiftIndex(roomId) {
  return loadJsonFile(giftIndexPath(roomId), { fileCount: 0, totalCount: 0 });
}
function saveGiftIndex(roomId, index) { saveJsonFile(giftIndexPath(roomId), index); }

// Migrate old single-file format if exists
function migrateOldGiftFile(roomId) {
  const oldPath = join(GIFT_DIR, `${roomId}_gifts.json`);
  if (!existsSync(oldPath)) return;
  try {
    const oldData = JSON.parse(readFileSync(oldPath, "utf-8"));
    if (Array.isArray(oldData) && oldData.length > 0) {
      // Split into chunks
      let fileIdx = 0;
      for (let i = 0; i < oldData.length; i += GIFT_FILE_LIMIT) {
        saveJsonFile(giftChunkPath(roomId, fileIdx), oldData.slice(i, i + GIFT_FILE_LIMIT));
        fileIdx++;
      }
      saveGiftIndex(roomId, { fileCount: fileIdx, totalCount: oldData.length });
    }
    // Remove old file after migration
    try { unlinkSync(oldPath); } catch { /* ignore */ }
  } catch { /* ignore */ }
}

function loadGifts(roomId, limit = 200) {
  migrateOldGiftFile(roomId);
  const index = loadGiftIndex(roomId);
  if (index.fileCount === 0) return [];
  // Read from the latest chunk(s) to satisfy limit
  const result = [];
  for (let i = index.fileCount - 1; i >= 0 && result.length < limit; i--) {
    const chunk = loadJsonFile(giftChunkPath(roomId, i), []);
    // Filter out legacy spbc broadcast notifications
    result.unshift(...chunk.filter(g => g._giftWire !== "spbc"));
  }
  return result.slice(-limit);
}

/**
 * Douyu type=dgb 礼物：归档「件数」仅当下行中的当次个数 `gfcnt`（不乘 hits / gs）。
 * 缺失或非法时按 1 计，与前端调试列一致。
 */
function giftPiecesFromStoredRecord(g) {
  const cntRaw = Number(g.gfcnt);
  if (Number.isFinite(cntRaw) && cntRaw > 0) return Math.floor(cntRaw);
  return 1;
}

/**
 * 斗鱼部分 `dgb` 下行带 gfid=0，真实礼物 id 在 pid/gid/giftId；新归档写入与 resolve/stats 共用。
 */
function coalesceDouyuArchivedGiftIds(msg) {
  if (!msg || typeof msg !== "object") return msg;
  const gf = String(msg.gfid ?? "").trim();
  if (gf && gf !== "0") return msg;
  for (const k of ["pid", "gid", "giftId"]) {
    const v = String(msg[k] ?? "").trim();
    if (v && v !== "0") return { ...msg, gfid: v };
  }
  return msg;
}

/** 归档行用于 gfid 解析的有效 id（不改磁盘对象）。 */
function archivedGiftWireId(g) {
  const m = coalesceDouyuArchivedGiftIds(g);
  return String(m?.gfid ?? "").trim();
}

/**
 * 将斗鱼 STT 礼物相关报文统一成与历史 `dgb` 归档兼容的形态。
 *
 * - **dgb**：原始送礼（经典路径）。
 * - **gdp**：本房间礼物文案事件（常见为「某某 赠送了 某礼×N」）；钻粉/部分活动礼仅下发 gdp、不下发 dgb，此前会被完全忽略。
 * - **spbc**：广播类送礼；不归为实际礼物统计（仅做记录，不计入收入）。
 * - **comm_chatmsg**：系统通知消息（如「开通钻粉1个月」「续费贵族」）；付费行为通知记入礼物统计。
 * - **anbc**：开通贵族通知（「XXX 在本房间开通了 XX贵族」）；付费行为。
 * - **rnewbc** / **rn**：续费贵族通知；付费行为。
 * - **ssd**：超级弹幕（付费弹幕）；有明确金额。
 * - **dfobc**：首次开通钻粉通知；price 字段为花费金额（单位：鱼翅/100=元）。
 * - **dfrbc**：续费钻粉通知；price 字段为花费金额（单位：鱼翅/100=元）。
 *
 * 归一化后 `type` 固定为 `dgb` 便于前端/统计沿用；真实来源放在 `_giftWire`。
 * @returns {object|null}
 */
function normalizeDouyuGiftSttToRecord(roomId, msg) {
  if (!msg || typeof msg !== "object") return null;
  const t = msg.type;
  const rid = String(roomId ?? "").trim();

  if (t === "dgb") {
    return coalesceDouyuArchivedGiftIds({ ...msg, _giftWire: "dgb" });
  }

  if (t === "gdp") {
    const gfn = String(msg.gfn ?? msg.gn ?? "").trim();
    const gfcntRaw = msg.gfcnt ?? msg.gc ?? msg.cnt ?? "1";
    const gfidHint = String(msg.gfid ?? msg.gid ?? msg.giftId ?? msg.pid ?? "").trim();
    return {
      ...msg,
      type: "dgb",
      _giftWire: "gdp",
      ...(gfn !== "" ? { gfn } : {}),
      gfcnt: String(gfcntRaw),
      ...(gfidHint !== "" ? { gfid: gfidHint } : {}),
    };
  }

  // spbc: broadcast gift — no longer counted as actual gift/revenue
  if (t === "spbc") {
    return null;
  }

  // comm_chatmsg: system notification messages (e.g. "开通钻粉1个月", "续费贵族", "开通粉丝团")
  // These represent paid actions that should be counted as gift/revenue events.
  if (t === "comm_chatmsg") {
    const txt = String(msg.txt ?? msg.content ?? "").trim();
    if (!txt) return null;
    // Only capture paid-action notifications (钻粉/贵族/粉丝团/守护 etc.)
    const paidPatterns = ["钻粉", "贵族", "粉丝团", "守护", "续费", "开通"];
    const isPaidAction = paidPatterns.some((p) => txt.includes(p));
    if (!isPaidAction) return null;
    const nn = String(msg.nn ?? msg.uname ?? "").trim();
    const uid = String(msg.uid ?? "").trim();
    // Use txt as gift name since comm_chatmsg doesn't have standard gfid/gfn
    return {
      ...msg,
      type: "dgb",
      _giftWire: "comm_chatmsg",
      nn: nn || "系统通知",
      uid,
      gfn: txt,
      gfid: "0",
      gfcnt: "1",
    };
  }

  // anbc: noble (贵族) activation notification
  // Fields: uid, uname/nn, nl (noble level), drid (destination room), donk (noble name)
  if (t === "anbc") {
    const drid = String(msg.drid ?? msg.rid ?? "").trim();
    // Only count if the noble was opened in this room
    if (!drid || drid !== rid) return null;
    const nn = String(msg.uname ?? msg.nn ?? "").trim();
    const uid = String(msg.uid ?? "").trim();
    const nobleName = String(msg.donk ?? msg.noble_name ?? "").trim();
    const nobleLevel = String(msg.nl ?? msg.noble_level ?? "").trim();
    const label = nobleName
      ? `开通${nobleName}`
      : nobleLevel
        ? `开通贵族(Lv${nobleLevel})`
        : "开通贵族";
    return {
      ...msg,
      type: "dgb",
      _giftWire: "anbc",
      nn: nn || "系统通知",
      uid,
      gfn: label,
      gfid: "0",
      gfcnt: "1",
    };
  }

  // rnewbc / rn: noble (贵族) renewal notification
  // Fields similar to anbc; rnewbc is the newer format, rn is legacy
  if (t === "rnewbc" || t === "rn") {
    const drid = String(msg.drid ?? msg.rid ?? "").trim();
    if (!drid || drid !== rid) return null;
    const nn = String(msg.uname ?? msg.nn ?? "").trim();
    const uid = String(msg.uid ?? "").trim();
    const nobleName = String(msg.donk ?? msg.noble_name ?? "").trim();
    const nobleLevel = String(msg.nl ?? msg.noble_level ?? "").trim();
    const label = nobleName
      ? `续费${nobleName}`
      : nobleLevel
        ? `续费贵族(Lv${nobleLevel})`
        : "续费贵族";
    return {
      ...msg,
      type: "dgb",
      _giftWire: t,
      nn: nn || "系统通知",
      uid,
      gfn: label,
      gfid: "0",
      gfcnt: "1",
    };
  }

  // ssd: super danmaku (超级弹幕) — paid danmaku with visible text overlay
  // Fields: uid, nn/uname, content/txt (the super danmaku text), sdid, trid (target room)
  if (t === "ssd") {
    const trid = String(msg.trid ?? msg.drid ?? msg.rid ?? "").trim();
    // Only count if targeted at this room (ssd can be cross-room broadcast)
    if (trid && trid !== rid) return null;
    const nn = String(msg.nn ?? msg.uname ?? "").trim();
    const uid = String(msg.uid ?? "").trim();
    const content = String(msg.content ?? msg.txt ?? "").trim();
    const label = content ? `超级弹幕: ${content.slice(0, 30)}` : "超级弹幕";
    return {
      ...msg,
      type: "dgb",
      _giftWire: "ssd",
      nn: nn || "系统通知",
      uid,
      gfn: label,
      gfid: "0",
      gfcnt: "1",
    };
  }

  // dfobc: first-time diamond fan (钻粉) activation
  // Fields: uid, nick, price (cost in fish-fin units, /100 = CNY), mn (months), bn (badge name), pg (level)
  if (t === "dfobc") {
    const nn = String(msg.nick ?? msg.nn ?? "").trim();
    const uid = String(msg.uid ?? "").trim();
    const months = String(msg.mn ?? "1").trim();
    const badgeName = String(msg.bn ?? "").trim();
    const price = String(msg.price ?? "0").trim();
    const label = badgeName
      ? `开通钻粉${months}个月(${badgeName})`
      : `开通钻粉${months}个月`;
    return {
      ...msg,
      type: "dgb",
      _giftWire: "dfobc",
      nn: nn || "系统通知",
      uid,
      gfn: label,
      gfid: "0",
      gfcnt: "1",
      _price: price,
    };
  }

  // dfrbc: diamond fan (钻粉) renewal
  // Fields: uid, nick, price (cost in fish-fin units, /100 = CNY), mn (months), bn (badge name), pg (level)
  if (t === "dfrbc") {
    const nn = String(msg.nick ?? msg.nn ?? "").trim();
    const uid = String(msg.uid ?? "").trim();
    const months = String(msg.mn ?? "1").trim();
    const badgeName = String(msg.bn ?? "").trim();
    const price = String(msg.price ?? "0").trim();
    const label = badgeName
      ? `续费钻粉${months}个月(${badgeName})`
      : `续费钻粉${months}个月`;
    return {
      ...msg,
      type: "dgb",
      _giftWire: "dfrbc",
      nn: nn || "系统通知",
      uid,
      gfn: label,
      gfid: "0",
      gfcnt: "1",
      _price: price,
    };
  }

  return null;
}

/**
 * 从斗鱼 STT 礼物报文推断「事件发生」毫秒时间戳，用于按自然日统计。
 * 若报文无可用字段或值离谱，返回 null → 由 recordGift 退回 Date.now()（接通时间）。
 * 见：`cst` / `timestamp` / `ts` / `betime` 等在不同下行里可能出现，且可能为秒或毫秒。
 */
function giftSttEventTimeMs(msg, receiveHintMs = Date.now()) {
  if (!msg || typeof msg !== "object") return null;
  const keys = ["cst", "timestamp", "ts", "betime", "stk", "nti", "nt_ts", "livetime"];
  /** @type {number[]} */
  const cand = [];
  for (const k of keys) {
    const raw = msg[k];
    if (raw == null || raw === "") continue;
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n)) continue;
    let ms;
    if (n > 1e12) ms = Math.floor(n);
    else if (n > 1e9) ms = Math.floor(n * 1000);
    else continue;
    if (ms < 946684800000 || ms > 4102444800000) continue;
    cand.push(ms);
  }
  if (cand.length === 0) return null;
  const win = 30 * 86400000;
  for (const ms of cand) {
    if (Math.abs(ms - receiveHintMs) <= win) return ms;
  }
  return cand[0];
}

/**
 * 归档条目上的 ts（若老数据异常则尽量得到有限数）
 */
function archivedGiftEntryTsMs(g) {
  const v = g?.ts;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 日志用：毫秒时间戳 → Asia/Shanghai 可读字符串 */
function giftLogFmtShanghai(ms) {
  if (!Number.isFinite(ms)) return String(ms);
  return new Date(ms).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * 同步写一行诊断日志。
 * 优先写 `server/data/danmaku/` 与 `仓库根/.fmz-dev/logs/`（路径由 __dirname 推导，**不依赖 cwd**）。
 * `danmaku.log` 里常见只有 fmz-dev 分隔线，是因为 stdout 经管道缓冲；本函数用 appendFileSync 直接落盘。
 */
function danmakuSyncLog(line) {
  const stamp = `[${new Date().toISOString()}] ${line}\n`;
  console.log(line);
  const fmzLogsDir = join(REPO_ROOT, ".fmz-dev", "logs");
  const targets = [
    { path: join(DATA_DIR, "danmaku-trace.log"), label: "DATA_DIR" },
    { path: join(fmzLogsDir, "danmaku-trace.log"), label: "REPO_ROOT/.fmz-dev/logs" },
  ];
  for (const { path: p, label } of targets) {
    try {
      mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, stamp, "utf8");
    } catch (e) {
      try {
        mkdirSync(DATA_DIR, { recursive: true });
        appendFileSync(
          join(DATA_DIR, "danmaku-trace-write-errors.log"),
          `${stamp}[${label}] ${p}: ${e?.message || String(e)}\n`,
          "utf8",
        );
      } catch {
        /* */
      }
    }
  }
  try {
    mkdirSync(fmzLogsDir, { recursive: true });
    appendFileSync(join(fmzLogsDir, "danmaku.log"), stamp, "utf8");
  } catch {
    /* 与 npm 占用同文件时可能失败 */
  }
}

danmakuSyncLog(
  `[danmaku] 模块已加载（将 listen PORT=${PORT}） REPO_ROOT=${REPO_ROOT}`,
);

function recordGift(roomId, msg) {
  // Save all available fields from the normalized gift message (dgb-compatible)
  const receiveMs = Date.now();
  const eventMs = giftSttEventTimeMs(msg, receiveMs);
  const ts = eventMs ?? receiveMs;
  const entry = { ...msg, roomId, ts };
  migrateOldGiftFile(roomId);
  const index = loadGiftIndex(roomId);
  // Get current chunk
  let chunkIdx = Math.max(0, index.fileCount - 1);
  let chunk = index.fileCount > 0 ? loadJsonFile(giftChunkPath(roomId, chunkIdx), []) : [];
  chunk.push(entry);
  if (chunk.length > GIFT_FILE_LIMIT) {
    // Save current full chunk and start a new one
    saveJsonFile(giftChunkPath(roomId, chunkIdx), chunk.slice(0, GIFT_FILE_LIMIT));
    chunkIdx++;
    chunk = chunk.slice(GIFT_FILE_LIMIT);
  }
  saveJsonFile(giftChunkPath(roomId, chunkIdx), chunk);
  index.fileCount = chunkIdx + 1;
  index.totalCount++;
  saveGiftIndex(roomId, index);
  return entry;
}

function clearGifts(roomId) {
  const index = loadGiftIndex(roomId);
  for (let i = 0; i < index.fileCount; i++) {
    try { writeFileSync(giftChunkPath(roomId, i), "[]"); } catch { /* ignore */ }
  }
  saveGiftIndex(roomId, { fileCount: 0, totalCount: 0 });
}

/**
 * Data files per room:
 *   <roomId>_timeline.json  — array of { song, artist, ts, uid, nn }
 *   <roomId>_session.json   — { "song artist": count } (clearable)
 *   <roomId>_total.json     — { "song artist": count } (permanent)
 */
function songFilePath(roomId, suffix) { return join(SONG_DIR, `${roomId}_${suffix}.json`); }

function loadJsonFile(p, fallback) {
  try { if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8")); } catch { /* ignore */ }
  return typeof fallback === "function" ? fallback() : fallback;
}
function saveJsonFile(p, data) { writeFileSync(p, JSON.stringify(data, null, 2), "utf-8"); }

function loadTimeline(roomId) { return loadJsonFile(songFilePath(roomId, "timeline"), []); }
function saveTimeline(roomId, data) { saveJsonFile(songFilePath(roomId, "timeline"), data.slice(-2000)); }
function loadSessionStats(roomId) { return loadJsonFile(songFilePath(roomId, "session"), {}); }
function saveSessionStats(roomId, data) { saveJsonFile(songFilePath(roomId, "session"), data); }
function loadTotalStats(roomId) { return loadJsonFile(songFilePath(roomId, "total"), {}); }
function saveTotalStats(roomId, data) { saveJsonFile(songFilePath(roomId, "total"), data); }

/**
 * Parse trigger content: first token = song name, second token = artist.
 * Record into timeline, session stats, and total stats.
 */
function recordSongRequest(roomId, content, danmaku) {
  const parts = content.trim().split(/\s+/);
  if (parts.length < 1 || !parts[0]) return null;
  const song = parts[0];
  const artist = parts.length >= 2 ? parts[1] : "";
  // Key: "song artist" if artist provided, otherwise "song" alone
  const key = artist ? `${song} ${artist}` : song;
  const ts = Date.now();
  const requester = { nn: danmaku.nn || "", uid: danmaku.uid || "", ts };

  // Timeline
  const timeline = loadTimeline(roomId);
  timeline.push({ song, artist, ts, uid: danmaku.uid || "", nn: danmaku.nn || "" });
  saveTimeline(roomId, timeline);

  // Session stats (clearable) — stores { count, requesters[] }
  const session = loadSessionStats(roomId);
  if (!session[key] || typeof session[key] === "number") {
    const oldCount = typeof session[key] === "number" ? session[key] : 0;
    session[key] = { count: oldCount, requesters: [] };
  }
  session[key].count++;
  session[key].requesters.push(requester);
  saveSessionStats(roomId, session);

  // Total stats (permanent) — stores { count, requesters[] }
  const total = loadTotalStats(roomId);
  if (!total[key] || typeof total[key] === "number") {
    const oldCount = typeof total[key] === "number" ? total[key] : 0;
    total[key] = { count: oldCount, requesters: [] };
  }
  total[key].count++;
  total[key].requesters.push(requester);
  // Keep only last 50 requesters in total to avoid unbounded growth
  if (total[key].requesters.length > 50) total[key].requesters = total[key].requesters.slice(-50);
  saveTotalStats(roomId, total);

  return { song, artist, key, sessionCount: session[key].count, totalCount: total[key].count, ts, nn: danmaku.nn || "" };
}

/* ------------------------------------------------------------------ */
/*  Recent danmaku from recording files                               */
/* ------------------------------------------------------------------ */

function getRecentDanmaku(roomId, limit = 100) {
  const roomDir = join(RECORD_DIR, String(roomId));
  if (!existsSync(roomDir)) return [];
  const files = readdirSync(roomDir).filter(f => f.endsWith(".jsonl")).sort().reverse();
  const result = [];
  for (const f of files) {
    if (result.length >= limit) break;
    try {
      const lines = readFileSync(join(roomDir, f), "utf-8").trim().split("\n");
      for (let i = lines.length - 1; i >= 0 && result.length < limit; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type === "chatmsg") result.push(obj);
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
  }
  return result.reverse(); // oldest first
}

/* ------------------------------------------------------------------ */
/*  AI 导出：按时间范围汇总录制弹幕 + 归档礼物                          */
/* ------------------------------------------------------------------ */

function startOfLocalDayMs(ts) {
  const x = new Date(ts);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/** @returns {{ startTs: number, endTs: number } | null} */
function parseLocalDayBounds(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd).trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const startTs = new Date(y, mo, d, 0, 0, 0, 0).getTime();
  if (Number.isNaN(startTs)) return null;
  const chk = new Date(startTs);
  if (chk.getFullYear() !== y || chk.getMonth() !== mo || chk.getDate() !== d) return null;
  const endTs = startTs + 86400000 - 1;
  return { startTs, endTs };
}

function mondayStartMsContaining(ts) {
  const sod = startOfLocalDayMs(ts);
  const dt = new Date(sod);
  const dow = dt.getDay();
  const deltaDays = dow === 0 ? -6 : 1 - dow;
  dt.setDate(dt.getDate() + deltaDays);
  return startOfLocalDayMs(dt.getTime());
}

function fmtLocalYmd(ts) {
  const x = new Date(ts);
  const y = x.getFullYear();
  const mo = String(x.getMonth() + 1).padStart(2, "0");
  const d = String(x.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** 本地日历星期简称（与前端日报便签一致：getDay() 0=周日） */
function weekdayCnLocal(ts) {
  const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return names[new Date(ts).getDay()];
}

/** 时间窗内归档 chatmsg 条数；独立观众数优先按 uid，无 uid 时按昵称 nn 降级去重（弱唯一） */
function computeDanmakuStatsInRange(roomId, startTs, endTs) {
  const roomDir = join(RECORD_DIR, String(roomId));
  if (!existsSync(roomDir)) return { total: 0, uniqueUsers: 0 };
  const files = readdirSync(roomDir).filter((f) => f.endsWith(".jsonl")).sort();
  let total = 0;
  const identities = new Set();
  for (const f of files) {
    let content;
    try {
      content = readFileSync(join(roomDir, f), "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try {
        obj = JSON.parse(t);
      } catch {
        continue;
      }
      if (obj.type !== "chatmsg") continue;
      const ts = Number(obj.ts) || 0;
      if (ts < startTs || ts > endTs) continue;
      total++;
      const uid = String(obj.uid ?? "").trim();
      const nn = String(obj.nn ?? "").trim();
      let key = uid;
      if (!key && nn) key = `nn:${nn}`;
      if (key) identities.add(key);
    }
  }
  return { total, uniqueUsers: identities.size };
}

/** 日报/周报去重槽：直播间号 + 覆盖的日历跨度（与导出区间 start/end 对齐） */
function buildAiReportPeriodKey(roomId, kind, startTs, endTs) {
  const rid = String(roomId);
  if (kind === "daily") {
    return `daily:${rid}:${fmtLocalYmd(startTs)}`;
  }
  if (kind === "weekly") {
    return `weekly:${rid}:${fmtLocalYmd(startTs)}_${fmtLocalYmd(endTs)}`;
  }
  return `${kind}:${rid}:${fmtLocalYmd(startTs)}_${fmtLocalYmd(endTs)}`;
}

/**
 * 同一槽位重复生成时：隐藏旧条目（保留 JSON），返回需推送 SSE 删除事件的条目。
 * - 优先匹配 periodKey；
 * - 无 periodKey 的旧数据：仅当 periodLabel 与当前跨度文案完全一致时视为同槽（兼容升级前记录）。
 * @returns {{ roomId: string, entryId: string }[]}
 */
function hidePriorAiReportsForSameSlot(roomId, kind, periodKey, periodLabelSpan) {
  const rid = String(roomId);
  const label = periodLabelSpan != null ? String(periodLabelSpan) : "";
  const store = loadAiReportsStore();
  const removed = [];
  let changed = false;
  for (const e of store.entries) {
    if (String(e.roomId) !== rid || e.kind !== kind || e.hidden) continue;
    const byKey = e.periodKey === periodKey;
    const byLegacy = !e.periodKey && label && String(e.periodLabel || "") === label;
    if (byKey || byLegacy) {
      e.hidden = true;
      changed = true;
      removed.push({ roomId: rid, entryId: String(e.id) });
    }
  }
  if (changed) {
    try {
      saveAiReportsStore(store);
    } catch (err) {
      console.error("[ai-reports] bulk hide save failed:", err);
      return [];
    }
  }
  return removed;
}

/**
 * @param {string} preset today | 24h | yesterday | prev_calendar_day | 7days | prev_calendar_week | rolling_week | day:YYYY-MM-DD | week:YYYY-MM-DD
 * @returns {{ startTs: number, endTs: number, label: string } | null}
 */
function resolveAiExportRange(preset) {
  const key = String(preset || "").trim();
  if (key.startsWith("day:")) {
    const ymd = key.slice(4).trim();
    const b = parseLocalDayBounds(ymd);
    if (!b) return null;
    return { startTs: b.startTs, endTs: b.endTs, label: `指定日 ${ymd}` };
  }
  if (key.startsWith("week:")) {
    const ymd = key.slice(5).trim();
    const b = parseLocalDayBounds(ymd);
    if (!b) return null;
    const monday = mondayStartMsContaining(b.startTs);
    const sundayEnd = monday + 7 * 86400000 - 1;
    return {
      startTs: monday,
      endTs: sundayEnd,
      label: `指定周（周一至周日）${fmtLocalYmd(monday)}～${fmtLocalYmd(sundayEnd)}`,
    };
  }
  const now = Date.now();
  const sod = startOfLocalDayMs(now);
  switch (key) {
    case "today":
      return { startTs: sod, endTs: now, label: "今日" };
    case "24h":
      return { startTs: now - 86400000, endTs: now, label: "过去24小时" };
    case "yesterday": {
      const yStart = sod - 86400000;
      const yEnd = sod - 1;
      return { startTs: yStart, endTs: yEnd, label: "昨天" };
    }
    /** 日报：上一个自然日 [00:00, 24:00)（本地），便签仅显示该日 YYYY-MM-DD */
    case "prev_calendar_day": {
      const yStart = sod - 86400000;
      const yEnd = sod - 1;
      return { startTs: yStart, endTs: yEnd, label: fmtLocalYmd(yStart) };
    }
    case "7days":
      return { startTs: now - 7 * 86400000, endTs: now, label: "近7天" };
    /** 周报：上一个完整自然周（周一至周日，本地），便签显示起止日期 */
    case "prev_calendar_week": {
      const curMon = mondayStartMsContaining(now);
      const prevMonStart = curMon - 7 * 86400000;
      const prevSunEnd = prevMonStart + 7 * 86400000 - 1;
      return {
        startTs: prevMonStart,
        endTs: prevSunEnd,
        label: `${fmtLocalYmd(prevMonStart)}～${fmtLocalYmd(prevSunEnd)}`,
      };
    }
    case "rolling_week":
      return { startTs: sod - 6 * 86400000, endTs: now, label: "近一周（含今天，自6天前0点）" };
    default:
      return { startTs: sod, endTs: now, label: "今日" };
  }
}

/**
 * 从录制 jsonl 中收集 [startTs,endTs] 内的 chatmsg，最多保留最近 maxLines 条（按时间）。
 * @returns {{ lines: string[], totalMatched: number, truncated: boolean }}
 */
function collectDanmakuLinesInRange(roomId, startTs, endTs, maxLines) {
  const roomDir = join(RECORD_DIR, String(roomId));
  if (!existsSync(roomDir)) return { lines: [], totalMatched: 0, truncated: false };
  const files = readdirSync(roomDir).filter((f) => f.endsWith(".jsonl")).sort();
  const bucket = [];
  for (const f of files) {
    let content;
    try {
      content = readFileSync(join(roomDir, f), "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try {
        obj = JSON.parse(t);
      } catch {
        continue;
      }
      if (obj.type !== "chatmsg") continue;
      const ts = Number(obj.ts) || 0;
      if (ts < startTs || ts > endTs) continue;
      bucket.push({ ts, obj });
    }
  }
  bucket.sort((a, b) => a.ts - b.ts);
  const totalMatched = bucket.length;
  let truncated = false;
  if (bucket.length > maxLines) {
    truncated = true;
    bucket.splice(0, bucket.length - maxLines);
  }
  const lines = bucket.map(({ obj }) => {
    const d = new Date(obj.ts);
    const time = d.toLocaleString("zh-CN", { hour12: false });
    return `[${time}] ${obj.nn || "?"}: ${obj.txt || ""}`;
  });
  return { lines, totalMatched, truncated };
}

/**
 * @returns {{ lines: string[], totalMatched: number, truncated: boolean }}
 */
function collectGiftLinesInRange(roomId, startTs, endTs, maxLines) {
  migrateOldGiftFile(roomId);
  const index = loadGiftIndex(roomId);
  const bucket = [];
  for (let i = 0; i < index.fileCount; i++) {
    const chunk = loadJsonFile(giftChunkPath(roomId, i), []);
    for (const g of chunk) {
      const ts = archivedGiftEntryTsMs(g);
      if (!(ts > 0) || ts < startTs || ts > endTs) continue;
      bucket.push({ ts, g });
    }
  }
  bucket.sort((a, b) => a.ts - b.ts);
  const totalMatched = bucket.length;
  let truncated = false;
  if (bucket.length > maxLines) {
    truncated = true;
    bucket.splice(0, bucket.length - maxLines);
  }
  const lines = bucket.map(({ g }) => {
    const d = new Date(g.ts);
    const time = d.toLocaleString("zh-CN", { hour12: false });
    const name = g.gfn || g.gfid || "?";
    const n = giftPiecesFromStoredRecord(g);
    return `[${time}] ${g.nn || "匿名"} 赠送 ${name} ×${n}`;
  });
  console.log(
    `[danmaku] collectGiftLinesInRange roomId=${roomId} inclusive=[${giftLogFmtShanghai(startTs)} ~ ${giftLogFmtShanghai(endTs)}] ms=[${startTs}, ${endTs}] totalMatched=${totalMatched} returnedLines=${lines.length}(max=${maxLines}) truncated=${truncated} giftChunkFiles=${index.fileCount}`,
  );
  return { lines, totalMatched, truncated };
}

/**
 * 手填礼物的别名 → 与主名相同的 gfid（resolveArchivedGiftGfid 用 gfn 反查）。
 * 斗鱼 gdp/dgb 常为简称（如「赤兔」），与手动表 canonical 名「赤兔宝马」不一致时需配 aliases。
 */
function mergeManualGiftAliasesIntoNameIndex(m, catalogMap) {
  const blob = loadManualGiftMetricsFile();
  if (!blob?.entries?.length) return;
  for (const entry of blob.entries) {
    const gfidManual = String(entry.gfid ?? "").trim();
    const primary = normalizeGiftNameForManual(entry.name);
    if (!gfidManual || !primary) continue;
    let targetGfid = m.has(primary) ? m.get(primary) : null;
    if (targetGfid == null && catalogMap && catalogMap[gfidManual]) targetGfid = gfidManual;
    if (targetGfid == null) continue;
    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    for (const al of aliases) {
      const k = normalizeGiftNameForManual(al);
      if (!k) continue;
      m.set(k, targetGfid);
    }
  }
}

/**
 * 「战功礼」保底表 douyuFallbackGiftMetrics 的别名 → gfid。
 * canonical 已在礼单中则落到该真实 id；仅占位兜底则落到条目 gfid。b 已存在键不写（手填别名优先）。
 */
function mergeDouyuFallbackAliasesIntoNameIndex(m, catalogMap) {
  const list = readDouyuFallbackGiftMetricsFresh();
  if (!list.length) return;

  for (const entry of list) {
    const nm = String(entry.name ?? "").trim();
    const gfidFb = String(entry.gfid ?? "").trim();
    if (!nm || !gfidFb) continue;
    const primary = normalizeGiftNameForManual(nm);
    if (!primary) continue;

    let targetGfid = m.has(primary) ? m.get(primary) : null;
    if (targetGfid == null && catalogMap && catalogMap[gfidFb]) targetGfid = gfidFb;
    if (targetGfid == null) continue;

    const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
    for (const al of aliases) {
      const k = normalizeGiftNameForManual(al);
      if (!k) continue;
      if (!m.has(k)) m.set(k, targetGfid);
    }

    const nmNorm = normalizeGiftNameForManual(nm);
    const slot = catalogMap?.[gfidFb];
    if (slot && normalizeGiftNameForManual(String(slot.name ?? "").trim()) === nmNorm) {
      m.set(nmNorm, gfidFb);
    }
  }
}

/**
 * 从房间礼单建「礼物展示名 → gfid」索引（小写、去首尾空）；同名多 id 时取先遍历到的。
 * 合并 `douyu-manual-gift-metrics.json` 中 entries[].aliases；合并 `douyuFallbackGiftMetrics` 中 aliases。
 * @param {Record<string, { name?: string }>|null|undefined} catalogMap
 * @returns {Map<string, string>}
 */
function buildGiftNameToGfidIndex(catalogMap) {
  /** @type {Map<string, string>} */
  const m = new Map();
  if (catalogMap && typeof catalogMap === "object") {
    for (const [id, meta] of Object.entries(catalogMap)) {
      if (!id || id === "0") continue;
      const n = String(meta?.name ?? "").trim().toLowerCase();
      if (!n) continue;
      if (!m.has(n)) m.set(n, id);
    }
  }
  mergeManualGiftAliasesIntoNameIndex(m, catalogMap);
  mergeDouyuFallbackAliasesIntoNameIndex(m, catalogMap);
  return m;
}

/**
 * 归档聚合用 gfid：优先保证与行内礼物展示名（gfn）能在礼单中对上，否则手填兜底（如「赤兔宝马」）无法计入收入。
 *
 * 典型坏例：下行带了占位/错误 gfid，但 gfn 为正确中文名；礼单里该 id 无名或与 gfn 不一致，若盲信 gfid 会落到无 isPaid 的条目上。
 *
 * @param {object} g 归档礼物行
 * @param {Map<string, string>|null|undefined} nameToGfid
 * @param {Record<string, { name?: string }>|null|undefined} [catalogMap] 当前房间 merge 后礼单；传入时才可做「展示名 vs gfn」一致性校验
 */
function resolveArchivedGiftGfid(g, nameToGfid, catalogMap = null) {
  const raw = archivedGiftWireId(g);
  const gfn = String(g.gfn ?? "").trim();
  const gfnLower = gfn ? gfn.toLowerCase() : "";
  const fromName =
    gfnLower && nameToGfid && nameToGfid.size > 0 ? nameToGfid.get(gfnLower) : undefined;

  if (fromName && gfn) {
    if (!raw || raw === "0") return fromName;
    if (!catalogMap) return raw;

    const rawMeta = catalogMap[raw];
    const rawNameNorm = String(rawMeta?.name ?? "").trim()
      ? normalizeGiftNameForManual(rawMeta.name)
      : "";
    const gfnNorm = normalizeGiftNameForManual(gfn);

    if (!rawMeta || (rawNameNorm && rawNameNorm !== gfnNorm) || (!rawNameNorm && Boolean(gfnNorm))) {
      return fromName;
    }
  }

  if (raw && raw !== "0") return raw;
  if (fromName) return fromName;
  return raw || "0";
}

/** 当前合并礼单能否解释该 gfid（占位 gfid=0 不算）。用于礼物统计分桶。 */
function catalogGiftStatsLooksResolved(gfid, catalogMap) {
  const gid = String(gfid ?? "").trim() || "0";
  const meta = catalogMap?.[gid];
  if (!meta || typeof meta !== "object") return false;
  if (gid === "0") return false;
  return String(meta.name ?? "").trim() !== "";
}

/**
 * 统计聚合键：有礼单则用 gfid；否则若有归档展示名则按名拆开（避免全部并入 gfid=0「未知礼物」）。
 */
function giftStatsBucketKey(resolvedGfid, gfn, catalogMap) {
  const gid = String(resolvedGfid ?? "").trim() || "0";
  const fn = String(gfn ?? "").trim();
  if (catalogGiftStatsLooksResolved(gid, catalogMap)) return gid;
  if (fn) return `__gfn:${normalizeGiftNameForManual(fn)}`;
  return gid;
}

/**
 * 统计时间窗内礼物：按 gfid / 用户聚合（与 collectGiftLinesInRange 同源数据）。
 * @param {Map<string, string>|null} [nameToGfid] 若有，则对缺 gfid/为0 或与礼单名不一致的记录按 gfn 反查礼单
 * @param {Record<string, { name?: string }>|null} [catalogMap] 与 fetchGiftListPayload().gifts 同源，供 resolveArchivedGiftGfid 校验
 * @returns {{ totalPieces: number, byGift: Record<string, { count: number, name: string }>, byUser: Record<string, { nn: string, count: number, gifts: Record<string, number> }> }}
 *          byGift 键可为真实 gfid，或无名但有 gfn 时的 `__gfn:${normalize}`。
 */
function aggregateGiftsInTimeRange(roomId, startTs, endTs, nameToGfid = null, catalogMap = null) {
  migrateOldGiftFile(roomId);
  const index = loadGiftIndex(roomId);
  /** @type {Record<string, { count: number, name: string }>} */
  const byGift = {};
  /** @type {Record<string, { nn: string, count: number, gifts: Record<string, number> }>} */
  const byUser = {};
  let totalPieces = 0;
  for (let i = 0; i < index.fileCount; i++) {
    const chunk = loadJsonFile(giftChunkPath(roomId, i), []);
    for (const g of chunk) {
      const ts = archivedGiftEntryTsMs(g);
      if (!(ts > 0) || ts < startTs || ts > endTs) continue;
      // Skip legacy spbc broadcast notifications (not actual gifts)
      if (g._giftWire === "spbc") continue;
      const gfidResolved = resolveArchivedGiftGfid(g, nameToGfid, catalogMap);
      const amt = giftPiecesFromStoredRecord(g);
      const gfnTrim = String(g.gfn ?? "").trim();
      const bucket = giftStatsBucketKey(gfidResolved, gfnTrim, catalogMap);
      totalPieces += amt;
      if (!byGift[bucket]) byGift[bucket] = { count: 0, name: "", _priceSumYuan: 0 };
      byGift[bucket].count += amt;
      if (gfnTrim) byGift[bucket].name = gfnTrim;
      else if (!byGift[bucket].name && catalogMap?.[gfidResolved]?.name) {
        byGift[bucket].name = String(catalogMap[gfidResolved].name);
      }
      // Accumulate _price for dfobc/dfrbc records (price in fish-fin units, /100 = CNY)
      const rawPrice = Number(g._price || g.price || 0);
      if (rawPrice > 0 && (g._giftWire === "dfobc" || g._giftWire === "dfrbc")) {
        byGift[bucket]._priceSumYuan += rawPrice / 100;
      }
      const uid = String(g.uid || "anon");
      if (!byUser[uid]) byUser[uid] = { nn: g.nn || "", count: 0, gifts: {}, _priceSumYuan: 0 };
      if (g.nn) byUser[uid].nn = g.nn;
      byUser[uid].count += amt;
      byUser[uid].gifts[bucket] = (byUser[uid].gifts[bucket] || 0) + amt;
      if (rawPrice > 0 && (g._giftWire === "dfobc" || g._giftWire === "dfrbc")) {
        byUser[uid]._priceSumYuan += rawPrice / 100;
      }
    }
  }
  return { totalPieces, byGift, byUser };
}

/**
 * 与 GET /gifts/:rid/stats 同源聚合；可选收集归档行快照供前端调试面板对照。
 * @param {string} rid
 * @param {string} range
 * @param {number} nowMs
 * @param {{ collectDebugRows?: boolean, debugRowsMax?: number }} [opts]
 */
async function computeRoomGiftStatsPanelBundle(rid, range, nowMs, opts = {}) {
  const collectDebugRows = Boolean(opts.collectDebugRows);
  const debugRowsMax = Math.min(15_000, Math.max(1, Number(opts.debugRowsMax) || 8000));

  const { startTs, endTs } = computeGiftStatsTimeWindow(range, nowMs);
  migrateOldGiftFile(rid);
  const index = loadGiftIndex(rid);
  const giftPack = await fetchGiftListPayload(rid);
  const nameIdx = buildGiftNameToGfidIndex(giftPack?.gifts);

  const stats = { totalValue: 0, totalCount: 0, byGift: {}, byUser: {} };
  let matchedGiftRows = 0;
  /** @type {object[]} */
  const debugRows = collectDebugRows ? [] : [];

  for (let i = 0; i < index.fileCount; i++) {
    const chunk = loadJsonFile(giftChunkPath(rid, i), []);
    for (const g of chunk) {
      const ts = archivedGiftEntryTsMs(g);
      if (!(ts > 0) || ts < startTs) continue;
      if (Number.isFinite(endTs) && ts >= endTs) continue;
      // Skip legacy spbc broadcast notifications (not actual gifts)
      if (g._giftWire === "spbc") continue;
      matchedGiftRows++;
      const gfidResolved = resolveArchivedGiftGfid(g, nameIdx, giftPack?.gifts);
      const amount = giftPiecesFromStoredRecord(g);
      const gfnTrim = String(g.gfn ?? "").trim();
      const bucket = giftStatsBucketKey(gfidResolved, gfnTrim, giftPack?.gifts);

      if (collectDebugRows && debugRows.length < debugRowsMax) {
        const pidRaw = String(g.pid ?? g.gid ?? g.giftId ?? "").trim();
        debugRows.push({
          ts,
          gfidStored: String(g.gfid ?? "").trim(),
          pid: pidRaw || null,
          gfidResolved,
          bucket,
          gfcnt: g.gfcnt,
          pieces: amount,
          gfn: gfnTrim || null,
          uid: g.uid ?? null,
          nn: g.nn ?? null,
        });
      }

      if (!stats.byGift[bucket]) stats.byGift[bucket] = { count: 0, name: "", _priceSumYuan: 0 };
      stats.byGift[bucket].count += amount;
      if (gfnTrim) stats.byGift[bucket].name = gfnTrim;
      else if (!stats.byGift[bucket].name && giftPack?.gifts?.[gfidResolved]?.name) {
        stats.byGift[bucket].name = String(giftPack.gifts[gfidResolved].name);
      }
      // Accumulate _price for dfobc/dfrbc records
      const rawPricePanel = Number(g._price || g.price || 0);
      if (rawPricePanel > 0 && (g._giftWire === "dfobc" || g._giftWire === "dfrbc")) {
        stats.byGift[bucket]._priceSumYuan += rawPricePanel / 100;
      }
      const uid = g.uid || "anon";
      if (!stats.byUser[uid])
        stats.byUser[uid] = {
          nn: g.nn || "",
          level: g.level || "",
          bnn: g.bnn || "",
          bl: g.bl || "",
          brid: g.brid || "",
          count: 0,
          gifts: {},
          _priceSumYuan: 0,
        };
      if (g.nn) stats.byUser[uid].nn = g.nn;
      if (g.level) stats.byUser[uid].level = g.level;
      if (g.bnn) stats.byUser[uid].bnn = g.bnn;
      if (g.bl) stats.byUser[uid].bl = g.bl;
      if (g.brid) stats.byUser[uid].brid = g.brid;
      stats.byUser[uid].count += amount;
      if (!stats.byUser[uid].gifts[bucket]) stats.byUser[uid].gifts[bucket] = 0;
      stats.byUser[uid].gifts[bucket] += amount;
      if (rawPricePanel > 0 && (g._giftWire === "dfobc" || g._giftWire === "dfrbc")) {
        stats.byUser[uid]._priceSumYuan += rawPricePanel / 100;
      }
      stats.totalCount += amount;
    }
  }

  return {
    stats,
    matchedGiftRows,
    giftChunkFiles: index.fileCount,
    startTs,
    endTs,
    giftMergeStats: giftPack?.stats ?? null,
    debugRows: collectDebugRows ? debugRows : [],
    debugRowsTruncated: collectDebugRows && matchedGiftRows > debugRows.length,
    debugRowsMaxRequested: collectDebugRows ? debugRowsMax : 0,
    debugRowsReturned: collectDebugRows ? debugRows.length : 0,
  };
}

/** 日报数据概览：礼物金额拆分（catalog 已在 fetchGiftListPayload 中换算为「元」）
 * - 收入：isPaid 礼物的「主播侧分成价」value × 件数
 * - 付费数：同批礼物的「观众标价」cost × 件数；cost 为 0 时退回用 value（与旧版口径兼容）
 * - 付费人数：上述观众支出估算 > 0 的去重送礼 uid 数
 */
function computeGiftFinancialStats(roomId, startTs, endTs, catalogMap) {
  const nameIdx = buildGiftNameToGfidIndex(catalogMap);
  const { byGift, byUser } = aggregateGiftsInTimeRange(roomId, startTs, endTs, nameIdx, catalogMap);
  let streamerIncomeYuan = 0;
  let audiencePaidYuan = 0;
  for (const [gfid, v] of Object.entries(byGift)) {
    // Direct price from dfobc/dfrbc (diamond fan open/renew) — always counts as paid
    if (v._priceSumYuan > 0) {
      streamerIncomeYuan += v._priceSumYuan;
      audiencePaidYuan += v._priceSumYuan;
      continue;
    }
    const meta = catalogMap && catalogMap[gfid];
    if (!meta || meta.isPaid !== true) continue;
    const costPiece = Number(meta.cost) || 0;
    const valPiece = Number(meta.value) || 0;
    if (valPiece > 0) streamerIncomeYuan += valPiece * v.count;
    const spendPiece = costPiece > 0 ? costPiece : valPiece;
    if (spendPiece > 0) audiencePaidYuan += spendPiece * v.count;
  }
  let paidUserCount = 0;
  for (const u of Object.values(byUser)) {
    let uvSpend = 0;
    // Direct price from dfobc/dfrbc per user
    if (u._priceSumYuan > 0) uvSpend += u._priceSumYuan;
    for (const [gfid, c] of Object.entries(u.gifts)) {
      const meta = catalogMap && catalogMap[gfid];
      if (!meta || meta.isPaid !== true) continue;
      const costPiece = Number(meta.cost) || 0;
      const valPiece = Number(meta.value) || 0;
      const spendPiece = costPiece > 0 ? costPiece : valPiece;
      if (spendPiece > 0) uvSpend += spendPiece * c;
    }
    if (uvSpend > 0) paidUserCount++;
  }
  return {
    giftSenderCount: Object.keys(byUser).length,
    paidUserCount,
    streamerIncomeApproxYuan: streamerIncomeYuan,
    audiencePaidApproxYuan: audiencePaidYuan,
  };
}

/**
 * 生成供给 AI 的「礼物排行 / 付费维度 / 图标对照」文本（本地归档 + 礼物 catalog，非抓取第三方排行站）。
 * @param {Record<string, { name?: string, icon?: string, value?: number, isPaid?: boolean }>|null} catalogMap fetchGiftListPayload().gifts
 */
function formatGiftRankDigestForAi(roomId, startTs, endTs, catalogMap) {
  const nameIdx = buildGiftNameToGfidIndex(catalogMap);
  const { totalPieces, byGift, byUser } = aggregateGiftsInTimeRange(roomId, startTs, endTs, nameIdx, catalogMap);
  const lines = [];
  lines.push(
    "说明：以下均来自本服务对该房间的礼物归档与斗鱼礼物配置缓存；不等同斗鱼官方榜单或第三方直播间排行站点（如「在看直播」类数据站）的实时口径，请勿写成官方结算或外链抓取结果。",
  );
  if (totalPieces === 0) {
    lines.push("");
    lines.push("（统计窗口内无礼物归档记录；礼物需在房间连接期间由服务器存档。）");
    return lines.join("\n");
  }

  let paidPieceApprox = 0;
  let otherPieceApprox = 0;
  for (const [gfid, v] of Object.entries(byGift)) {
    const meta = catalogMap && catalogMap[gfid];
    const amt = v.count;
    if (meta && meta.isPaid === true) paidPieceApprox += amt;
    else otherPieceApprox += amt;
  }
  lines.push("");
  lines.push(
    `窗口内礼物件数合计：${totalPieces}（件数 = 各次赠送数量之和）。其中 catalog 标为「有主播收益」的礼物约 ${paidPieceApprox} 件；其余或未命中 catalog 约 ${otherPieceApprox} 件（仅供参考）。`,
  );

  lines.push("");
  lines.push("【按礼物类型 · 送出件数 Top 12】💰= catalog 判定有主播收益；🆓= 无收益或未命中；❔= 无 catalog");

  const giftRows = Object.entries(byGift).map(([gfid, v]) => {
    const meta = catalogMap && catalogMap[gfid];
    const name = (v.name || meta?.name || gfid).trim() || gfid;
    let tag = "❔";
    if (meta) tag = meta.isPaid ? "💰" : "🆓";
    const valPiece = Number(meta?.value) || 0;
    const estStreamerYuan = meta && meta.isPaid && valPiece > 0 ? valPiece * v.count : 0;
    const iconHint = meta && meta.icon ? "有图标URL" : "无图标";
    return { gfid, name, count: v.count, tag, estStreamerYuan, iconHint };
  });
  giftRows.sort((a, b) => b.count - a.count);
  giftRows.slice(0, 12).forEach((r, i) => {
    const valPart = r.estStreamerYuan > 0 ? `；按单件 contribution/10 估算主播侧约 ${r.estStreamerYuan.toFixed(1)} 元` : "";
    lines.push(`${i + 1}. ${r.tag} ${r.name}（gfid=${r.gfid}，${r.iconHint}）×${r.count} 件${valPart}`);
  });

  lines.push("");
  lines.push("【送礼用户 · 件数 Top 10】");
  const userRows = Object.entries(byUser).map(([uid, u]) => ({ uid, nn: u.nn, count: u.count, gifts: u.gifts }));
  userRows.sort((a, b) => b.count - a.count);
  userRows.slice(0, 10).forEach((u, i) => {
    const topGifts = Object.entries(u.gifts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([gfid, c]) => {
        const nm = (byGift[gfid]?.name || (catalogMap && catalogMap[gfid]?.name) || gfid).trim();
        return `${nm}×${c}`;
      })
      .join("；");
    lines.push(`${i + 1}. ${u.nn || "?"}（uid=${u.uid}）合计 ${u.count} 件；偏多：${topGifts || "—"}`);
  });

  lines.push("");
  lines.push("【送礼用户 · 有收益礼物估算价值 Top 8】（单件 value×件数；缺 catalog 或未标有收益不计入）");
  /** @type {Record<string, { nn: string, val: number }>} */
  const userVal = {};
  for (const [uid, u] of Object.entries(byUser)) {
    let tv = 0;
    for (const [gfid, c] of Object.entries(u.gifts)) {
      const meta = catalogMap && catalogMap[gfid];
      const valPiece = Number(meta?.value) || 0;
      if (meta && meta.isPaid && valPiece > 0) tv += valPiece * c;
    }
    if (tv > 0) userVal[uid] = { nn: u.nn || "", val: tv };
  }
  const valRows = Object.entries(userVal)
    .map(([uid, v]) => ({ uid, ...v }))
    .sort((a, b) => b.val - a.val);
  if (valRows.length === 0) {
    lines.push("（无可用估算：可能未拉到礼物 catalog 或窗口内多为无收益礼。）");
  } else {
    valRows.slice(0, 8).forEach((r, i) => {
      lines.push(`${i + 1}. ${r.nn || "?"}（uid=${r.uid}）估算主播收益约 ${r.val.toFixed(1)} 元`);
    });
  }

  lines.push("");
  lines.push(
    "【写作提示】请在日报/周报中用独立小节做「礼物排行与类型解读」：结合上表名次，说明高频礼物的辨识度（名称/是否常出现带图标的礼物）、💰与🆓的大致格局，并可类比普通「直播间礼物贡献榜」的阅读方式——但不得编造未出现在摘要中的排名，不得声称数据来自特定第三方网站。",
  );

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/*  AI export bundle + 触发器：日报 / 周报（调用本机 ai-agent-server）    */
/* ------------------------------------------------------------------ */

/**
 * 触发器日报/周报的 modelId 与 ai-agent-server /chat 一致。
 * 未设置 FMZ_TRIGGER_AI_MODEL 时，运行时从 GET /models 拉取顺序（已与心跳可达性、Gemini/Qwen 优先级对齐）并降级；
 * 显式指定时仅保留仍出现在 /models 中的 id（与后台屏蔽一致）；若与可达列表无交集则回退为整条 /models 链。
 */

/**
 * 弹幕服务调用 ai-agent-server 的内网基址（不含尾斜杠）。
 * 默认 http://127.0.0.1:8792（与 server/ai-agent-server.mjs、Vite /__fmz_ai_agent 代理一致）。
 * 部署分离时可设置 AI_AGENT_INTERNAL_URL；若仅改端口也可设 AI_AGENT_PORT 统一默认主机端口。
 */
const AI_AGENT_INTERNAL_PORT = parseInt(String(process.env.AI_AGENT_PORT || "8792"), 10);
const AI_AGENT_INTERNAL_URL = String(
  process.env.AI_AGENT_INTERNAL_URL
    || `http://127.0.0.1:${Number.isFinite(AI_AGENT_INTERNAL_PORT) ? AI_AGENT_INTERNAL_PORT : 8792}`,
).replace(/\/+$/, "");

function parseExplicitTriggerAiModelIdsFromEnv() {
  const raw = process.env.FMZ_TRIGGER_AI_MODEL?.trim();
  if (!raw) return null;
  return raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

const FALLBACK_AI_MODEL_IDS_WHEN_AGENT_LIST_EMPTY = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-flash-latest",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash",
  "qwen-long",
  "qwen-plus",
  "qwen-max",
  "qwen-turbo",
];

/** 剔除 Google 列出但仅以 AUDIO/TTS 为输出模态的 Gemini，避免周报等文本任务先试到不可用的模型 */
function coerceAiTriggerCandidateModelIds(ids) {
  const list = [...ids];
  const filtered = list.filter(geminiEligibleForOpenAiCompatTextChat);
  return filtered.length > 0 ? filtered : [...FALLBACK_AI_MODEL_IDS_WHEN_AGENT_LIST_EMPTY];
}

let aiAgentListedModelIdsCache = { ids: [], fetchedAt: 0 };
const AI_AGENT_MODEL_IDS_CACHE_TTL_MS = 120_000;

async function fetchAiAgentListedModelIdsFresh() {
  const res = await fetch(`${AI_AGENT_INTERNAL_URL}/models`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return [];
  let j;
  try {
    j = JSON.parse(await res.text());
  } catch {
    return [];
  }
  const rows = Array.isArray(j.models) ? j.models : [];
  return rows.map((m) => String(m?.id ?? "").trim()).filter(Boolean);
}

async function resolveAiAgentTriggerModelCandidates() {
  const explicit = parseExplicitTriggerAiModelIdsFromEnv();
  const now = Date.now();
  const { ids: cachedIds, fetchedAt } = aiAgentListedModelIdsCache;

  let listed = [];
  const cacheFresh = cachedIds.length > 0 && now - fetchedAt < AI_AGENT_MODEL_IDS_CACHE_TTL_MS;
  if (cacheFresh) {
    listed = [...cachedIds];
  } else {
    try {
      const raw = await fetchAiAgentListedModelIdsFresh();
      if (raw.length) {
        const coerced = coerceAiTriggerCandidateModelIds(raw);
        aiAgentListedModelIdsCache = { ids: coerced, fetchedAt: now };
        listed = coerced;
      }
    } catch {
      listed = [];
    }
  }

  if (explicit?.length) {
    if (listed.length) {
      const filtered = explicit.filter((id) => listed.includes(id));
      if (filtered.length) return coerceAiTriggerCandidateModelIds(filtered);
      console.warn(
        "[ai-report] FMZ_TRIGGER_AI_MODEL 与 ai-agent 当前可达模型列表无交集，改用 /models 顺序（均已纳入心跳屏蔽策略）",
      );
    } else {
      return coerceAiTriggerCandidateModelIds(explicit);
    }
  }

  if (listed.length) return listed;

  return cachedIds.length ? coerceAiTriggerCandidateModelIds(cachedIds) : [...FALLBACK_AI_MODEL_IDS_WHEN_AGENT_LIST_EMPTY];
}

function chatAiAgentInternalUrlHint() {
  return `当前 AI_AGENT_INTERNAL_URL=${AI_AGENT_INTERNAL_URL}（可通过环境变量 AI_AGENT_INTERNAL_URL 或 AI_AGENT_PORT 覆盖）；请确认已启动 ai-agent-server（npm run ai-agent-server 或 npm run dev:all）。`;
}

function isAiAgentUnreachableMessage(msg) {
  const s = String(msg);
  return (
    /\bECONNREFUSED\b/i.test(s)
    || /fetch failed/i.test(s)
    || /ENOTFOUND/i.test(s)
    || /\bUND_ERR_CONNECT_TIMEOUT\b/i.test(s)
    || /AI agent HTTP/i.test(s)
  );
}

function isGeminiQuotaOrRateLimitError(msg) {
  const s = String(msg);
  return (
    /\b429\b/.test(s)
    || /quota/i.test(s)
    || /RESOURCE_EXHAUSTED/i.test(s)
    || /rate\s*limit/i.test(s)
    || /limit:\s*0/i.test(s)
  );
}

/** 当前模型不可用（配额/上游/瞬时故障等）时换下一候选，不限于单一厂商 */
function isRecoverableAiUpstreamModelError(msg) {
  const s = String(msg);
  if (isGeminiQuotaOrRateLimitError(s)) return true;
  if (/AI agent HTTP (400|401|402|403|404|408|409|413|421|422|423|425|426|427|428|429|500|502|503|504|522|524)\b/i.test(s)) {
    // 400：多为「模型不接受文本 modality」（如 Gemini TTS 专用），可换下一个候选；排除明显客户端错误短语
    if (/\b400\b/.test(s) && /\bMISSING\b|invalid\s+json|missing\s+model/i.test(s)) return false;
    return true;
  }
  if (/Upstream error\s*\(\s*(400|404|408|409|413|429|5\d\d)\s*\)/i.test(s)) return true;
  if (
    /no\s+longer\s+available|not available|invalid[_ ]?model|model[_ ]not[_ ]found|does not exist|insufficient[_ ]quota|billing|capacity|overload|timed?\s*out|temporar(il)?y unavailable/i.test(
      s,
    )
  ) {
    return true;
  }
  if (/ECONNRESET|ETIMEDOUT|ECONNABORTED|fetch failed|UND_ERR_CONNECT_TIMEOUT/i.test(s)) return true;
  // 流读到一半断连（服务重启、上游掐断、undici 常见报错 message 为 terminated）
  if (/\bterminated\b|aborted a request/i.test(s)) return true;
  return false;
}

/** 上游判定为「提示过长 / 上下文超限」等，应缩小分块与入模体积后重试，而不是仅换模型 */
function isLikelyContextLengthExceededError(msg) {
  const s = String(msg);
  if (/\b413\b/.test(s) || /payload too large/i.test(s) || /request entity too large/i.test(s)) {
    return true;
  }
  if (
    /context[_\s-]*(length|window|overflow)/i.test(s)
    || /maximum\s*context/i.test(s)
    || /exceed(ed|s)?(\s+the)?\s+max(imum)?(\s+)?(context|input|prompt|token)/i.test(s)
    || /too\s*(many|large)\s*tokens?/i.test(s)
    || /token\s*(count|limit)/i.test(s)
    || /prompt\s*is\s*too\s*long/i.test(s)
    || /input\s*(is\s*)?too\s*long/i.test(s)
    || /LENGTH_REQUIRED|CONTEXT_LENGTH|prompt_tokens/i.test(s)
    || /context_window_exceeded/i.test(s)
    || /reduce\s+the\s+length/i.test(s)
    || /INVALID_ARGUMENT.*(length|size|token)/i.test(s)
    || /输入.{0,6}过长|上下文.{0,6}[超满]|超出.{0,6}[长限]/i.test(s)
  ) {
    return true;
  }
  // 400/502 等但正文里带了长度相关 JSON（常见 OpenAI / 千问 / Gemini 错误体回传到 message）
  if (
    /AI agent HTTP 400\b/i.test(s)
    && /context|token|length|too[_\s]?long|maximum|prompt/i.test(s)
  ) {
    return true;
  }
  return false;
}

/** 遇可恢复错误时在候选中依次尝试其它模型（如 Gemini 失败再试千问/OpenAI）；其它错误或非最后一个候选仍立即抛出 */
async function chatAiAgentAccumulateFirstAvailable(modelIds, messages) {
  if (!modelIds.length) {
    throw new Error("无可用模型候选（请配置 FMZ_TRIGGER_AI_MODEL，或启动 ai-agent-server 并配置至少一类 API 密钥）");
  }
  let lastErr = null;
  for (let i = 0; i < modelIds.length; i++) {
    const modelId = modelIds[i];
    try {
      console.log(`[ai-report] 尝试模型 ${modelId}（${i + 1}/${modelIds.length}）`);
      const text = await chatAiAgentAccumulate(modelId, messages);
      if (i > 0) console.log(`[ai-report] 使用备选模型 ${modelId} 生成成功`);
      else console.log(`[ai-report] 模型 ${modelId} 生成成功`);
      return text;
    } catch (e) {
      lastErr = e;
      const errMsg = e && e.message ? String(e.message) : String(e);
      const tryNext = i < modelIds.length - 1 && isRecoverableAiUpstreamModelError(errMsg);
      if (tryNext) {
        console.warn(`[ai-report] 模型 ${modelId} 不可用，尝试下一候选:`, errMsg.slice(0, 220));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("AI 调用失败");
}

function humanizeAiReportFailure(msg) {
  const s = String(msg);
  if (/\bterminated\b/i.test(s)) {
    return /流式响应中途断开|systemctl restart/i.test(s)
      ? "生成过程中连接被中断（多在跑日报时执行了服务重启/deploy）；请避开维护窗口后重试。"
      : "生成过程中流被中断（报 terminated）：常见于服务重启、上游断连或代理超时；请稍后重试。";
  }
  if (isRecoverableAiUpstreamModelError(s) && /\b429\b|quota|RESOURCE_EXHAUSTED/i.test(s)) {
    return "上游配额或限流（如 429）：请检查各平台额度；未设置 FMZ_TRIGGER_AI_MODEL 时会按 ai-agent 模型列表依次切换（例如 Gemini→OpenAI→千问，千问内需 long 优先）。也可手写：FMZ_TRIGGER_AI_MODEL=gemini-2.5-flash,qwen-long,qwen-plus,gpt-4o-mini";
  }
  if (isAiAgentUnreachableMessage(s)) {
    return `${s.length > 280 ? `${s.slice(0, 280)}…` : s} — ${chatAiAgentInternalUrlHint()}`;
  }
  return s.length > 420 ? `${s.slice(0, 420)}…` : s;
}
const MAX_AI_REPORT_ENTRIES = 500;

/** 弹幕超过约此行数时：先分段请模型写「要点」，再合成正式日报/周报，减轻单请求体积与断流 */
const AI_REPORT_CHUNK_DM_LINES = Math.max(200, Number(process.env.FMZ_AI_REPORT_CHUNK_DM_LINES) || 1600);
/** 单段摘录字符数超过该值时，自动缩小每段行数，避免单段仍过大 */
const AI_REPORT_CHUNK_FORCE_CHARS = Math.max(50_000, Number(process.env.FMZ_AI_REPORT_CHUNK_FORCE_CHARS) || 220_000);
/** 发给 AI 的礼物明细行数上限（全量常顶爆上下文；排行摘要已单独提供） */
const AI_REPORT_MAX_GIFT_LINES_IN_PROMPT = Math.max(80, Number(process.env.FMZ_AI_REPORT_MAX_GIFT_LINES) || 650);
/** 仅日报：弹幕总字符超此值且当前只会打一段时，强制拆成多段预摘要 */
const AI_REPORT_DAILY_FORCE_CHUNK_TEXT_CHARS = Math.max(30_000, Number(process.env.FMZ_AI_REPORT_DAILY_FORCE_CHUNK_CHARS) || 96_000);
/** 强制拆段时的最少段数（在日文本字符触发时） */
const AI_REPORT_DAILY_FORCE_MIN_PARTS = Math.max(2, Math.min(8, Number(process.env.FMZ_AI_REPORT_DAILY_FORCE_MIN_PARTS) || 3));
/** 分段日报合成时，均匀抽样并入模的原文弹幕行数（供「最佳弹幕」等逐字引用） */
const AI_REPORT_VERBATIM_DM_SAMPLE = Math.max(40, Number(process.env.FMZ_AI_REPORT_VERBATIM_DM_SAMPLE) || 160);
/** 终稿/SSE 因上下文过长失败时，自动缩小分块并重试的次数上限（含首次） */
const AI_REPORT_CONTEXT_RETRY_MAX = Math.max(1, Math.min(8, Number(process.env.FMZ_AI_REPORT_CONTEXT_RETRY_MAX) || 4));

/**
 * @param {string[]} giftLines
 * @param {string} giftTextFallback
 * @param {number} [maxGiftLines]
 */
function limitGiftLinesForAiPrompt(giftLines, giftTextFallback, maxGiftLines = AI_REPORT_MAX_GIFT_LINES_IN_PROMPT) {
  const cap = Math.max(80, maxGiftLines);
  const lines = Array.isArray(giftLines) ? giftLines : [];
  if (!lines.length) return { text: giftTextFallback, truncated: false, included: 0 };
  if (lines.length <= cap) {
    return { text: lines.join("\n"), truncated: false, included: lines.length };
  }
  const sampled = sampleLinesEvenly(lines, cap);
  return { text: sampled.join("\n"), truncated: true, included: sampled.length };
}

/**
 * 在「字符量/礼物量」仍巨大但只有一段弹幕时，强制拆多段做预摘要（主要救日报）。
 * @param {string[]} dmLines
 * @param {string} joinedDm
 * @param {{ kind: string, giftTextLen: number }} ctx
 * @param {{ chunkDmLines?: number, chunkForceChars?: number, dailyForceChunkTextChars?: number, dailyForceMinParts?: number }} [opts]
 * @returns {string[][]}
 */
function computeDanmakuLineChunksMaybeForceDaily(dmLines, joinedDm, ctx, opts = {}) {
  const dailyForceChunkTextChars = opts.dailyForceChunkTextChars ?? AI_REPORT_DAILY_FORCE_CHUNK_TEXT_CHARS;
  const dailyForceMinParts = opts.dailyForceMinParts ?? AI_REPORT_DAILY_FORCE_MIN_PARTS;
  let chunks = computeDanmakuLineChunks(dmLines, joinedDm, opts);
  const n = dmLines.length;
  if (!n) return chunks;
  const textLen = String(joinedDm || "").length;
  const giftLen = ctx.giftTextLen || 0;
  if (ctx.kind !== "daily" || chunks.length > 1) return chunks;
  const heavy = textLen >= dailyForceChunkTextChars || giftLen >= 140_000;
  if (!heavy) return chunks;
  const parts = Math.min(dailyForceMinParts, n);
  const forceSize = Math.max(250, Math.ceil(n / parts));
  chunks = [];
  for (let i = 0; i < n; i += forceSize) chunks.push(dmLines.slice(i, i + forceSize));
  if (chunks.length < 2) return computeDanmakuLineChunks(dmLines, joinedDm, opts);
  return chunks;
}

/**
 * @param {string[]} lines
 * @param {string} joinedText lines.join("\n")
 * @param {{ chunkDmLines?: number, chunkForceChars?: number }} [opts]
 * @returns {string[][]}
 */
function computeDanmakuLineChunks(lines, joinedText, opts = {}) {
  const chunkDmCap = opts.chunkDmLines ?? AI_REPORT_CHUNK_DM_LINES;
  const chunkForceChars = opts.chunkForceChars ?? AI_REPORT_CHUNK_FORCE_CHARS;
  const n = lines.length;
  if (!n) return [];
  let size = chunkDmCap;
  const textLen = String(joinedText || "").length;
  if (textLen > chunkForceChars) {
    const needParts = Math.max(2, Math.ceil(textLen / chunkForceChars));
    size = Math.max(400, Math.ceil(n / needParts));
    size = Math.min(size, chunkDmCap);
  }
  /** @type {string[][]} */
  const chunks = [];
  for (let i = 0; i < n; i += size) chunks.push(lines.slice(i, i + size));
  return chunks;
}

/**
 * @param {string[]} lines
 * @param {number} maxSamples
 */
function sampleLinesEvenly(lines, maxSamples) {
  const n = lines.length;
  if (n <= maxSamples) return lines.slice();
  const out = [];
  const step = (n - 1) / (maxSamples - 1);
  for (let i = 0; i < maxSamples; i++) out.push(lines[Math.min(n - 1, Math.round(i * step))]);
  return out;
}

/**
 * @param {string[]} modelCandidates
 * @param {string} roomDisplay
 * @param {string} rangeLabel
 * @param {string[][]} lineChunks
 */
async function summarizeDanmakuChunksForFinalReport(modelCandidates, roomDisplay, rangeLabel, lineChunks) {
  const total = lineChunks.length;
  const parts = [];
  for (let i = 0; i < total; i++) {
    const chunkText = lineChunks[i].join("\n");
    const user = [
      `房间 ${roomDisplay}，统计窗口 ${rangeLabel}。以下为第 ${i + 1}/${total} 段弹幕摘录（时间连续，勿当全文）。`,
      "请用中文输出 6～14 条要点，每条单独一行，以「- 」开头。关注：氛围与情绪、主要话题/梗、有无骂战或节奏突变、刷屏与复读、付费或起哄相关口吻。",
      "不要写正式日报/周报、不要写「数据概览」、不要输出 <<<FMZ_REPORT_META 围栏或 JSON。不要臆造条数或金额。",
      "若本段有可引用弹幕，最多用两行「原文：」开头，抄录完整单行（须逐字来自下文摘录）。",
      "---",
      chunkText,
    ].join("\n");
    const summary = await chatAiAgentAccumulateFirstAvailable(modelCandidates, [
      {
        role: "system",
        content:
          "你是直播弹幕分析助手，只输出要点列表。不要 Markdown 标题、不要粗体。不要输出任何 JSON 或围栏标记。",
      },
      { role: "user", content: user },
    ]);
    const block = String(summary || "").trim();
    parts.push(`【分段 ${i + 1}/${total}】\n${block || "（本段未产出要点）"}`);
    console.log(`[ai-report] 分段预摘要 ${i + 1}/${total}，返回 ${block.length} 字`);
  }
  return parts.join("\n\n");
}

function buildAiExportPayload(roomId, rangeKey, maxDm, maxG, inclDm, inclG) {
  const resolved = resolveAiExportRange(rangeKey);
  if (!resolved) return { ok: false, error: "invalid_range" };
  const { startTs, endTs, label } = resolved;
  const dm = inclDm ? collectDanmakuLinesInRange(roomId, startTs, endTs, maxDm) : { lines: [], totalMatched: 0, truncated: false };
  const gif = inclG ? collectGiftLinesInRange(roomId, startTs, endTs, maxG) : { lines: [], totalMatched: 0, truncated: false };
  const danmakuText = inclDm
    ? (dm.lines.length ? dm.lines.join("\n") : "(该时间范围内无录制弹幕；请确认后台已开启录制并有历史 jsonl。)")
    : "(本次导出未包含弹幕。)";
  const giftText = inclG
    ? (gif.lines.length ? gif.lines.join("\n") : "(该时间范围内无礼物归档记录；礼物需在连接直播间时由服务器存档。)")
    : "(本次导出未包含礼物。)";
  return {
    ok: true,
    roomId,
    range: rangeKey,
    rangeLabel: label,
    startTs,
    endTs,
    includeDanmaku: inclDm,
    includeGifts: inclG,
    danmakuMatched: dm.totalMatched,
    danmakuIncluded: dm.lines.length,
    danmakuTruncated: dm.truncated,
    giftMatched: gif.totalMatched,
    giftIncluded: gif.lines.length,
    giftTruncated: gif.truncated,
    danmakuText,
    giftText,
    danmakuLines: inclDm ? dm.lines : [],
    giftLines: inclG ? gif.lines : [],
  };
}

function loadAiReportsStore() {
  try {
    if (existsSync(AI_REPORTS_FILE)) {
      const j = JSON.parse(readFileSync(AI_REPORTS_FILE, "utf-8"));
      if (j && Array.isArray(j.entries)) return j;
    }
  } catch { /* ignore */ }
  return { entries: [] };
}

function saveAiReportsStore(store) {
  writeFileSync(AI_REPORTS_FILE, JSON.stringify(store, null, 2), "utf-8");
}

function appendAiReportEntry(entry) {
  const store = loadAiReportsStore();
  store.entries.unshift(entry);
  if (store.entries.length > MAX_AI_REPORT_ENTRIES) store.entries.length = MAX_AI_REPORT_ENTRIES;
  saveAiReportsStore(store);
}

/** 软隐藏：不落库删除，仅标记 hidden；列表 GET 不返回
 * @returns {"ok"|"not_found"|"persist_failed"}
 */
function hideAiReportEntry(roomId, entryId) {
  const store = loadAiReportsStore();
  const rid = String(roomId);
  const eid = String(entryId);
  const entry = store.entries.find((e) => String(e.roomId) === rid && String(e.id) === eid);
  if (!entry) return "not_found";
  if (entry.hidden) return "ok";
  entry.hidden = true;
  try {
    saveAiReportsStore(store);
    return "ok";
  } catch (e) {
    entry.hidden = false;
    console.error("[ai-reports] hide save failed:", e);
    return "persist_failed";
  }
}

async function chatAiAgentAccumulate(modelId, messages) {
  const res = await fetch(`${AI_AGENT_INTERNAL_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ modelId, messages }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`AI agent HTTP ${res.status}: ${t.slice(0, 500)}`);
  }
  const reader = res.body?.getReader?.();
  if (!reader) throw new Error("AI agent 无响应体");
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) text += delta;
        } catch { /* skip */ }
      }
    }
  } catch (e) {
    const raw = e && e.message ? String(e.message) : String(e);
    if (/\bterminated\b|network error|aborted/i.test(raw)) {
      throw new Error(
        `${raw} — 流式响应中途断开：常见于刚执行 systemctl restart（弹幕/AI 服务重启）、`
          + "上游 API 断连或节点杀连接；可稍后重试日报；持久失败请查 journalctl -u fmz-danmaku -u fmz-ai-agent。",
      );
    }
    throw e;
  }
  return text;
}

/** 去掉模型偶发的 Markdown 符号，正文按纯文本排版展示 */
function sanitizeAiReportBodyPlain(text) {
  let s = String(text ?? "").replace(/\r\n/g, "\n");
  s = s.replace(/<\/?(?:b|strong)\b[^>]*>/gi, "");
  let prev;
  do {
    prev = s;
    s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  } while (s !== prev);
  s = s.replace(/\*{2,}/g, "");
  /* 保留行首 #～###：前端 parseAiReportBody 依赖此识别小节标题 */
  return s.trimEnd();
}

function normalizeAiPersistOverviewHeading(line) {
  return String(line || "")
    .trim()
    .replace(/^#{1,3}\s+/, "")
    .replace(/^【\s*/, "")
    .replace(/\s*】\s*$/, "")
    .replace(/\s+/g, "");
}

function isPersistAiDataOverviewSectionTitle(line) {
  const compact = normalizeAiPersistOverviewHeading(line).replace(/\s+/g, "");
  if (/^【数据概览】/.test(compact)) return true;
  return /^(?:一、)?数据概览/.test(compact);
}

function looksPersistAiTelemetryOverviewLine(ln) {
  const s = ln.trim();
  if (!s || s.length > 96) return false;
  if (/^(周期|统计周期)\s+\S*\d/.test(s)) return true;
  if (/^日期\s+\S*\d/.test(s)) return true;
  if (/^(日期（统计区间）|日期)\s*[｜|]\s*\S/.test(s)) return true;
  if (/^(主播|房间号)\s*[｜|]\s*\S/.test(s)) return true;
  if (/^弹幕数/.test(s)) return true;
  if (/^弹幕人数/.test(s)) return true;
  if (/^收入（主播收入）/.test(s)) return true;
  if (/^主播收入\s*[｜|]\s*\S/.test(s)) return true;
  if (/^主播收入\s+\S*\d/.test(s)) return true;
  if (/^收入\s*[｜|]\s*\S/.test(s)) return true;
  if (/^付费数/.test(s)) return true;
  if (/^花费/.test(s)) return true;
  if (/^付费人数/.test(s)) return true;
  if (/^送礼人数/.test(s)) return true;
  if (/^礼物人数/.test(s)) return true;
  if (/^(房间|直播间)\s+\d/.test(s)) return true;
  if (/^弹幕\s*[｜|]\s*.+\d/.test(s)) return true;
  if (/^礼物\s*[｜|]\s*.+\d/.test(s)) return true;
  if (/^付费\S*\s+\d/.test(s)) return true;
  if (/^口径说明/.test(s)) return true;
  return false;
}

/** 去掉模型写在文首的「数据概览」电报块（仪表盘卡片已展示） */
function stripLeadingAiWrittenDataOverviewPlain(bodyPlain) {
  const raw = String(bodyPlain ?? "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i >= lines.length) return "";

  if (isPersistAiDataOverviewSectionTitle(lines[i])) {
    i++;
    while (i < lines.length && !lines[i].trim()) i++;
    while (i < lines.length && looksPersistAiTelemetryOverviewLine(lines[i])) i++;
    while (i < lines.length && !lines[i].trim()) i++;
    while (i < lines.length && /^口径说明/.test(lines[i].trim())) {
      i++;
      while (i < lines.length && !lines[i].trim()) i++;
    }
    return lines.slice(i).join("\n").trimStart();
  }

  let j = i;
  while (j < lines.length && looksPersistAiTelemetryOverviewLine(lines[j])) j++;
  if (j > i) {
    while (j < lines.length && !lines[j].trim()) j++;
    return lines.slice(j).join("\n").trimStart();
  }

  return raw.trim();
}

const FMZ_REPORT_META_START = "<<<FMZ_REPORT_META";
const FMZ_REPORT_META_END = ">>>";

/** 剥离 AI 末尾围栏 JSON；正文不含围栏内容 */
function stripFmzReportMeta(raw) {
  const s = String(raw ?? "");
  const i = s.lastIndexOf(FMZ_REPORT_META_START);
  if (i < 0) return { content: s.trimEnd(), metaRaw: null };
  const j = s.indexOf(FMZ_REPORT_META_END, i + FMZ_REPORT_META_START.length);
  if (j < 0) return { content: s.trimEnd(), metaRaw: null };
  const jsonStr = s.slice(i + FMZ_REPORT_META_START.length, j).trim();
  const tail = s.slice(j + FMZ_REPORT_META_END.length).trim();
  const head = s.slice(0, i).trimEnd();
  const content = tail ? `${head}\n\n${tail}`.trim() : head;
  let metaRaw = null;
  try {
    metaRaw = JSON.parse(jsonStr);
  } catch {
    try {
      metaRaw = JSON.parse(jsonStr.replace(/\r/g, "").replace(/\n/g, " "));
    } catch {
      metaRaw = null;
    }
  }
  return { content, metaRaw };
}

/** @returns {{ mentalityScore: number, bestDanmakuQuote: string, bestDanmakuReason: string, mentalityRubric: string } | null} */
function normalizeAiReportMeta(metaRaw) {
  if (!metaRaw || typeof metaRaw !== "object") return null;
  let ms = Number(metaRaw.mentalityScore);
  if (!Number.isFinite(ms)) return null;
  ms = Math.min(100, Math.max(-100, Math.round(ms)));
  const bd = metaRaw.bestDanmaku && typeof metaRaw.bestDanmaku === "object" ? metaRaw.bestDanmaku : {};
  return {
    mentalityScore: ms,
    bestDanmakuQuote: sanitizeAiReportBodyPlain(String(bd.quote || "")).trim().slice(0, 280),
    bestDanmakuReason: sanitizeAiReportBodyPlain(String(bd.reason || "")).trim().slice(0, 280),
    mentalityRubric: sanitizeAiReportBodyPlain(String(metaRaw.mentalityRubric || "")).trim().slice(0, 320),
  };
}

async function runAiReportJob(roomId, kind, triggerId, triggeredBy) {
  const rangeKey = kind === "daily" ? "prev_calendar_day" : "prev_calendar_week";
  const exp = buildAiExportPayload(roomId, rangeKey, 8000, 2500, true, true);
  if (!exp.ok) throw new Error("导出范围无效");

  const info = await fetchRoomInfo(roomId);
  const roomDisplay = info?.owner_name ? `${info.owner_name} #${roomId}` : `#${roomId}`;

  let catalogMap = null;
  try {
    const pack = await fetchGiftListPayload(roomId);
    catalogMap = pack && pack.gifts ? pack.gifts : null;
  } catch {
    /* catalog 失败仍可仅用归档摘要 */
  }
  const giftRankDigest = formatGiftRankDigestForAi(roomId, exp.startTs, exp.endTs, catalogMap);

  const dmLines = exp.danmakuLines || [];
  const modelCandidates = await resolveAiAgentTriggerModelCandidates();

  /** 上下文/体积过大时递减并重试的入参（首次为与环境变量一致的默认） */
  let reportEff = {
    chunkDmLines: AI_REPORT_CHUNK_DM_LINES,
    chunkForceChars: AI_REPORT_CHUNK_FORCE_CHARS,
    dailyForceChunkTextChars: AI_REPORT_DAILY_FORCE_CHUNK_TEXT_CHARS,
    dailyForceMinParts: AI_REPORT_DAILY_FORCE_MIN_PARTS,
    maxGiftLines: AI_REPORT_MAX_GIFT_LINES_IN_PROMPT,
    verbatimSample: AI_REPORT_VERBATIM_DM_SAMPLE,
  };

  const dailyIntro =
    "生成本直播间「日报」：数据统计范围为「上一个完整自然日」（服务器本地日历：当日 0:00 起至次日 0:00 止）内的弹幕与礼物摘录与心态侧写，写短写实。";
  const weeklyIntro =
    "生成本直播间「周报」：数据统计范围为「上一个完整自然周」（周一至周日，服务器本地日历）内的弹幕与礼物摘录与心态侧写，写短写实。";
  const bothInstr = `依据下列「弹幕」「礼物」摘录与「礼物排行与礼物类型摘要」，写简练结论即可（勿复述题干）：弹幕焦点与情绪节奏；有无明显刷屏或节奏突变；礼物概况；结合摘要点名高频礼物、活跃用户与付费礼/免费礼大致格局（勿捏造外链）；数据不足处一句话交代。
评选一条最佳弹幕：摘自摘录原文，加中文引号，附一句理由。`;
  const proseStyle =
    "【篇幅与版面】全文求精简；正文为「宋体式」正文排印，禁止使用粗体视觉效果：不要使用 HTML 的 b/strong 标签，不要依赖加黑来强调。语气平实，少用感叹。禁止 Markdown（星号、井号标题、代码围栏）；小节标题用「一、」「二、」或单行标题即可。段间空一行；少用 emoji。不要用单独成行的大标题复述「斗鱼直播间日报/周报」或仅「日报/周报」二字（客户端已有版式）。**正文勿写「数据概览」**（仪表盘卡片已承载）；请从定性「概要信息」起笔（可用「一、概要信息」），3～6 句综述氛围、互动与礼物侧印象、冷场或爆点，可一句话交代样本/摘录局限。";
  const mentality =
    "【主播心态】据弹幕氛围（攻击性、负面情绪比例、支持与玩笑）、礼物互动是否缓和节奏等作简短阅卷式判断；须有摘录依据。写明整数 mentalityScore，范围 −100～+100（0 中性；负偏压抑或被围攻感；正偏有支撑）。禁止臆造。";
  const statsFirst =
    "【输出格式】勿写「数据概览」。正文从「概要信息」写起，其后为弹幕观察、礼物与排行解读、主播心态（整数分 + 短批）、结语等；勿输出与仪表盘同构的电报数字清单。";
  const structure =
    "建议顺序：概要信息 → 弹幕与互动 → 礼物与排行 → 主播心态 → 结语；可合并删减后段，概要信息勿省。";
  const fmzMetaFence = `【机器可读围栏 — 必须在全文最后输出】正文与小节全部写完后，单独换行输出围栏块；围栏外不要再追加其它说明文字：
<<<FMZ_REPORT_META
{"mentalityScore":0,"bestDanmaku":{"quote":"最佳弹幕原文摘录","reason":"一句评选理由"},"mentalityRubric":"一两句阅卷批语即可：弹幕氛围与谩骂/礼物等对加减分的依据"}
>>>
其中 mentalityScore 必须与正文「主播心态」小节所写的整数一致，范围为 -100～+100；quote/reason 与正文最佳弹幕一致；JSON 须合法（字符串内的换行请转义为 \\n）。`;

  const intro = kind === "daily" ? dailyIntro : weeklyIntro;
  const task = `${intro}\n\n${proseStyle}\n\n${bothInstr}\n\n${mentality}\n\n${statsFirst}\n\n${structure}\n\n${fmzMetaFence}`;
  const rankBlock = `--- 礼物排行与礼物类型摘要（本地归档 + catalog） ---\n${giftRankDigest}`;
  const systemContent =
    kind === "daily"
      ? "你是斗鱼直播间数据分析师，写中文日报。篇幅紧凑；正文一律常规字重，禁止粗体（不要用 HTML b/strong）。仪表盘顶部已有「数据概览」；你从「概要信息」定性写起，勿自写数据概览或电报数字清单。禁止 Markdown。礼物解读引用消息内排行摘要。文末输出 <<<FMZ_REPORT_META ... >>>。"
      : "你是斗鱼直播间数据分析师，写中文周报。篇幅紧凑；正文一律常规字重，禁止粗体（不要用 HTML b/strong）。仪表盘顶部已有「数据概览」；你从「概要信息」定性写起，勿自写数据概览或电报数字清单。禁止 Markdown。礼物解读引用消息内排行摘要。文末输出 <<<FMZ_REPORT_META ... >>>。";

  /** 分段预摘要全文；终稿为空时用于兜底展示 */
  let finalMultipassChunkSummariesText = null;
  let finalUseMultiPass = false;
  let finalUserBlockLen = 0;
  /** @type {string | null} */
  let rawAiText = null;

  for (let attempt = 0; attempt < AI_REPORT_CONTEXT_RETRY_MAX; attempt++) {
    if (attempt > 0) {
      console.warn(
        `[ai-report] 因上下文/体积限制缩小参数并重试 ${attempt + 1}/${AI_REPORT_CONTEXT_RETRY_MAX}：`
          + `chunkDm=${reportEff.chunkDmLines} chunkForceChars=${reportEff.chunkForceChars} dailyForceChars=${reportEff.dailyForceChunkTextChars} `
          + `dailyMinParts=${reportEff.dailyForceMinParts} giftMax=${reportEff.maxGiftLines} verbatim=${reportEff.verbatimSample}`,
      );
    }

    const chunkOpts = {
      chunkDmLines: reportEff.chunkDmLines,
      chunkForceChars: reportEff.chunkForceChars,
      dailyForceChunkTextChars: reportEff.dailyForceChunkTextChars,
      dailyForceMinParts: reportEff.dailyForceMinParts,
    };
    const giftLimited = limitGiftLinesForAiPrompt(exp.giftLines || [], exp.giftText, reportEff.maxGiftLines);
    const lineChunks = computeDanmakuLineChunksMaybeForceDaily(dmLines, exp.danmakuText, {
      kind,
      giftTextLen: giftLimited.text.length,
    }, chunkOpts);
    const useMultiPass = lineChunks.length > 1;

    /** @type {string|null} */
    let multipassChunkSummariesText = null;

    /** @type {string} */
    let danmakuExcerptBlock;
    /** @type {string|null} */
    let multiPassNote = null;
    if (useMultiPass) {
      console.log(
        `[ai-report] 分段预摘要: ${lineChunks.length} 段, 弹幕 ${dmLines.length} 行, 礼物入模 ${giftLimited.included} 行 （尝试 ${attempt + 1}/${AI_REPORT_CONTEXT_RETRY_MAX}）`,
      );
      multipassChunkSummariesText = await summarizeDanmakuChunksForFinalReport(
        modelCandidates,
        roomDisplay,
        exp.rangeLabel,
        lineChunks,
      );
      const verbatim = sampleLinesEvenly(dmLines, reportEff.verbatimSample).join("\n");
      danmakuExcerptBlock =
        `--- 弹幕：分段要点（模型预读 ${lineChunks.length} 段）---\n${multipassChunkSummariesText}`
        + `\n\n--- 弹幕：原文均匀抽样（供引用，勿改行内正文）---\n${verbatim}`;
      multiPassNote =
        `弹幕成文｜体量较大，已分 ${lineChunks.length} 段预摘要，并均匀抽样 ${Math.min(dmLines.length, reportEff.verbatimSample)} 条原文行供引用；评选「最佳弹幕」须逐字来自本消息内的原文抽样或分段要点中的「原文：」行，禁止编造。`;
    } else {
      danmakuExcerptBlock = `--- 弹幕摘录 ---\n${exp.danmakuText}`;
    }

    const giftPromptNote = giftLimited.truncated
      ? `礼物摘录｜窗口内匹配 ${exp.giftMatched} 条，为控制上下文已均匀抽样 ${giftLimited.included} 条进入下文（排行摘要仍完整）。`
      : null;

    const dataInfoLines = [
      "【数据信息】以下为导出窗口与抽样口径（仅供定性参考）。**客户端仪表盘顶部已展示结构化「数据概览」**；正文勿写「数据概览」小节或电报数字清单（勿列周期、房间、条数、付费笔数等）。下列数字行仅供理解样本规模，正文请从「概要信息」起笔。",
      `周期｜${exp.rangeLabel}`,
      `房间｜${roomDisplay}｜${roomId}`,
      `弹幕归档｜窗口内录制 chatmsg 共匹配 ${exp.danmakuMatched} 条｜下文至多摘录 ${exp.danmakuIncluded} 条｜截断 ${exp.danmakuTruncated ? "是" : "否"}`,
      multiPassNote,
      giftPromptNote,
      `礼物归档｜窗口内匹配 ${exp.giftMatched} 条｜下文至多摘录 ${exp.giftIncluded} 条｜截断 ${exp.giftTruncated ? "是" : "否"}`,
      "另有「礼物排行与礼物类型摘要」须在后续小节引用解读；勿冒充外链实时榜。",
    ].filter(Boolean);
    const dataInfo = dataInfoLines.join("\n");
    const excerpts = `${danmakuExcerptBlock}\n\n--- 礼物摘录 ---\n${giftLimited.text}`;
    const userBlock = `${dataInfo}\n\n${rankBlock}\n\n【分析任务】\n${task}\n\n${excerpts}`;

    console.log(
      `[ai-report] ${kind} room=${roomId} multipass=${useMultiPass} userBlock≈${userBlock.length} 字 attempt=${attempt + 1}/${AI_REPORT_CONTEXT_RETRY_MAX}`,
    );

    try {
      rawAiText = await chatAiAgentAccumulateFirstAvailable(modelCandidates, [
        { role: "system", content: systemContent },
        { role: "user", content: userBlock },
      ]);
      finalUseMultiPass = useMultiPass;
      finalMultipassChunkSummariesText = multipassChunkSummariesText;
      finalUserBlockLen = userBlock.length;
      console.log(
        `[ai-report] rawOutLen=${String(rawAiText || "").length} attempt=${attempt + 1}`,
      );
      break;
    } catch (e) {
      const errMsg = e && e.message ? String(e.message) : String(e);
      const canRetry = isLikelyContextLengthExceededError(errMsg) && attempt < AI_REPORT_CONTEXT_RETRY_MAX - 1;
      if (!canRetry) throw e;
      console.warn(`[ai-report] 判定为上下文/体积限制（将收窄分块后重试）: ${errMsg.slice(0, 360)}`);
      reportEff.chunkDmLines = Math.max(200, Math.floor(reportEff.chunkDmLines / 2));
      reportEff.chunkForceChars = Math.max(50_000, Math.floor(reportEff.chunkForceChars / 1.38));
      reportEff.dailyForceChunkTextChars = Math.max(18_000, Math.floor(reportEff.dailyForceChunkTextChars / 1.38));
      reportEff.dailyForceMinParts = Math.min(8, reportEff.dailyForceMinParts + 1);
      reportEff.maxGiftLines = Math.max(80, Math.floor(reportEff.maxGiftLines / 2));
      reportEff.verbatimSample = Math.max(40, Math.floor(reportEff.verbatimSample / 2));
    }
  }

  if (rawAiText === null) {
    throw new Error(
      `AI 报告：已自动分块重试 ${AI_REPORT_CONTEXT_RETRY_MAX} 次仍失败；请手动调小 FMZ_AI_REPORT_CHUNK_DM_LINES / FMZ_AI_REPORT_MAX_GIFT_LINES，或调大 FMZ_AI_REPORT_CONTEXT_RETRY_MAX。`,
    );
  }
  const { content: bodyContent, metaRaw } = stripFmzReportMeta(rawAiText);
  const bodyPlain = sanitizeAiReportBodyPlain(bodyContent);
  const metaNorm = normalizeAiReportMeta(metaRaw);
  const avatarUrl = typeof info?.avatar === "string" ? info.avatar.trim() : "";

  let dailyOverview;
  let weeklyOverview;
  const dmStats = computeDanmakuStatsInRange(roomId, exp.startTs, exp.endTs);
  const fin = computeGiftFinancialStats(roomId, exp.startTs, exp.endTs, catalogMap);
  const overviewMetrics = {
    streamerName: typeof info?.owner_name === "string" ? info.owner_name.trim() : "",
    roomId: String(roomId),
    danmakuTotal: dmStats.total,
    danmakuUniqueUsers: dmStats.uniqueUsers,
    giftSenderCount: fin.giftSenderCount,
    paidUserCount: fin.paidUserCount,
    streamerIncomeApproxYuan: fin.streamerIncomeApproxYuan,
    audiencePaidApproxYuan: fin.audiencePaidApproxYuan,
  };
  if (kind === "daily") {
    dailyOverview = {
      ...overviewMetrics,
      dateYmd: fmtLocalYmd(exp.startTs),
      weekdayCn: weekdayCnLocal(exp.startTs),
    };
  } else if (kind === "weekly") {
    weeklyOverview = {
      ...overviewMetrics,
      rangeLabel: exp.rangeLabel,
    };
  }

  let strippedAi = stripLeadingAiWrittenDataOverviewPlain(bodyPlain);
  let persistedContent = strippedAi.trimEnd();
  if (!persistedContent && bodyPlain.trim()) {
    console.warn(
      `[ai-report] 去「数据概览」后正文为空，保留去围栏后原文（room=${roomId} ${kind}）；多为模型仅输出电报统计短行触发误判。`,
    );
    persistedContent = bodyPlain.trimEnd();
  }
  if (!persistedContent.trim()) {
    const rawStr = String(rawAiText || "");
    const rawLen = rawStr.length;
    const bodyAfterFenceLen = String(bodyContent ?? "").trim().length;
    const preview = rawStr.slice(0, 480).replace(/\s+/g, " ");
    const chunkFallback =
      finalUseMultiPass && finalMultipassChunkSummariesText && finalMultipassChunkSummariesText.trim();
    if (chunkFallback) {
      persistedContent = [
        "【说明】终稿模型未返回可读正文（热门房间常见：user 消息过长导致上游截断或空输出）。下方为分段预摘要的自动拼接，未经终稿润色；可略减小 FMZ_AI_REPORT_CHUNK_DM_LINES / FMZ_AI_REPORT_MAX_GIFT_LINES / FMZ_AI_REPORT_VERBATIM_DM_SAMPLE，或依赖服务端自动收窄重试（FMZ_AI_REPORT_CONTEXT_RETRY_MAX）。",
        "",
        finalMultipassChunkSummariesText.trim(),
      ].join("\n");
      console.warn(
        `[ai-report] empty final body; using chunk-summary fallback room=${roomId} ${kind} rawLen=${rawLen} bodyAfterFence=${bodyAfterFenceLen} userBlockLen=${finalUserBlockLen} chunkChars=${finalMultipassChunkSummariesText.length} preview=${preview}`,
      );
    } else {
      persistedContent = [
        "【说明】本次未生成可读正文。常见原因：上游返回为空或仅含围栏、上下文过大被截断、或网络中断。",
        "请稍后重试。若在热门直播间反复出现，可在服务器为 fmz-danmaku 调整环境变量：FMZ_AI_REPORT_MAX_GIFT_LINES、FMZ_AI_REPORT_DAILY_FORCE_CHUNK_CHARS、FMZ_AI_REPORT_CHUNK_DM_LINES、FMZ_AI_REPORT_VERBATIM_DM_SAMPLE、FMZ_AI_REPORT_CONTEXT_RETRY_MAX；并查看 fmz-ai-agent、fmz-danmaku 日志中的 [ai-report]。",
      ].join("\n");
      console.warn(
        `[ai-report] empty body after strip room=${roomId} ${kind} rawLen=${rawLen} bodyAfterFence=${bodyAfterFenceLen} userBlockLen=${finalUserBlockLen} multipass=${finalUseMultiPass} preview=${preview}`,
      );
    }
  }

  const createdAt = Date.now();
  const titleDate = new Date(createdAt).toLocaleString("zh-CN", { hour12: false });
  const id = `rpt_${createdAt}_${Math.random().toString(36).slice(2, 9)}`;
  const periodKey = buildAiReportPeriodKey(roomId, kind, exp.startTs, exp.endTs);
  const shadowed = hidePriorAiReportsForSameSlot(roomId, kind, periodKey, exp.rangeLabel);
  for (const x of shadowed) {
    broadcastToSSE("ai-report-deleted", x);
  }

  const entry = {
    id,
    roomId,
    kind,
    triggerId: triggerId || "",
    triggeredBy: triggeredBy || "",
    createdAt,
    periodKey,
    periodLabel: exp.rangeLabel,
    /** 标题突出：生成时间 + 直播间名（房间号）；日报/周报由 kind + 版头 kicker 承载 */
    title: `${titleDate} · ${roomDisplay}`,
    content: persistedContent,
    streamerAvatar: avatarUrl,
    ...(metaNorm || {}),
    ...(dailyOverview ? { dailyOverview } : {}),
    ...(weeklyOverview ? { weeklyOverview } : {}),
  };
  appendAiReportEntry(entry);
  broadcastToSSE("ai-report", { roomId, entry });
  console.log(
    `[ai-report] saved ${kind} room=${roomId} slot=${periodKey} chars=${persistedContent.length}${shadowed.length ? ` shadowed=${shadowed.length}` : ""}${metaNorm ? ` meta_score=${metaNorm.mentalityScore}` : ""}`,
  );
}

function queueAiReportJob(roomId, kind, triggerId, triggeredBy) {
  runAiReportJob(roomId, kind, triggerId, triggeredBy).catch((e) => {
    const rawMsg = e && e.message ? String(e.message) : String(e);
    const msg = humanizeAiReportFailure(rawMsg);
    console.warn(`[ai-report] ${roomId} ${kind} failed:`, rawMsg);
    try {
      const logEntry = {
        triggerId: triggerId || "",
        pattern: "",
        action: kind === "daily" ? "ai-daily-report" : "ai-weekly-report",
        content: `失败：${msg}`,
        nickname: "系统",
        uid: "0",
        fullText: `[ai-report] ${roomId} ${kind}: ${rawMsg}`,
        roomId,
        ts: Date.now(),
        summary: `[AI 报告失败] 触发「${triggerId || "?"}」· 房间 ${roomId} · ${kind === "daily" ? "日报" : "周报"} · ${msg}`,
      };
      actionLog.push(logEntry);
      if (actionLog.length > 500) actionLog = actionLog.slice(-500);
      saveActionLog(actionLog);
      broadcastToSSE("trigger", logEntry);
    } catch {
      /* ignore */
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Douyu STT protocol helpers                                        */
/* ------------------------------------------------------------------ */

function encodeDouyuPacket(payload, msgType = 689) {
  const payloadBuf = Buffer.from(payload + "\0", "utf-8");
  const headerLen = 4 + 2 + 1 + 1;
  const totalLen = headerLen + payloadBuf.length;
  const buf = Buffer.alloc(4 + totalLen);
  buf.writeUInt32LE(totalLen, 0);
  buf.writeUInt32LE(totalLen, 4);
  buf.writeUInt16LE(msgType, 8);
  buf.writeUInt8(0, 10);
  buf.writeUInt8(0, 11);
  payloadBuf.copy(buf, 12);
  return buf;
}

function decodeStt(raw) {
  if (!raw || typeof raw !== "string") return {};
  const result = {};
  for (const pair of raw.split("/")) {
    if (!pair) continue;
    const idx = pair.indexOf("@=");
    if (idx === -1) continue;
    result[pair.substring(0, idx)] = pair.substring(idx + 2).replace(/@S/g, "/").replace(/@A/g, "@");
  }
  return result;
}

function encodeStt(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}@=${v}`).join("/") + "/";
}

/* ------------------------------------------------------------------ */
/*  Multi-room backend connections                                    */
/* ------------------------------------------------------------------ */

/** @type {Map<string, RoomConnection>} */
const backendRooms = new Map();

/** Active SSE clients for backend mode */
const sseClients = new Set();

function broadcastToSSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

function handleDreamBusSessionMessage(roomId, msg) {
  if (!msg || msg.type !== "dream_bus_session") return;
  try {
    const result = ingestDreamBusSession(roomId, msg);
    broadcastToSSE("dream-bus", {
      live: result.live,
      record: result.record,
      roomId: String(roomId ?? "").trim(),
      ts: Date.now(),
    });
  } catch (e) {
    console.warn(`[danmaku] dream_bus_session ingest failed: ${e.message}`);
  }
}

function buildRoomsStatusPayload() {
  const rooms = [];
  for (const [rid, conn] of backendRooms) {
    rooms.push({
      roomId: rid,
      status: conn.status,
      stats: { total: conn.stats.total, triggered: conn.stats.triggered, connected_at: conn.stats.connected_at },
      recording: !!conn.recordFile,
      recordedCount: conn.recordedCount,
    });
  }
  return rooms;
}

function broadcastRoomsStatus() {
  broadcastToSSE("rooms", buildRoomsStatusPayload());
}

function processTriggers(danmaku, roomId) {
  const txt = danmaku.txt || "";
  for (const trigger of triggerConfig.triggers) {
    if (!trigger.enabled) continue;
    if (isScheduleTriggerNode(trigger)) continue;
    // Check room binding: if roomIds is set and non-empty, only match specified rooms
    if (trigger.roomIds && trigger.roomIds.length > 0 && !trigger.roomIds.includes(roomId)) continue;
    if (!txt.startsWith(trigger.pattern)) continue;
    const content = txt.substring(trigger.pattern.length).trim();
    const allowEmptyContent = trigger.action === "ai-daily-report" || trigger.action === "ai-weekly-report";
    if (!allowEmptyContent && !content) continue;
    const conn = backendRooms.get(roomId);
    if (conn) conn.stats.triggered++;
    const logContent = content || (allowEmptyContent ? "(触发)" : content);
    const logEntry = {
      triggerId: trigger.id,
      pattern: trigger.pattern,
      action: trigger.action,
      content: logContent,
      nickname: danmaku.nn,
      uid: danmaku.uid,
      fullText: txt,
      roomId,
      ts: Date.now(),
      summary: buildTriggerLogSummary({
        trigger,
        source: "danmaku",
        pattern: trigger.pattern,
        plainContent: logContent,
        nickname: danmaku.nn,
        roomId,
      }),
    };
    if (trigger.action === "log") console.log(`[danmaku-trigger] [${roomId}] ${danmaku.nn}: ${txt} → "${content}"`);
    actionLog.push(logEntry);
    if (actionLog.length > 500) actionLog = actionLog.slice(-500);
    saveActionLog(actionLog);
    broadcastToSSE("trigger", logEntry);

    // Dispatch action based on trigger type
    if (trigger.action === "song-request") {
      const songResult = recordSongRequest(roomId, content, danmaku);
      if (songResult) {
        broadcastToSSE("song-request", { roomId, ...songResult });
      }
    }
    if (trigger.action === "ai-daily-report") {
      queueAiReportJob(roomId, "daily", trigger.id, danmaku.nn || "弹幕");
    }
    if (trigger.action === "ai-weekly-report") {
      queueAiReportJob(roomId, "weekly", trigger.id, danmaku.nn || "弹幕");
    }
  }
}

function fireScheduledTrigger(trigger) {
  const payload = typeof trigger.payload === "string" ? trigger.payload : "";
  const contentTrim = payload.trim();
  const displayContent = contentTrim || "(空)";
  let rooms = trigger.roomIds && trigger.roomIds.length > 0
    ? trigger.roomIds.map((x) => String(x).trim()).filter(Boolean)
    : [...backendRooms.keys()];
  rooms = [...new Set(rooms)];

  const fakeDanmaku = {
    nn: "系统",
    uid: "0",
    txt: contentTrim ? `[定时] ${contentTrim}` : "[定时]",
    level: "",
    bnn: "",
    bl: "",
    brid: "",
    ic: "",
    photo: "",
    ts: Date.now(),
    type: "chatmsg",
  };

  if (rooms.length === 0) {
    const logEntry = {
      triggerId: trigger.id,
      pattern: "[定时]",
      action: trigger.action,
      content: displayContent,
      nickname: "系统",
      uid: "0",
      fullText: contentTrim ? `[定时] ${contentTrim}` : "[定时]",
      roomId: "",
      ts: Date.now(),
      source: "schedule",
      summary: buildTriggerLogSummary({
        trigger,
        source: "schedule",
        pattern: "[定时]",
        plainContent: contentTrim,
        nickname: "系统",
        roomId: "",
      }),
    };
    if (trigger.action === "log") console.log(`[danmaku-schedule] (无已连接房间) ${trigger.id}: ${contentTrim || "(无说明)"}`);
    actionLog.push(logEntry);
    if (actionLog.length > 500) actionLog = actionLog.slice(-500);
    saveActionLog(actionLog);
    broadcastToSSE("trigger", logEntry);
    return;
  }

  for (const roomId of rooms) {
    const logEntry = {
      triggerId: trigger.id,
      pattern: "[定时]",
      action: trigger.action,
      content: displayContent,
      nickname: "系统",
      uid: "0",
      fullText: contentTrim ? `[定时] ${contentTrim}` : "[定时]",
      roomId,
      ts: Date.now(),
      source: "schedule",
      summary: buildTriggerLogSummary({
        trigger,
        source: "schedule",
        pattern: "[定时]",
        plainContent: contentTrim,
        nickname: "系统",
        roomId,
      }),
    };
    if (trigger.action === "log") console.log(`[danmaku-schedule] [${roomId}] ${contentTrim || "(无说明)"}`);
    actionLog.push(logEntry);
    if (actionLog.length > 500) actionLog = actionLog.slice(-500);
    saveActionLog(actionLog);
    broadcastToSSE("trigger", logEntry);

    if (trigger.action === "song-request" && contentTrim) {
      try {
        const songResult = recordSongRequest(roomId, contentTrim, fakeDanmaku);
        if (songResult) broadcastToSSE("song-request", { roomId, ...songResult });
      } catch (e) {
        console.warn(`[danmaku-schedule] song-request failed:`, e.message);
      }
    }
    if (trigger.action === "ai-daily-report") {
      queueAiReportJob(roomId, "daily", trigger.id, "定时触发器");
    }
    if (trigger.action === "ai-weekly-report") {
      queueAiReportJob(roomId, "weekly", trigger.id, "定时触发器");
    }
  }
}

function tickScheduledTriggers() {
  const nowMs = Date.now();
  const nowDate = new Date(nowMs);
  for (const t of triggerConfig.triggers) {
    if (!t.enabled || !isScheduleTriggerNode(t)) continue;
    try {
      if (!shouldFireScheduledTrigger(t, nowDate, nowMs)) continue;
      fireScheduledTrigger(t);
      markScheduleFired(t, nowDate, nowMs);
    } catch (e) {
      console.warn(`[danmaku-schedule] tick error ${t.id}:`, e.message);
    }
  }
}

function connectBackendRoom(roomId) {
  roomId = String(roomId).trim();
  if (!roomId || backendRooms.has(roomId)) return;

  const conn = {
    roomId,
    status: "connecting",
    socket: null,
    heartbeatTimer: null,
    reconnectTimer: null,
    recvBuffer: Buffer.alloc(0),
    stats: { total: 0, triggered: 0, connected_at: null },
    recordFile: null,
    recordedCount: 0,
    rawRecordFile: null,
    rawRecordedCount: 0,
    wantConnected: true, // flag to control auto-reconnect
  };
  backendRooms.set(roomId, conn);
  saveRoomsList();
  broadcastRoomsStatus();

  function processMessage(payload) {
    const msg = decodeStt(payload);
    if (!msg.type) return;
    if (DREAM_BUS_ONLY) {
      if (msg.type === "dream_bus_session") handleDreamBusSessionMessage(roomId, msg);
      return;
    }
    // Raw recording: capture ALL messages for offline analysis
    if (conn.rawRecordFile) {
      try {
        const rawEntry = { ...msg, _roomId: roomId, _ts: Date.now() };
        appendFileSync(conn.rawRecordFile, JSON.stringify(rawEntry) + "\n", "utf-8");
        conn.rawRecordedCount = (conn.rawRecordedCount || 0) + 1;
      } catch { /* ignore */ }
    }
    if (msg.type === "chatmsg") {
      const danmaku = buildChatmsgDanmaku(msg);
      conn.stats.total++;
      broadcastToSSE("danmaku", { ...danmaku, roomId });
      recordDanmakuForRoom(conn, danmaku);
      processTriggers(danmaku, roomId);
    }
    const giftNorm = normalizeDouyuGiftSttToRecord(roomId, msg);
    if (giftNorm) {
      const giftEntry = recordGift(roomId, giftNorm);
      broadcastToSSE("gift", giftEntry);
    }
    if (msg.type === "uenter") broadcastToSSE("enter", { type: "uenter", uid: msg.uid || "", nn: msg.nn || "", roomId, ts: Date.now() });
    if (msg.type === "dream_bus_session") handleDreamBusSessionMessage(roomId, msg);
  }

  function onData(chunk) {
    conn.recvBuffer = Buffer.concat([conn.recvBuffer, chunk]);
    while (conn.recvBuffer.length >= 12) {
      const packetLen = conn.recvBuffer.readUInt32LE(0);
      const totalLen = packetLen + 4;
      if (conn.recvBuffer.length < totalLen) break;
      let payload = conn.recvBuffer.subarray(12, totalLen).toString("utf-8");
      if (payload.endsWith("\0")) payload = payload.slice(0, -1);
      conn.recvBuffer = conn.recvBuffer.subarray(totalLen);
      try { processMessage(payload); } catch (err) { console.error(`[danmaku] [${roomId}] Error:`, err.message); }
    }
  }

  function doConnect() {
    conn.status = "connecting";
    conn.recvBuffer = Buffer.alloc(0);
    broadcastRoomsStatus();
    console.log(`[danmaku] Connecting to room ${roomId}...`);

    const socket = net.createConnection({ host: "danmuproxy.douyu.com", port: 8601 });

    socket.on("connect", () => {
      console.log(`[danmaku] Connected to room ${roomId}`);
      socket.write(encodeDouyuPacket(encodeStt({ type: "loginreq", room_id: roomId, dfl: "", username: "", uid: "", ver: "20190610", aver: "218101901", ct: "0" })));
      socket.write(encodeDouyuPacket(encodeStt({ type: "joingroup", rid: roomId, gid: "-9999" })));
      conn.status = "connected";
      conn.stats.connected_at = Date.now();
      conn.heartbeatTimer = setInterval(() => { if (socket && !socket.destroyed) socket.write(encodeDouyuPacket(encodeStt({ type: "mrkl" }))); }, 45_000);
      startRecordingForRoom(conn);
      broadcastRoomsStatus();
    });

    socket.on("data", onData);

    socket.on("error", (err) => {
      console.error(`[danmaku] [${roomId}] Socket error: ${err.message}`);
      conn.status = "disconnected";
      broadcastRoomsStatus();
    });

    socket.on("close", () => {
      console.log(`[danmaku] [${roomId}] Socket closed`);
      if (conn.heartbeatTimer) { clearInterval(conn.heartbeatTimer); conn.heartbeatTimer = null; }
      stopRecordingForRoom(conn);
      conn.socket = null;
      conn.status = "disconnected";
      broadcastRoomsStatus();
      if (conn.wantConnected) {
        console.log(`[danmaku] [${roomId}] Will reconnect in 5s...`);
        conn.reconnectTimer = setTimeout(() => { if (conn.wantConnected && backendRooms.has(roomId)) doConnect(); }, 5000);
      }
    });

    conn.socket = socket;
  }

  doConnect();
}

function disconnectBackendRoom(roomId) {
  const conn = backendRooms.get(roomId);
  if (!conn) return;
  conn.wantConnected = false;
  if (conn.heartbeatTimer) { clearInterval(conn.heartbeatTimer); conn.heartbeatTimer = null; }
  if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = null; }
  stopRecordingForRoom(conn);
  if (conn.socket) { conn.socket.destroy(); conn.socket = null; }
  backendRooms.delete(roomId);
  saveRoomsList();
  broadcastRoomsStatus();
  console.log(`[danmaku] Removed room ${roomId}`);
}

/* ------------------------------------------------------------------ */
/*  Web capture — per-client TCP connections                          */
/* ------------------------------------------------------------------ */

function createWebCaptureConnection(roomId, sseRes) {
  const ctx = { roomId, sseRes, socket: null, heartbeatTimer: null, recvBuffer: Buffer.alloc(0), stats: { total: 0, triggered: 0 }, destroyed: false };

  function sendSSE(event, data) { if (ctx.destroyed) return; try { sseRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ } }

  function processMessage(payload) {
    const msg = decodeStt(payload);
    if (!msg.type) return;
    if (msg.type === "chatmsg") {
      const danmaku = buildChatmsgDanmaku(msg);
      ctx.stats.total++;
      sendSSE("danmaku", danmaku);
      const txt = danmaku.txt || "";
      for (const trigger of triggerConfig.triggers) {
        if (!trigger.enabled || isScheduleTriggerNode(trigger) || !txt.startsWith(trigger.pattern)) continue;
        const content = txt.substring(trigger.pattern.length).trim();
        if (!content) continue;
        ctx.stats.triggered++;
        const logEntry = {
          triggerId: trigger.id,
          pattern: trigger.pattern,
          action: trigger.action,
          content,
          nickname: danmaku.nn,
          uid: danmaku.uid,
          fullText: txt,
          roomId: ctx.roomId,
          ts: Date.now(),
          source: "web",
          summary: buildTriggerLogSummary({
            trigger,
            source: "web",
            pattern: trigger.pattern,
            plainContent: content,
            nickname: danmaku.nn,
            roomId: ctx.roomId,
          }),
        };
        if (trigger.action === "log") console.log(`[danmaku-web-trigger] ${danmaku.nn}: ${txt} → "${content}"`);
        actionLog.push(logEntry);
        if (actionLog.length > 500) actionLog = actionLog.slice(-500);
        saveActionLog(actionLog);
        sendSSE("trigger", logEntry);
      }
    }
    const giftNorm = normalizeDouyuGiftSttToRecord(ctx.roomId, msg);
    if (giftNorm) {
      const giftEntry = recordGift(ctx.roomId, giftNorm);
      sendSSE("gift", giftEntry);
    }
    if (msg.type === "dream_bus_session") handleDreamBusSessionMessage(ctx.roomId, msg);
  }

  function onData(chunk) {
    ctx.recvBuffer = Buffer.concat([ctx.recvBuffer, chunk]);
    while (ctx.recvBuffer.length >= 12) {
      const packetLen = ctx.recvBuffer.readUInt32LE(0);
      const totalLen = packetLen + 4;
      if (ctx.recvBuffer.length < totalLen) break;
      let payload = ctx.recvBuffer.subarray(12, totalLen).toString("utf-8");
      if (payload.endsWith("\0")) payload = payload.slice(0, -1);
      ctx.recvBuffer = ctx.recvBuffer.subarray(totalLen);
      try { processMessage(payload); } catch { /* ignore */ }
    }
  }

  sendSSE("status", { status: "connecting", roomId });
  const socket = net.createConnection({ host: "danmuproxy.douyu.com", port: 8601 });
  socket.on("connect", () => {
    socket.write(encodeDouyuPacket(encodeStt({ type: "loginreq", room_id: roomId, dfl: "", username: "", uid: "", ver: "20190610", aver: "218101901", ct: "0" })));
    socket.write(encodeDouyuPacket(encodeStt({ type: "joingroup", rid: roomId, gid: "-9999" })));
    ctx.heartbeatTimer = setInterval(() => { if (socket && !socket.destroyed) socket.write(encodeDouyuPacket(encodeStt({ type: "mrkl" }))); }, 45_000);
    sendSSE("status", { status: "connected", roomId, stats: ctx.stats });
  });
  socket.on("data", onData);
  socket.on("error", (err) => { sendSSE("status", { status: "error", roomId, error: err.message }); });
  socket.on("close", () => { if (ctx.heartbeatTimer) { clearInterval(ctx.heartbeatTimer); ctx.heartbeatTimer = null; } if (!ctx.destroyed) sendSSE("status", { status: "disconnected", roomId }); });
  ctx.socket = socket;
  return ctx;
}

function destroyWebCaptureConnection(ctx) {
  if (ctx.destroyed) return;
  ctx.destroyed = true;
  if (ctx.heartbeatTimer) { clearInterval(ctx.heartbeatTimer); ctx.heartbeatTimer = null; }
  if (ctx.socket) { ctx.socket.destroy(); ctx.socket = null; }
  ctx.recvBuffer = Buffer.alloc(0);
}

/* ------------------------------------------------------------------ */
/*  HTTP server                                                       */
/* ------------------------------------------------------------------ */

function jsonReply(res, data, status = 200, extraHeaders = null) {
  /** @type {Record<string, string>} */
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Password",
    ...(extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {}),
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

/**
 * /gifts/:rid/stats 的 range 参数归一（斗鱼观众口径常用北京时间自然日）
 * @param {string|null|undefined} raw
 */
function normalizeGiftStatsRangeParam(raw) {
  if (raw == null) return "today";
  let s = String(raw).trim().normalize("NFKC");
  s = s.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, "").trim();
  const lower = s.toLowerCase();
  if (lower === "undefined" || lower === "null" || lower === "[object object]") return "today";
  const ascii = lower.replace(/[^\x20-\x7e]/g, "");
  if (
    s === "昨日" ||
    s === "昨天" ||
    lower === "yesterday" ||
    /^yesterday\b/i.test(ascii) ||
    lower === "prev_day" ||
    lower === "prev-day"
  ) {
    return "yesterday";
  }
  if (s === "今日" || s === "今天" || lower === "today" || /^today\b/i.test(ascii)) return "today";
  if (s === "本周" || lower === "week" || /^week\b/i.test(ascii)) return "week";
  if (s === "本月" || lower === "month" || /^month\b/i.test(ascii)) return "month";
  if (s === "近7天" || s === "7天" || lower === "7days" || /^7days\b/i.test(ascii)) return "7days";
  if (s === "近30天" || s === "30天" || lower === "30days" || /^30days\b/i.test(ascii)) return "30days";
  return lower;
}

/** 取 URL 中声明的统计 range（便于排查重复 query / 别名参数） */
function pickGiftStatsRangeQueryRaw(url) {
  const keyOrder = ["range", "window", "giftRange"];
  for (const k of keyOrder) {
    const all = url.searchParams.getAll(k);
    if (!all.length) continue;
    for (let i = all.length - 1; i >= 0; i--) {
      const s = String(all[i] ?? "").trim();
      if (s) return s;
    }
  }
  return "";
}

/** 86400000；上海无夏令时，自然日与固定 24h 对齐 */
const GIFT_STATS_MS_PER_DAY = 86400000;

/**
 * 锚点时刻在上海时区下的日历日与「今日 0 点」「明日 0 点」「本月 1 日 0 点」
 * 使用 en-CA 得稳定 YYYY-MM-DD，避免人工拼 parts 遗漏
 * @param {number} anchorMs
 * @returns {{ y: number, mo: number, d: number, ymdStr: string, todayStart: number, nextDayStart: number, monthStart: number } | null}
 */
function shanghaiGiftStatsDayAnchors(anchorMs) {
  const raw = Number(anchorMs);
  const a = Number.isFinite(raw) ? raw : Date.now();
  const dt = new Date(a);
  if (Number.isNaN(dt.getTime())) return null;
  const ymdStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dt);
  const segs = ymdStr.split("-");
  if (segs.length !== 3) return null;
  const [ys, mos, ds] = segs;
  const y = Number(ys);
  const mo = Number(mos);
  const d = Number(ds);
  if (![y, mo, d].every((n) => Number.isFinite(n))) return null;

  const todayStart = Date.parse(`${ymdStr}T00:00:00+08:00`);
  if (!Number.isFinite(todayStart)) return null;

  const monthYmd = `${ys}-${mos}-01`;
  const monthStart = Date.parse(`${monthYmd}T00:00:00+08:00`);
  if (!Number.isFinite(monthStart)) return null;

  const nextDayStart = todayStart + GIFT_STATS_MS_PER_DAY;
  return { y, mo, d, ymdStr, todayStart, nextDayStart, monthStart };
}

/** 与本地 Date#getDay() 一致：0=周日 … 6=周六；按 Asia/Shanghai */
function shanghaiGetDaySun0(ms) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "long" }).formatToParts(new Date(ms));
  const long = parts.find((p) => p.type === "weekday")?.value ?? "";
  /** @type {Record<string, number>} */
  const map = {
    Sunday: 0,
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
  };
  return map[long] ?? 0;
}

/**
 * 统计时间窗：除 yesterday 外均无 endTs（仅下界）；yesterday 为 [昨日00:00, 今日00:00)（上海时区）
 * 锚点经 en-CA+Shanghai 解析，保证 todayStart / yesterday 的 end 为合法上海日界；返回毫秒为整数。
 * @returns {{ startTs: number, endTs?: number }}
 */
function computeGiftStatsTimeWindow(rangeCanon, nowMs = Date.now()) {
  const fmt = (ms) =>
    Number.isFinite(ms)
      ? new Date(ms).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
          hour12: false,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : "(invalid)";

  let ax = shanghaiGiftStatsDayAnchors(nowMs);
  if (!ax) {
    console.warn(`[danmaku] computeGiftStatsTimeWindow: 无效 nowMs=${JSON.stringify(nowMs)}，改用 Date.now()`);
    ax = shanghaiGiftStatsDayAnchors(Date.now());
  }
  if (!ax) {
    console.error("[danmaku] computeGiftStatsTimeWindow: 第二次仍无法解析 Asia/Shanghai 日历锚点");
    ax = shanghaiGiftStatsDayAnchors(Date.now());
  }
  if (!ax) {
    throw new Error("computeGiftStatsTimeWindow: fatal calendar (Asia/Shanghai)");
  }

  const { todayStart, nextDayStart, monthStart } = ax;

  /** @type {{ startTs: number, endTs?: number }} */
  let out;
  switch (rangeCanon) {
    case "yesterday":
      out = { startTs: todayStart - GIFT_STATS_MS_PER_DAY, endTs: todayStart };
      break;
    case "today":
      out = { startTs: todayStart };
      break;
    case "week": {
      const day = shanghaiGetDaySun0(todayStart);
      const diff = day === 0 ? 6 : day - 1;
      out = { startTs: todayStart - diff * GIFT_STATS_MS_PER_DAY };
      break;
    }
    case "month":
      out = { startTs: monthStart };
      break;
    case "7days":
      out = { startTs: nextDayStart - 7 * GIFT_STATS_MS_PER_DAY };
      break;
    case "30days":
      out = { startTs: nextDayStart - 30 * GIFT_STATS_MS_PER_DAY };
      break;
    default:
      out = { startTs: todayStart };
      break;
  }

  out.startTs = Math.trunc(out.startTs);
  if (out.endTs !== undefined) {
    out.endTs = Math.trunc(out.endTs);
  }

  if (rangeCanon === "yesterday") {
    if (!Number.isFinite(out.startTs) || !Number.isFinite(out.endTs) || out.endTs !== out.startTs + GIFT_STATS_MS_PER_DAY) {
      out.startTs = Math.trunc(todayStart - GIFT_STATS_MS_PER_DAY);
      out.endTs = Math.trunc(todayStart);
      console.warn("[danmaku] computeGiftStatsTimeWindow: yesterday 窗口已按锚点修正");
    }
  } else if (out.endTs !== undefined) {
    delete out.endTs;
  }

  if (!Number.isFinite(out.startTs)) {
    console.error("[danmaku] computeGiftStatsTimeWindow: startTs 非法", out);
    if (rangeCanon === "yesterday") {
      out.startTs = Math.trunc(ax.todayStart - GIFT_STATS_MS_PER_DAY);
      out.endTs = Math.trunc(ax.todayStart);
    } else {
      out.startTs = Math.trunc(ax.todayStart);
      delete out.endTs;
    }
  }

  const endPart =
    out.endTs === undefined
      ? "endTs=（无，统计至当前）"
      : `endTs=${out.endTs}（${fmt(out.endTs)}，区间为 [start,end)）`;

  console.log(
    `[danmaku] computeGiftStatsTimeWindow range=${rangeCanon} nowMs=${nowMs} → startTs=${out.startTs}（${fmt(out.startTs)}） ${endPart}`,
  );

  return out;
}

/** @param {import("http").IncomingMessage} req */
function headerPassword(req) {
  const h = req.headers["x-password"];
  if (Array.isArray(h)) return String(h[0] ?? "").trim();
  if (typeof h === "string") return h.trim();
  return "";
}

function dreamBusOnlyAllowsRequest(path, method) {
  if (path === "/events" && method === "GET") return true;
  if (path.startsWith("/dream-bus/")) return true;
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Password" });
    res.end();
    return;
  }

  if (DREAM_BUS_ONLY && !dreamBusOnlyAllowsRequest(path, req.method)) {
    return jsonReply(res, { ok: false, error: "窃听宝语已关闭，仅提供宝宝巴士 API" }, 404);
  }

  // SSE endpoint — backend mode (multi-room)
  if (path === "/events" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    res.write(`event: rooms\ndata: ${JSON.stringify(buildRoomsStatusPayload())}\n\n`);
    sseClients.add(res);
    req.on("close", () => { sseClients.delete(res); });
    return;
  }

  // SSE endpoint — web capture (per-client TCP)
  if (path === "/web-events" && req.method === "GET") {
    const roomId = url.searchParams.get("roomId");
    if (!roomId) return jsonReply(res, { error: "roomId required" }, 400);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    const ctx = createWebCaptureConnection(roomId, res);
    req.on("close", () => { destroyWebCaptureConnection(ctx); });
    return;
  }

  // POST /verify-password — verify backend password
  if (path === "/verify-password" && req.method === "POST") {
    try {
      const body = await readBody(req);
      return jsonReply(res, { ok: body.password === BACKEND_PASSWORD });
    } catch { return jsonReply(res, { ok: false }, 400); }
  }

  // GET /rooms — list all backend rooms
  if (path === "/rooms" && req.method === "GET") {
    return jsonReply(res, { ok: true, rooms: buildRoomsStatusPayload() });
  }

  // POST /rooms — add a backend room (password required)
  if (path === "/rooms" && req.method === "POST") {
    try {
      const body = await readBody(req);
      if (body.password !== BACKEND_PASSWORD) return jsonReply(res, { ok: false, error: "密码错误" }, 403);
      const roomId = String(body.roomId || "").trim();
      if (!roomId) return jsonReply(res, { ok: false, error: "roomId is required" }, 400);
      if (backendRooms.has(roomId)) return jsonReply(res, { ok: false, error: "该直播间已在捕捉列表中" }, 409);
      connectBackendRoom(roomId);
      return jsonReply(res, { ok: true, roomId });
    } catch (e) { return jsonReply(res, { ok: false, error: e.message }, 400); }
  }

  // DELETE /rooms/:roomId — remove a backend room (password required)
  if (path.startsWith("/rooms/") && req.method === "DELETE") {
    const roomId = decodeURIComponent(path.substring("/rooms/".length));
    const pw = headerPassword(req);
    if (pw !== BACKEND_PASSWORD) return jsonReply(res, { ok: false, error: "密码错误" }, 403);
    if (!backendRooms.has(roomId)) return jsonReply(res, { ok: false, error: "Room not found" }, 404);
    disconnectBackendRoom(roomId);
    return jsonReply(res, { ok: true });
  }

  // GET /status — overall status
  if (path === "/status" && req.method === "GET") {
    return jsonReply(res, { ok: true, rooms: buildRoomsStatusPayload(), sseClients: sseClients.size });
  }

  // GET /room-info/:roomId
  if (path.startsWith("/room-info/") && req.method === "GET") {
    const rid = path.substring("/room-info/".length);
    const info = await fetchRoomInfo(rid);
    if (!info) return jsonReply(res, { ok: false, error: "Failed to fetch room info" }, 502);
    return jsonReply(res, { ok: true, info });
  }

  // GET /recordings
  if (path === "/recordings" && req.method === "GET") {
    return jsonReply(res, { ok: true, recordings: listRecordings(url.searchParams.get("roomId") || null) });
  }

  // GET /trigger-actions — list available action types
  if (path === "/trigger-actions" && req.method === "GET") {
    return jsonReply(res, { ok: true, actions: AVAILABLE_ACTIONS });
  }

  // --- Triggers ---
  if (path === "/triggers" && req.method === "GET") return jsonReply(res, { ok: true, triggers: triggerConfig.triggers });
  if (path === "/triggers" && req.method === "PUT") {
    try {
      const body = await readBody(req);
      if (!Array.isArray(body.triggers)) return jsonReply(res, { ok: false, error: "triggers array required" }, 400);
      triggerConfig = hydrateTriggerConfig({ triggers: body.triggers });
      saveTriggers(triggerConfig);
      return jsonReply(res, { ok: true, triggers: triggerConfig.triggers });
    } catch (e) { return jsonReply(res, { ok: false, error: e.message }, 400); }
  }
  if (path === "/triggers" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const trigger = normalizeTrigger({
        id: body.id,
        kind:
          typeof body.kind === "string" && String(body.kind).toLowerCase() === "schedule"
            ? "schedule"
            : triggerLooksScheduled(body)
              ? "schedule"
              : "danmaku",
        pattern: body.pattern,
        action: body.action,
        enabled: body.enabled,
        description: body.description,
        roomIds: body.roomIds,
        schedule: body.schedule,
        payload: body.payload,
      });
      triggerConfig.triggers.push(trigger);
      saveTriggers(triggerConfig);
      return jsonReply(res, { ok: true, trigger });
    } catch (e) { return jsonReply(res, { ok: false, error: e.message }, 400); }
  }
  if (path.startsWith("/triggers/") && req.method === "DELETE") {
    const id = path.substring("/triggers/".length);
    const idx = triggerConfig.triggers.findIndex((t) => t.id === id);
    if (idx === -1) return jsonReply(res, { ok: false, error: "Not found" }, 404);
    triggerConfig.triggers.splice(idx, 1);
    saveTriggers(triggerConfig);
    delete scheduleFireState[id];
    saveScheduleFireState();
    return jsonReply(res, { ok: true });
  }

  // --- Action log ---
  if (path === "/action-log" && req.method === "GET") {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const roomId = url.searchParams.get("roomId") || null;
    let filtered = actionLog;
    if (roomId) {
      filtered = actionLog.filter((e) =>
        e.roomId === roomId
        || (e.source === "schedule" && (!e.roomId || e.roomId === "")),
      );
    }
    return jsonReply(res, { ok: true, log: filtered.slice(-limit).reverse(), total: filtered.length });
  }
  if (path === "/action-log/clear" && req.method === "POST") { actionLog = []; saveActionLog(actionLog); return jsonReply(res, { ok: true }); }

  // --- Recent danmaku ---
  if (path.startsWith("/recent-danmaku/") && req.method === "GET") {
    const rid = decodeURIComponent(path.substring("/recent-danmaku/".length));
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    return jsonReply(res, { ok: true, messages: getRecentDanmaku(rid, limit) });
  }

  // --- Song requests ---
  // GET /song-requests/:roomId — get all song request data
  if (path.startsWith("/song-requests/") && !path.includes("/clear") && req.method === "GET") {
    const rid = decodeURIComponent(path.substring("/song-requests/".length));
    return jsonReply(res, {
      ok: true,
      roomId: rid,
      timeline: loadTimeline(rid),
      session: loadSessionStats(rid),
      total: loadTotalStats(rid),
    });
  }
  // POST /song-requests/:roomId/clear-session — clear session stats only
  if (path.match(/^\/song-requests\/[^/]+\/clear-session$/) && req.method === "POST") {
    const rid = decodeURIComponent(path.split("/")[2]);
    saveSessionStats(rid, {});
    // Also clear timeline for current session view
    saveTimeline(rid, []);
    return jsonReply(res, { ok: true });
  }

  // --- Gifts ---
  // GET /gift-photos-w — webconf giftPhotos_w.json（图鉴写真 JSONP，全局缓存 1h）
  if (path === "/gift-photos-w" && req.method === "GET") {
    const st = await getGiftPhotosWPayloadCached();
    if (!st.payload) {
      return jsonReply(res, { ok: false, error: "giftPhotos_w 拉取失败" }, 502);
    }
    const p = st.payload;
    return jsonReply(
      res,
      {
        ok: true,
        fetchedAt: st.fetchedAt,
        tabInfos: p.tabInfos,
        pgInfos: p.pgInfos,
        unlockStar: p.unlockStar,
        awardStar: p.awardStar,
        skin: p.skin,
        photoSwitch: p.photoSwitch,
        allSwitch: p.allSwitch,
        auth: p.auth,
      },
      200,
      { "Cache-Control": "no-store" },
    );
  }
  // GET /gift-list/:roomId — get gift name/icon mapping from Douyu API
  if (path.match(/^\/gift-list\/[^/]+$/) && req.method === "GET") {
    const rid = decodeURIComponent(path.split("/")[2]);
    const payload = await fetchGiftListPayload(rid);
    if (!payload?.gifts) return jsonReply(res, { ok: false, error: "Failed to fetch gift list" }, 502);
    return jsonReply(res, {
      ok: true,
      gifts: payload.gifts,
      stats: payload.stats,
      backpackCatalog: payload.backpackCatalog || {},
      backpackCatalogStats: payload.backpackCatalogStats || {},
    });
  }
  // GET /badge-avatar/:roomId — get streamer avatar for fan badge icon
  if (path.match(/^\/badge-avatar\/[^/]+$/) && req.method === "GET") {
    const rid = decodeURIComponent(path.split("/")[2]);
    const info = await fetchRoomInfo(rid);
    if (!info || !info.avatar) return jsonReply(res, { ok: false, error: "Not found" }, 404);
    return jsonReply(res, { ok: true, avatar: info.avatar, ownerName: info.owner_name });
  }
  // GET /gifts/:roomId — get gift records for a room
  if (path.match(/^\/gifts\/[^/]+$/) && req.method === "GET") {
    const rid = decodeURIComponent(path.split("/")[2]);
    const limit = Math.min(25_000, Math.max(1, Number(url.searchParams.get("limit")) || 200));
    const gifts = loadGifts(rid, limit);
    const index = loadGiftIndex(rid);
    return jsonReply(res, { ok: true, gifts, totalCount: index.totalCount });
  }
  // GET /gifts/:roomId/stats — 礼物统计面板数据：按 range 对应的上海自然日/滚动窗过滤归档，聚合成 stats
  if (path.match(/^\/gifts\/[^/]+\/stats$/) && req.method === "GET") {
    // ① 房间号：路径第二段，与前端 encodeURIComponent(rid) 对应
    const rid = decodeURIComponent(path.split("/")[2]);
    // ② 原始 query 中的 range（可能来自 range / window / giftRange；重复 key 取最后一个）
    const rangeQueryRaw = pickGiftStatsRangeQueryRaw(url);
    // ③ 归一化字符串 → yesterday | today | week | 7days | month | 30days | 其它小写串
    const rangeIn = normalizeGiftStatsRangeParam(rangeQueryRaw || null);
    /** @type {Set<string>} */
    const knownRanges = new Set(["yesterday", "today", "week", "7days", "month", "30days"]);
    // ④ 最终采用的 range：未知值回落到 today（与前端展示「归一为 today」一致）
    const range = knownRanges.has(rangeIn) ? rangeIn : "today";
    if (rangeIn !== range) {
      console.warn(`[danmaku] GET /gifts/.../stats 未知 range=${JSON.stringify(rangeIn)}（原始 query=${JSON.stringify(rangeQueryRaw)}），已按 today 处理`);
    }

    const debugMode = url.searchParams.get("debug") === "1";
    const debugRowsMaxRaw = Number(url.searchParams.get("debugRowsMax"));
    const debugRowsMaxParam = Number.isFinite(debugRowsMaxRaw) ? debugRowsMaxRaw : 8000;

    const bundle = await computeRoomGiftStatsPanelBundle(rid, range, Date.now(), {
      collectDebugRows: debugMode,
      debugRowsMax: debugRowsMaxParam,
    });

    const { stats, matchedGiftRows, startTs, endTs, giftChunkFiles } = bundle;

    const endHint = Number.isFinite(endTs) ? "[start,end) 终点不含" : "仅下界，统计至当前";
    // ⑩ 同步落盘 + console，避免 fmz-dev 管道缓冲导致「日志文件只有启动分隔线」
    danmakuSyncLog(
      `[danmaku] GET /gifts/stats rid=${rid} range=${range} ${endHint} window=[${giftLogFmtShanghai(startTs)} ~ ${Number.isFinite(endTs) ? giftLogFmtShanghai(endTs) : "∞"}] ms=[${startTs}, ${endTs ?? "—"}] matchedRows=${matchedGiftRows} totalPieces=${stats.totalCount} giftChunkFiles=${giftChunkFiles}`,
    );
    // ⑪ 返回 JSON：前端 loadGiftStats 消费 stats、startTs、endTs、range*
    /** @type {Record<string, unknown>} */
    const payload = {
      ok: true,
      stats,
      range,
      rangeNormalized: rangeIn,
      rangeQueryRaw: rangeQueryRaw || null,
      startTs,
      endTs: endTs ?? null,
    };
    if (debugMode) {
      payload.matchedArchiveRows = matchedGiftRows;
      payload.giftChunkFiles = giftChunkFiles;
      payload.debugRows = bundle.debugRows;
      payload.debugRowsTruncated = bundle.debugRowsTruncated;
      payload.debugRowsMaxRequested = bundle.debugRowsMaxRequested;
      payload.debugRowsReturned = bundle.debugRowsReturned;
      payload.giftMergeStats = bundle.giftMergeStats;
    }
    return jsonReply(res, payload, 200, { "Cache-Control": "no-store" });
  }
  // POST /gifts/:roomId/clear — clear gift records for a room
  if (path.match(/^\/gifts\/[^/]+\/clear$/) && req.method === "POST") {
    const rid = decodeURIComponent(path.split("/")[2]);
    clearGifts(rid);
    return jsonReply(res, { ok: true });
  }

  // GET /ai-range-export/:roomId — 为 AI 汇总某房间在给定时间范围内的录制弹幕 + 归档礼物
  if (path.startsWith("/ai-range-export/") && req.method === "GET") {
    const rid = decodeURIComponent(path.substring("/ai-range-export/".length));
    if (!rid) return jsonReply(res, { ok: false, error: "roomId required" }, 400);
    const rangeKey = (url.searchParams.get("range") || "today").trim();
    const maxDm = Math.min(20_000, Math.max(100, Number(url.searchParams.get("maxDanmaku")) || 8000));
    const maxG = Math.min(20_000, Math.max(50, Number(url.searchParams.get("maxGifts")) || 2500));
    const inclDm = url.searchParams.get("includeDanmaku") !== "0";
    const inclG = url.searchParams.get("includeGifts") !== "0";
    if (!inclDm && !inclG) {
      return jsonReply(res, { ok: false, error: "includeDanmaku 与 includeGifts 至少启用一项" }, 400);
    }

    const bundle = buildAiExportPayload(rid, rangeKey, maxDm, maxG, inclDm, inclG);
    if (!bundle.ok) {
      return jsonReply(res, {
        ok: false,
        error: "无效的时间范围（range）；指定日：day:YYYY-MM-DD；指定周：week:YYYY-MM-DD（填入该周内任意一天）；滚动：24h / 7days；日历窗口：prev_calendar_day（上一自然日）/ prev_calendar_week（上周一至周日）",
      }, 400);
    }
    return jsonReply(res, bundle);
  }

  // POST /ai-reports/hide — 软隐藏一条日报/周报（推荐：密码在 JSON body，避免部分反代丢弃 X-Password）
  if (path === "/ai-reports/hide" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const pw = headerPassword(req) || String(body.password ?? "").trim();
      if (pw !== BACKEND_PASSWORD) return jsonReply(res, { ok: false, error: "密码错误" }, 403);
      const rid = String(body.roomId ?? "").trim();
      const eid = String(body.entryId ?? "").trim();
      if (!rid || !eid) return jsonReply(res, { ok: false, error: "roomId 与 entryId 必填" }, 400);
      const hid = hideAiReportEntry(rid, eid);
      if (hid === "not_found") return jsonReply(res, { ok: false, error: "报告不存在" }, 404);
      if (hid === "persist_failed") return jsonReply(res, { ok: false, error: "写入 ai-reports.json 失败" }, 500);
      broadcastToSSE("ai-report-deleted", { roomId: rid, entryId: eid });
      return jsonReply(res, { ok: true });
    } catch {
      return jsonReply(res, { ok: false, error: "请求体须为 JSON：{ roomId, entryId, password? }" }, 400);
    }
  }

  // DELETE /ai-reports/:roomId/:entryId — 软隐藏（需 X-Password 或改用 POST /ai-reports/hide）
  if (path.startsWith("/ai-reports/") && req.method === "DELETE") {
    const rest = path.slice("/ai-reports/".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) return jsonReply(res, { ok: false, error: "用法：DELETE /ai-reports/:roomId/:entryId" }, 400);
    const rid = decodeURIComponent(rest.slice(0, slash));
    const eid = decodeURIComponent(rest.slice(slash + 1));
    if (!rid || !eid || rest.slice(slash + 1).includes("/")) {
      return jsonReply(res, { ok: false, error: "roomId 与 entryId 无效" }, 400);
    }
    const pw = headerPassword(req);
    if (pw !== BACKEND_PASSWORD) return jsonReply(res, { ok: false, error: "密码错误" }, 403);
    const hid = hideAiReportEntry(rid, eid);
    if (hid === "not_found") return jsonReply(res, { ok: false, error: "报告不存在" }, 404);
    if (hid === "persist_failed") return jsonReply(res, { ok: false, error: "写入 ai-reports.json 失败" }, 500);
    broadcastToSSE("ai-report-deleted", { roomId: rid, entryId: eid });
    return jsonReply(res, { ok: true });
  }

  // --- Dream Bus（梦幻巴士到站）---
  if (path === "/dream-bus/config" && req.method === "GET") {
    try {
      const st = await getDreamBusConfigCached();
      return jsonReply(res, { ok: true, config: st.data, fetchedAt: st.fetchedAt });
    } catch (e) {
      return jsonReply(res, { ok: false, error: e.message }, 502);
    }
  }
  if (path === "/dream-bus/live" && req.method === "GET") {
    return jsonReply(res, { ok: true, live: getDreamBusLiveState() });
  }
  if (path === "/dream-bus/records" && req.method === "GET") {
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit")) || 1440));
    return jsonReply(res, { ok: true, records: getDreamBusRecords(limit), total: getDreamBusRecords(5000).length });
  }

  // GET /ai-reports/:roomId — 已生成的日报/周报列表（按房间；不含 hidden）
  if (path.startsWith("/ai-reports/") && req.method === "GET") {
    const rid = decodeURIComponent(path.substring("/ai-reports/".length));
    if (!rid) return jsonReply(res, { ok: false, error: "roomId required" }, 400);
    const store = loadAiReportsStore();
    const entries = store.entries
      .filter((e) => String(e.roomId) === rid && !e.hidden)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return jsonReply(res, { ok: true, roomId: rid, entries });
  }

  jsonReply(res, { error: "Not found" }, 404);
});

loadDreamBusRecordsFromDisk();
void bootstrapDreamBusRecordsFromHttp("9046690").then((n) => {
  if (n > 0) console.log(`[danmaku] dream-bus bootstrap: ${n} records from stationRecord`);
});

server.listen(PORT, () => {
  if (DREAM_BUS_ONLY) {
    console.log(`[douyu-danmaku] dream-bus-only 模式：仅宝宝巴士（room=${DREAM_BUS_ROOM_ID}）`);
  } else {
    console.log(`[douyu-danmaku] Server listening on http://127.0.0.1:${PORT}`);
    console.log(`[douyu-danmaku] AI report triggers → ai-agent-server ${AI_AGENT_INTERNAL_URL}`);
  }
  danmakuSyncLog(
    `[danmaku] 服务就绪 PORT=${PORT} mode=${DREAM_BUS_ONLY ? "dream-bus-only" : "full"} cwd=${process.cwd()} 同步日志: server/data/danmaku/danmaku-trace.log 与 .fmz-dev/logs/danmaku-trace.log`,
  );

  if (DREAM_BUS_ONLY) {
    if (DREAM_BUS_ROOM_ID) connectBackendRoom(DREAM_BUS_ROOM_ID);
    else console.warn("[danmaku] dream-bus-only 但未设置 FMZ_DREAM_BUS_ROOM_ID");
  } else {
    // Auto-reconnect saved backend rooms on startup
    const savedRooms = loadSavedRooms();
    if (savedRooms.length > 0) {
      console.log(`[danmaku] Restoring ${savedRooms.length} saved room(s): ${savedRooms.join(", ")}`);
      for (const rid of savedRooms) {
        connectBackendRoom(rid);
      }
    }
    setInterval(tickScheduledTriggers, 15_000);
  }
});
