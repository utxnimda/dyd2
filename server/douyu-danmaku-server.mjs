/**
 * douyu-danmaku-server.mjs
 * Douyu live room danmaku capture service.
 *
 * - Connects to Douyu danmaku server via raw TCP socket (multi-room)
 * - Implements Douyu STT (Serialized Text Transport) protocol
 * - Forwards danmaku to frontend via Server-Sent Events (SSE)
 * - Supports trigger+action configuration for #command style messages
 * - Password protection for adding/removing rooms
 *
 * Port: 8791 (configurable via PORT env)
 */

import http from "node:http";
import net from "node:net";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8791;
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

const BACKEND_PASSWORD = "lsyysl";

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

const giftListCache = new Map(); // roomId -> { data: fetchGiftPayload, fetchedAt }
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

/** CDN「礼物」条目：from 为 2 时表示背包礼物，其余视为 1 直接礼物（缺字段默认直连）。 */
function douyuGiftListFrom(o) {
  const n = Number(o?.from);
  return n === 2 ? 2 : 1;
}

// Fallback for gifts not found in API (retired/event gifts)
const GIFT_FALLBACK = {
  "0": { name: "未知礼物", icon: "", cost: 0, value: 0 },
  "192": { name: "感谢有你", icon: "", cost: 100, value: 10 },
  "519": { name: "盛典飞机", icon: "", cost: 1000, value: 100 },
  "520": { name: "盛典火箭", icon: "", cost: 5000, value: 500 },
  "824": { name: "火箭", icon: "", cost: 5000, value: 500 },
  "21743": { name: "小星星", icon: "", cost: 10, value: 1 },
  "22633": { name: "比心", icon: "", cost: 100, value: 0 },
  "22899": { name: "小花花", icon: "", cost: 10, value: 1 },
  "23995": { name: "打Call", icon: "", cost: 100, value: 0 },
  "23996": { name: "干杯", icon: "", cost: 200, value: 0 },
};
// Alias: old/retired gift IDs -> current gift IDs (to inherit icon from current version)
const GIFT_ALIAS = {
  "824": "20004",   // old rocket -> current rocket
  "519": "20004",   // event airplane -> rocket (similar icon)
  "520": "20005",   // event rocket -> super rocket
  "21743": "20546", // old 小星星 -> current 小星星
};

/**
 * Room gift CDN + global prop/backpack calibration.
 * Returns { gifts, backpackCatalog (debug: only CDN from=2 rows), backpackCatalogStats } or null if v3 list fails.
 */
