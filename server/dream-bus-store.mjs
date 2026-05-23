/**
 * 梦幻巴士（dream_bus_session）到站记录与静态配置缓存。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data", "danmaku");
const RECORDS_PATH = join(DATA_DIR, "dream-bus-records.json");
const DREAM_BUS_W_URL =
  "https://wconf.douyucdn.cn/resource/common/dream_bus_w.json";
const MAX_RECORDS = 10_000;
const CONFIG_TTL_MS = 300_000;

/** @type {{ sessionId: string, hitStation: number, leftTime: number, status: string, roomId: string, updatedAt: number } | null} */
let liveState = null;
/** @type {Array<{ sessionId: string, hitStation: number, createTime: number, recordedAt: number, roomId: string }>} */
let records = [];
/** @type {{ data: object, fetchedAt: number } | null} */
let configCache = null;
/** @type {string} */
let lastPersistedSessionId = "";

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function loadDreamBusRecordsFromDisk() {
  ensureDataDir();
  try {
    if (!existsSync(RECORDS_PATH)) {
      records = [];
      return;
    }
    const j = JSON.parse(readFileSync(RECORDS_PATH, "utf-8"));
    records = Array.isArray(j?.records) ? j.records : Array.isArray(j) ? j : [];
    if (records.length > MAX_RECORDS) {
      records = records.slice(-MAX_RECORDS);
      saveDreamBusRecordsToDisk();
    }
    lastPersistedSessionId = records[0]?.sessionId ?? "";
  } catch {
    records = [];
  }
}

function saveDreamBusRecordsToDisk() {
  ensureDataDir();
  writeFileSync(
    RECORDS_PATH,
    JSON.stringify({ records, updatedAt: Date.now() }, null, 2),
    "utf-8",
  );
}

function sessionTimeLabel(sessionId) {
  const s = String(sessionId || "");
  if (s.length < 12) return s;
  return `${s.slice(8, 10)}:${s.slice(10, 12)}`;
}

function appendRecordIfNew(roomId, sessionId, hitStation, createTime) {
  const sid = String(sessionId || "").trim();
  const station = Number(hitStation);
  if (!sid || !Number.isFinite(station) || station <= 0) return null;
  if (sid === lastPersistedSessionId) return null;
  if (records.some((r) => r.sessionId === sid)) {
    lastPersistedSessionId = sid;
    return null;
  }
  const entry = {
    sessionId: sid,
    hitStation: station,
    createTime: Number(createTime) || Math.floor(Date.now() / 1000),
    recordedAt: Date.now(),
    roomId: String(roomId || "").trim(),
    timeLabel: sessionTimeLabel(sid),
  };
  records.unshift(entry);
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
  lastPersistedSessionId = sid;
  saveDreamBusRecordsToDisk();
  return entry;
}

/**
 * @param {string} roomId
 * @param {Record<string, string>} msg STT dream_bus_session
 * @returns {{ live: object, record: object|null, changed: boolean }}
 */
export function ingestDreamBusSession(roomId, msg) {
  const sessionId = String(msg.sessionId ?? "").trim();
  const hitStation = Number(msg.hitStation ?? 0);
  const leftTime = Number(msg.leftTime ?? 0);
  const status = String(msg.status ?? "").trim();
  const createTime = Number(msg.createTime ?? 0) || Math.floor(Date.now() / 1000);

  const prev = liveState?.sessionId;
  liveState = {
    sessionId,
    hitStation: Number.isFinite(hitStation) ? hitStation : 0,
    leftTime: Number.isFinite(leftTime) ? leftTime : 0,
    status,
    roomId: String(roomId || "").trim(),
    updatedAt: Date.now(),
    createTime,
  };

  let record = null;
  if (status === "2" && hitStation > 0) {
    record = appendRecordIfNew(roomId, sessionId, hitStation, createTime);
  }

  return {
    live: { ...liveState },
    record,
    changed: prev !== sessionId || record != null,
  };
}

export function getDreamBusLiveState() {
  return liveState ? { ...liveState } : null;
}

/** 服务端计算的 live 快照（含剩余秒数，供客户端心跳校准） */
export function getDreamBusLiveSnapshot() {
  const serverNow = Date.now();
  if (!liveState) {
    return { live: null, serverNow, leftRemaining: 0, phaseEndsAt: serverNow };
  }
  const updatedAt = Number(liveState.updatedAt) || 0;
  const leftTime = Number(liveState.leftTime) || 0;
  const elapsed =
    updatedAt > 0 ? Math.max(0, (serverNow - updatedAt) / 1000) : 0;
  const leftRemaining = Math.max(0, leftTime - elapsed);
  return {
    live: { ...liveState },
    serverNow,
    leftRemaining,
    phaseEndsAt: serverNow + leftRemaining * 1000,
  };
}

export function getDreamBusRecords(limit = 1440) {
  const n = Math.min(MAX_RECORDS, Math.max(1, Number(limit) || 1440));
  return records.slice(0, n);
}

export async function getDreamBusConfigCached() {
  if (configCache && Date.now() - configCache.fetchedAt < CONFIG_TTL_MS) {
    return configCache;
  }
  const resp = await fetch(DREAM_BUS_W_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; fmz-dashboard)" },
  });
  if (!resp.ok) throw new Error(`dream_bus_w HTTP ${resp.status}`);
  const json = await resp.json();
  configCache = { data: json?.data ?? json, fetchedAt: Date.now() };
  return configCache;
}

/** 本地无记录时，从公开 stationRecord 拉一批历史到站（仅启动时一次）。 */
export async function bootstrapDreamBusRecordsFromHttp(rid = "9046690") {
  if (records.length > 0) return 0;
  try {
    const resp = await fetch(
      `https://www.douyu.com/japi/activity-gift/web/dreamBus/stationRecord?rid=${encodeURIComponent(rid)}`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; fmz-dashboard)" } },
    );
    if (!resp.ok) return 0;
    const j = await resp.json();
    if (!Array.isArray(j?.data)) return 0;
    let n = 0;
    for (const row of [...j.data].reverse()) {
      const hit = appendRecordIfNew(rid, row.sessionId, row.hitStation, row.createTime);
      if (hit) n++;
    }
    return n;
  } catch {
    return 0;
  }
}
