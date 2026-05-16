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
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { geminiEligibleForOpenAiCompatTextChat } from "./gemini-openai-compat-chat-filter.mjs";

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
 * - v3 gifts: priceType === "YUCHI" → isPaid=true (streamer earns revenue)
 * - prop gifts: pc >= 100 → isPaid=true (heuristic; most low-pc gifts are free items)
 *
 * `source` field: "v3" = from CDN v3 API, "prop" = from prop_gift_config
 */

/**
 * Build merged gift map: v3 API (room-specific) + prop_gift_config (global legacy).
 * Returns { gifts, stats } or null on total failure.
 */
async function fetchGiftListPayload(roomId) {
  const cached = giftListCache.get(roomId);
  if (cached && Date.now() - cached.fetchedAt < GIFT_LIST_TTL) return cached.data;
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
    // Revenue: priceType === "YUCHI" → isPaid=true (streamer earns revenue)
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
        map[id] = {
          name: entry.name,
          icon: entry.icon,
          cost,
          value,
          from: fromVal,
          source: entry.source,
          isPaid: entry._priceType === "YUCHI",
          priceType: entry._priceType || undefined,
          raw: entry.raw,
          ...(propRaw ? { propRaw } : {}),
        };
      }
    }

    // Ensure gfid=0 has a fallback (鱼丸, free gift)
    if (!map["0"]) {
      map["0"] = { name: "未知礼物", icon: "", cost: 0, value: 0, from: 1, source: "fallback", isPaid: false, raw: null };
    }

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
    };

    const backpackCatalogStats = {
      totalPropKeys: propCfg.totalKeys || 0,
      roomBackpackGiftIds,
      overlaidFromPropCount,
      propConfigOk: Boolean(propMap),
    };

    const pack = { gifts: map, stats, backpackCatalog, backpackCatalogStats };
    giftListCache.set(roomId, { data: pack, fetchedAt: Date.now() });
    console.log(`[danmaku] Gift list for room ${roomId}: v3=${v3Count}, prop=${propCount}, backpack=${roomBackpackGiftIds}, total=${stats.totalCount}`);
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
      const ts = g.ts || 0;
      if (ts < startTs || ts > endTs) continue;
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
  return { lines, totalMatched, truncated };
}

/**
 * 统计时间窗内礼物：按 gfid / 用户聚合（与 collectGiftLinesInRange 同源数据）。
 * @returns {{ totalPieces: number, byGift: Record<string, { count: number, name: string }>, byUser: Record<string, { nn: string, count: number, gifts: Record<string, number> }> }}
 */
function aggregateGiftsInTimeRange(roomId, startTs, endTs) {
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
      const ts = g.ts || 0;
      if (ts < startTs || ts > endTs) continue;
      const gfid = String(g.gfid ?? "0");
      const amt = giftPiecesFromStoredRecord(g);
      totalPieces += amt;
      if (!byGift[gfid]) byGift[gfid] = { count: 0, name: "" };
      byGift[gfid].count += amt;
      const gfn = g.gfn || "";
      if (gfn) byGift[gfid].name = gfn;
      const uid = String(g.uid || "anon");
      if (!byUser[uid]) byUser[uid] = { nn: g.nn || "", count: 0, gifts: {} };
      if (g.nn) byUser[uid].nn = g.nn;
      byUser[uid].count += amt;
      byUser[uid].gifts[gfid] = (byUser[uid].gifts[gfid] || 0) + amt;
    }
  }
  return { totalPieces, byGift, byUser };
}

/** 日报数据概览：礼物金额拆分（catalog 已在 fetchGiftListPayload 中换算为「元」）
 * - 收入：isPaid 礼物的「主播侧分成价」value × 件数
 * - 付费数：同批礼物的「观众标价」cost × 件数；cost 为 0 时退回用 value（与旧版口径兼容）
 * - 付费人数：上述观众支出估算 > 0 的去重送礼 uid 数
 */