async function fetchGiftListPayload(roomId) {
  const cached = giftListCache.get(roomId);
  if (cached && Date.now() - cached.fetchedAt < GIFT_LIST_TTL) return cached.data;
  try {
    const propCfg = await getPropGiftConfigMapCached();
    const propMap = propCfg.map;

    const resp = await fetch(`https://gift.douyucdn.cn/api/gift/v3/web/list?rid=${roomId}`);
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json.error !== 0 || !json.data) return null;

    /** @type {Record<string, { name: string, icon: string, cost: number, value: number, from: number, raw: object|null, propRaw?: object|null }>} */
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
            from: douyuGiftListFrom(g),
            raw: cloneGiftListRawChunk(g),
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
                from: douyuGiftListFrom(sg),
                raw: cloneGiftListRawChunk(sg),
              };
            }
          }
        }
      }
    }

    for (const [id, info] of Object.entries(GIFT_FALLBACK)) {
      if (!map[id]) {
        const aliasId = GIFT_ALIAS[id];
        const aliasInfo = aliasId ? map[aliasId] : null;
        map[id] = {
          ...info,
          icon: info.icon || (aliasInfo ? aliasInfo.icon : ""),
          from: 1,
          raw: null,
        };
      }
    }

    const backpackSparse = {};
    let roomBackpackGiftIds = 0;
    let overlaidFromPropCount = 0;

    for (const [idStr, ge] of Object.entries(map)) {
      const isBk = Number(ge.from) === 2;
      if (!isBk) continue;
      roomBackpackGiftIds++;
      const pv = propMap ? propMap[idStr] : null;
      if (pv && typeof pv === "object") {
        if (pv.pc !== undefined && Number.isFinite(Number(pv.pc))) ge.cost = Number(pv.pc);
        if (pv.devote !== undefined && Number.isFinite(Number(pv.devote))) ge.value = Number(pv.devote);
        if ((!String(ge.icon || "").trim()) && pv.icon) ge.icon = pv.icon;
        if ((!String(ge.name || "").trim()) && pv.name) ge.name = pv.name;
        ge.propRaw = pv.raw ?? null;
        overlaidFromPropCount++;
      } else {
        ge.propRaw = null;
      }
      backpackSparse[idStr] = {
        name: (pv?.name || ge.name) || "",
        pc: pv?.pc ?? ge.cost ?? 0,
        devote: pv?.devote ?? ge.value ?? 0,
        type: pv?.type ?? null,
        icon: (pv?.icon || ge.icon || "").trim(),
        raw: pv?.raw ?? null,
        overlaidFromProp: Boolean(pv),
      };
    }

    const backpackCatalogStats = {
      totalPropKeys: Number(propCfg.totalKeys) || 0,
      roomBackpackGiftIds,
      overlaidFromPropCount,
      propConfigOk: Boolean(propMap),
    };

    const pack = { gifts: map, backpackCatalog: backpackSparse, backpackCatalogStats };
    giftListCache.set(roomId, { data: pack, fetchedAt: Date.now() });
    return pack;
  } catch (e) {
    console.error(`[danmaku] Failed to fetch gift list for ${roomId}:`, e.message);
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
  console.log(`[danmaku-record] Started recording room ${conn.roomId}`);
}

function stopRecordingForRoom(conn) {
  if (!conn.recordFile) return;
  const footer = { _type: "session_end", roomId: conn.roomId, endedAt: new Date().toISOString(), recordedCount: conn.recordedCount, ts: Date.now() };
  try { appendFileSync(conn.recordFile, JSON.stringify(footer) + "\n", "utf-8"); } catch { /* ignore */ }
  console.log(`[danmaku-record] Stopped recording room ${conn.roomId}. Total: ${conn.recordedCount}`);
  conn.recordFile = null;
  conn.recordedCount = 0;
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

function loadTriggers() {
  try { if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")); } catch { /* ignore */ }
  return { triggers: [{ id: "default_cmd", pattern: "#", action: "log", enabled: true, description: "Capture all #command style danmaku and log the content after #" }] };
}

/** Available action types for triggers */
const AVAILABLE_ACTIONS = [
  { id: "log", label: "展示" },
  { id: "song-request", label: "点歌" },
];
function saveTriggers(config) { writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8"); }
function loadActionLog() { try { if (existsSync(LOG_FILE)) return JSON.parse(readFileSync(LOG_FILE, "utf-8")); } catch { /* ignore */ } return []; }
function saveActionLog(log) { writeFileSync(LOG_FILE, JSON.stringify(log.slice(-500), null, 2), "utf-8"); }

let triggerConfig = loadTriggers();
let actionLog = loadActionLog();

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
    result.unshift(...chunk);
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

function recordGift(roomId, msg) {
  // Save all available fields from the dgb message
  const entry = { ...msg, roomId, ts: Date.now() };
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
    // Check room binding: if roomIds is set and non-empty, only match specified rooms
    if (trigger.roomIds && trigger.roomIds.length > 0 && !trigger.roomIds.includes(roomId)) continue;
    if (!txt.startsWith(trigger.pattern)) continue;
    const content = txt.substring(trigger.pattern.length).trim();
    if (!content) continue;
    const conn = backendRooms.get(roomId);
    if (conn) conn.stats.triggered++;
    const logEntry = { triggerId: trigger.id, pattern: trigger.pattern, action: trigger.action, content, nickname: danmaku.nn, uid: danmaku.uid, fullText: txt, roomId, ts: Date.now() };
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
    wantConnected: true, // flag to control auto-reconnect
  };
  backendRooms.set(roomId, conn);
  saveRoomsList();
  broadcastRoomsStatus();

  function processMessage(payload) {
    const msg = decodeStt(payload);
    if (!msg.type) return;
    if (msg.type === "chatmsg") {
      const danmaku = buildChatmsgDanmaku(msg);
      conn.stats.total++;
      broadcastToSSE("danmaku", { ...danmaku, roomId });
      recordDanmakuForRoom(conn, danmaku);
      processTriggers(danmaku, roomId);
    }
    if (msg.type === "dgb") {
      const giftEntry = recordGift(roomId, msg);
      broadcastToSSE("gift", giftEntry);
    }
    if (msg.type === "uenter") broadcastToSSE("enter", { type: "uenter", uid: msg.uid || "", nn: msg.nn || "", roomId, ts: Date.now() });
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
        if (!trigger.enabled || !txt.startsWith(trigger.pattern)) continue;
        const content = txt.substring(trigger.pattern.length).trim();
        if (!content) continue;
        ctx.stats.triggered++;
        const logEntry = { triggerId: trigger.id, pattern: trigger.pattern, action: trigger.action, content, nickname: danmaku.nn, uid: danmaku.uid, fullText: txt, ts: Date.now(), source: "web" };
        if (trigger.action === "log") console.log(`[danmaku-web-trigger] ${danmaku.nn}: ${txt} → "${content}"`);
        actionLog.push(logEntry);
        if (actionLog.length > 500) actionLog = actionLog.slice(-500);
        saveActionLog(actionLog);
        sendSSE("trigger", logEntry);
      }
    }
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

function jsonReply(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Password" });
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Password" });
    res.end();
    return;
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
    const pw = req.headers["x-password"] || "";
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
    try { const body = await readBody(req); if (!Array.isArray(body.triggers)) return jsonReply(res, { ok: false, error: "triggers array required" }, 400); triggerConfig.triggers = body.triggers; saveTriggers(triggerConfig); return jsonReply(res, { ok: true, triggers: triggerConfig.triggers }); } catch (e) { return jsonReply(res, { ok: false, error: e.message }, 400); }
  }
  if (path === "/triggers" && req.method === "POST") {
    try { const body = await readBody(req); const trigger = { id: body.id || `trigger_${Date.now()}`, pattern: body.pattern || "#", action: body.action || "log", enabled: body.enabled !== false, description: body.description || "", roomIds: Array.isArray(body.roomIds) ? body.roomIds : [] }; triggerConfig.triggers.push(trigger); saveTriggers(triggerConfig); return jsonReply(res, { ok: true, trigger }); } catch (e) { return jsonReply(res, { ok: false, error: e.message }, 400); }
  }
  if (path.startsWith("/triggers/") && req.method === "DELETE") {
    const id = path.substring("/triggers/".length);
    const idx = triggerConfig.triggers.findIndex((t) => t.id === id);
    if (idx === -1) return jsonReply(res, { ok: false, error: "Not found" }, 404);
    triggerConfig.triggers.splice(idx, 1); saveTriggers(triggerConfig); return jsonReply(res, { ok: true });
  }

  // --- Action log ---
  if (path === "/action-log" && req.method === "GET") {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const roomId = url.searchParams.get("roomId") || null;
    let filtered = actionLog;
    if (roomId) filtered = actionLog.filter(e => e.roomId === roomId);
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
  // GET /gift-list/:roomId — get gift name/icon mapping from Douyu API
  if (path.match(/^\/gift-list\/[^/]+$/) && req.method === "GET") {
    const rid = decodeURIComponent(path.split("/")[2]);
    const payload = await fetchGiftListPayload(rid);
    if (!payload?.gifts) return jsonReply(res, { ok: false, error: "Failed to fetch gift list" }, 502);
    return jsonReply(res, {
      ok: true,
      gifts: payload.gifts,
      backpackCatalog: payload.backpackCatalog,
      backpackCatalogStats: payload.backpackCatalogStats,
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
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit")) || 200));
    const gifts = loadGifts(rid, limit);
    const index = loadGiftIndex(rid);
    return jsonReply(res, { ok: true, gifts, totalCount: index.totalCount });
  }
  // GET /gifts/:roomId/stats — get gift value stats for a room within a time range
  if (path.match(/^\/gifts\/[^/]+\/stats$/) && req.method === "GET") {
    const rid = decodeURIComponent(path.split("/")[2]);
    const range = url.searchParams.get("range") || "today";
    const now = new Date();
    let startTs;
    switch (range) {
      case "today": {
        const d = new Date(now); d.setHours(0, 0, 0, 0);
        startTs = d.getTime();
        break;
      }
      case "week": {
        const d = new Date(now); const day = d.getDay(); const diff = day === 0 ? 6 : day - 1;
        d.setDate(d.getDate() - diff); d.setHours(0, 0, 0, 0);
        startTs = d.getTime();
        break;
      }
      case "7days": {
        const d = new Date(now); d.setHours(24, 0, 0, 0); // end of today
        startTs = d.getTime() - 7 * 24 * 60 * 60 * 1000;
        break;
      }
      case "month": {
        const d = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        startTs = d.getTime();
        break;
      }
      case "30days": {
        const d = new Date(now); d.setHours(24, 0, 0, 0);
        startTs = d.getTime() - 30 * 24 * 60 * 60 * 1000;
        break;
      }
      default: {
        const d = new Date(now); d.setHours(0, 0, 0, 0);
        startTs = d.getTime();
      }
    }
    // Load all gifts and filter by time range
    migrateOldGiftFile(rid);
    const index = loadGiftIndex(rid);
    const stats = { totalValue: 0, totalCount: 0, byGift: {}, byUser: {} };
    for (let i = 0; i < index.fileCount; i++) {
      const chunk = loadJsonFile(giftChunkPath(rid, i), []);
      for (const g of chunk) {
        if ((g.ts || 0) < startTs) continue;
        const gfid = g.gfid || "0";
        const amount = giftPiecesFromStoredRecord(g);
        // byGift: { gfid: { count, name } }
        if (!stats.byGift[gfid]) stats.byGift[gfid] = { count: 0 };
        stats.byGift[gfid].count += amount;
        // byUser: { uid: { nn, count, gifts: { gfid: count } } }
        const uid = g.uid || "anon";
        if (!stats.byUser[uid]) stats.byUser[uid] = { nn: g.nn || "", count: 0, gifts: {} };
        stats.byUser[uid].count += amount;
        if (!stats.byUser[uid].gifts[gfid]) stats.byUser[uid].gifts[gfid] = 0;
        stats.byUser[uid].gifts[gfid] += amount;
        stats.totalCount += amount;
      }
    }
    return jsonReply(res, { ok: true, stats, range, startTs });
  }
  // POST /gifts/:roomId/clear — clear gift records for a room
  if (path.match(/^\/gifts\/[^/]+\/clear$/) && req.method === "POST") {
    const rid = decodeURIComponent(path.split("/")[2]);
    clearGifts(rid);
    return jsonReply(res, { ok: true });
  }

  jsonReply(res, { error: "Not found" }, 404);
});

server.listen(PORT, () => {
  console.log(`[douyu-danmaku] Server listening on http://127.0.0.1:${PORT}`);

  // Auto-reconnect saved backend rooms on startup
  const savedRooms = loadSavedRooms();
  if (savedRooms.length > 0) {
    console.log(`[danmaku] Restoring ${savedRooms.length} saved room(s): ${savedRooms.join(", ")}`);
    for (const rid of savedRooms) {
      connectBackendRoom(rid);
    }
  }
});