function computeGiftFinancialStats(roomId, startTs, endTs, catalogMap) {
  const { byGift, byUser } = aggregateGiftsInTimeRange(roomId, startTs, endTs);
  let streamerIncomeYuan = 0;
  let audiencePaidYuan = 0;
  for (const [gfid, v] of Object.entries(byGift)) {
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
  const { totalPieces, byGift, byUser } = aggregateGiftsInTimeRange(roomId, startTs, endTs);
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
  "qwen-max",
  "qwen-plus",
  "qwen-long",
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
    return "上游配额或限流（如 429）：请检查各平台额度；未设置 FMZ_TRIGGER_AI_MODEL 时会按 ai-agent 模型列表依次切换（例如 Gemini→OpenAI→千问）。也可手写：FMZ_TRIGGER_AI_MODEL=gemini-2.5-flash,qwen-plus,gpt-4o-mini";
  }
  if (isAiAgentUnreachableMessage(s)) {
    return `${s.length > 280 ? `${s.slice(0, 280)}…` : s} — ${chatAiAgentInternalUrlHint()}`;
  }
  return s.length > 420 ? `${s.slice(0, 420)}…` : s;
}
const MAX_AI_REPORT_ENTRIES = 500;

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
  if (/^弹幕\s+\d/.test(s)) return true;
  if (/^礼物\s*[｜|]\s*.+\d/.test(s)) return true;
  if (/^礼物\s+\d/.test(s)) return true;
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

  let catalogMap = null;
  try {
    const pack = await fetchGiftListPayload(roomId);
    catalogMap = pack && pack.gifts ? pack.gifts : null;
  } catch {
    /* catalog 失败仍可仅用归档摘要 */
  }
  const giftRankDigest = formatGiftRankDigestForAi(roomId, exp.startTs, exp.endTs, catalogMap);

  const info = await fetchRoomInfo(roomId);
  const roomDisplay = info?.owner_name ? `${info.owner_name} #${roomId}` : `#${roomId}`;
  const dataInfo = [
    "【数据信息】以下为导出窗口与抽样口径（仅供定性参考）。**客户端仪表盘顶部已展示结构化「数据概览」**；正文勿写「数据概览」小节或电报数字清单（勿列周期、房间、条数、付费笔数等）。下列数字行仅供理解样本规模，正文请从「概要信息」起笔。",
    `周期｜${exp.rangeLabel}`,
    `房间｜${roomDisplay}｜${roomId}`,
    `弹幕归档｜窗口内录制 chatmsg 共匹配 ${exp.danmakuMatched} 条｜下文至多摘录 ${exp.danmakuIncluded} 条｜截断 ${exp.danmakuTruncated ? "是" : "否"}`,
    `礼物归档｜窗口内匹配 ${exp.giftMatched} 条｜下文至多摘录 ${exp.giftIncluded} 条｜截断 ${exp.giftTruncated ? "是" : "否"}`,
    "另有「礼物排行与礼物类型摘要」须在后续小节引用解读；勿冒充外链实时榜。",
  ].join("\n");
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
  const excerpts = `--- 弹幕摘录 ---\n${exp.danmakuText}\n\n--- 礼物摘录 ---\n${exp.giftText}`;
  const userBlock = `${dataInfo}\n\n${rankBlock}\n\n【分析任务】\n${task}\n\n${excerpts}`;
  const systemContent =
    kind === "daily"
      ? "你是斗鱼直播间数据分析师，写中文日报。篇幅紧凑；正文一律常规字重，禁止粗体（不要用 HTML b/strong）。仪表盘顶部已有「数据概览」；你从「概要信息」定性写起，勿自写数据概览或电报数字清单。禁止 Markdown。礼物解读引用消息内排行摘要。文末输出 <<<FMZ_REPORT_META ... >>>。"
      : "你是斗鱼直播间数据分析师，写中文周报。篇幅紧凑；正文一律常规字重，禁止粗体（不要用 HTML b/strong）。仪表盘顶部已有「数据概览」；你从「概要信息」定性写起，勿自写数据概览或电报数字清单。禁止 Markdown。礼物解读引用消息内排行摘要。文末输出 <<<FMZ_REPORT_META ... >>>。";
  const modelCandidates = await resolveAiAgentTriggerModelCandidates();
  const rawAiText = await chatAiAgentAccumulateFirstAvailable(modelCandidates, [
    { role: "system", content: systemContent },
    { role: "user", content: userBlock },
  ]);
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

/** @param {import("http").IncomingMessage} req */
function headerPassword(req) {
  const h = req.headers["x-password"];
  if (Array.isArray(h)) return String(h[0] ?? "").trim();
  if (typeof h === "string") return h.trim();
  return "";
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
        // byUser: { uid: { nn, level, bnn, bl, brid, count, gifts: { gfid: count } } }
        const uid = g.uid || "anon";
        if (!stats.byUser[uid]) stats.byUser[uid] = { nn: g.nn || "", level: g.level || "", bnn: g.bnn || "", bl: g.bl || "", brid: g.brid || "", count: 0, gifts: {} };
        // Update user info from latest gift record (may have newer level/badge)
        if (g.nn) stats.byUser[uid].nn = g.nn;
        if (g.level) stats.byUser[uid].level = g.level;
        if (g.bnn) stats.byUser[uid].bnn = g.bnn;
        if (g.bl) stats.byUser[uid].bl = g.bl;
        if (g.brid) stats.byUser[uid].brid = g.brid;
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

server.listen(PORT, () => {
  console.log(`[douyu-danmaku] Server listening on http://127.0.0.1:${PORT}`);
  console.log(`[douyu-danmaku] AI report triggers → ai-agent-server ${AI_AGENT_INTERNAL_URL}`);

  // Auto-reconnect saved backend rooms on startup
  const savedRooms = loadSavedRooms();
  if (savedRooms.length > 0) {
    console.log(`[danmaku] Restoring ${savedRooms.length} saved room(s): ${savedRooms.join(", ")}`);
    for (const rid of savedRooms) {
      connectBackendRoom(rid);
    }
  }

  setInterval(tickScheduledTriggers, 15_000);
});
