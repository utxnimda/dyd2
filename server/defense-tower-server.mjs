/**
 * 大话三国攻城数据：定时拉取 tool.100if.com 周报 API，SQLite 快照落地。
 *
 * 环境变量：
 *   DEFENSE_TOWER_PORT=8788（默认）
 *   BIND=127.0.0.1（默认）
 *   FMZ_DATA_DIR=数据目录（默认 ./data，与 reactions 共用目录亦可）
 *   DEFENSE_UPSTREAM=https://tool.100if.com/douyuDefenseTower/api/v1/report/weekly
 */
import Database from "better-sqlite3";
import http from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEFENSE_TOWER_PORT || 8788);
const BIND = process.env.BIND || "127.0.0.1";
const DATA_DIR = process.env.FMZ_DATA_DIR || join(__dirname, "data");
const DB_PATH = process.env.FMZ_DEFENSE_DB_PATH || join(DATA_DIR, "defense_tower.db");
const UPSTREAM =
  process.env.DEFENSE_UPSTREAM ||
  "https://tool.100if.com/douyuDefenseTower/api/v1/report/weekly";

const SIEGE_CITY_NAMES = {
  "1": "洛阳",
  "2": "成都",
  "3": "建业",
  "4": "荆州",
  "5": "长安",
  "6": "许昌",
  "7": "汉中",
};

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS defense_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fetched_at INTEGER NOT NULL,
    http_status INTEGER,
    ok INTEGER NOT NULL DEFAULT 0,
    payload TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_defense_snapshots_fetched ON defense_snapshots(fetched_at DESC);

  CREATE TABLE IF NOT EXISTS defense_attack_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attack_at INTEGER NOT NULL,
    attack_time_label TEXT NOT NULL,
    city_id TEXT NOT NULL,
    first_seen_snapshot_id INTEGER NOT NULL,
    last_seen_snapshot_id INTEGER NOT NULL,
    last_seen_fetched_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_defense_attack_unique
    ON defense_attack_records(attack_at, city_id);
  CREATE INDEX IF NOT EXISTS idx_defense_attack_at
    ON defense_attack_records(attack_at DESC);
`);

const ins = db.prepare(
  `INSERT INTO defense_snapshots (fetched_at, http_status, ok, payload) VALUES (@fetched_at, @http_status, @ok, @payload)`,
);
const selLatestOk = db.prepare(
  `SELECT id, fetched_at, http_status, ok, payload FROM defense_snapshots WHERE ok = 1 ORDER BY id DESC LIMIT 1`,
);
const selHistory = db.prepare(
  `SELECT id, fetched_at, http_status, ok FROM defense_snapshots ORDER BY id DESC LIMIT ?`,
);
const selById = db.prepare(
  `SELECT id, fetched_at, http_status, ok, payload FROM defense_snapshots WHERE id = ?`,
);
const selAllOkRows = db.prepare(
  `SELECT id, fetched_at, payload FROM defense_snapshots WHERE ok = 1 ORDER BY id ASC`,
);
const countRows = db.prepare(`SELECT COUNT(*) AS c FROM defense_snapshots`);
const countAttackRows = db.prepare(`SELECT COUNT(*) AS c FROM defense_attack_records`);
const selRecentAttacks = db.prepare(
  `SELECT id, attack_at, attack_time_label, city_id, first_seen_snapshot_id, last_seen_snapshot_id, last_seen_fetched_at
   FROM defense_attack_records
   ORDER BY attack_at DESC, id DESC
   LIMIT ?`,
);
const upsertAttack = db.prepare(
  `INSERT INTO defense_attack_records (
      attack_at,
      attack_time_label,
      city_id,
      first_seen_snapshot_id,
      last_seen_snapshot_id,
      last_seen_fetched_at
    ) VALUES (
      @attack_at,
      @attack_time_label,
      @city_id,
      @snapshot_id,
      @snapshot_id,
      @fetched_at
    )
    ON CONFLICT(attack_at, city_id) DO UPDATE SET
      last_seen_snapshot_id = excluded.last_seen_snapshot_id,
      last_seen_fetched_at = excluded.last_seen_fetched_at`,
);
const upsertAttackBatch = db.transaction((records) => {
  for (const record of records) upsertAttack.run(record);
});

// ====== 预测算法 ======

const PRED_CITY_IDS = ["1", "2", "3", "4"]; // 洛阳、成都、建业、荆州

const selAllAttacksByCityDesc = db.prepare(
  `SELECT attack_at FROM defense_attack_records WHERE city_id = ? ORDER BY attack_at DESC`,
);

const selAllAttacksDesc = db.prepare(
  `SELECT city_id, attack_at FROM defense_attack_records ORDER BY attack_at DESC LIMIT 200`,
);

/**
 * 从间隔数组拟合韦布尔参数 (k, lambda)
 * 用 p50 和 p90 两点法：
 *   k = ln(ln(1/(1-0.5)) / ln(1/(1-0.9))) / ln(p50 / p90)  ... 但要用绝对值
 * 简化为：k = ln(-ln(0.5) / -ln(0.1)) / ln(p50 / p90) = ln(0.6931/2.3026) / ln(p50/p90)
 */
function fitWeibull(intervals) {
  if (intervals.length < 5) return { k: 1.2, lambda: 20, pity: 80 };
  const sorted = [...intervals].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const max = sorted[sorted.length - 1];

  if (p50 <= 0 || p90 <= 0 || p50 >= p90) return { k: 1.2, lambda: p50 || 20, pity: max || 80 };

  // 二点拟合
  const ln1 = Math.log(-Math.log(1 - 0.5)); // ln(ln(2)) ≈ -0.3665
  const ln2 = Math.log(-Math.log(1 - 0.9)); // ln(ln(10/1)) ≈ 0.8340
  const k = Math.max(0.5, Math.min(5, (ln2 - ln1) / Math.log(p90 / p50)));
  // lambda from p50: p50 = lambda * (-ln(0.5))^(1/k)
  const lambda = Math.max(1, p50 / Math.pow(-Math.log(0.5), 1 / k));
  const pity = Math.max(max, lambda * 3);

  return { k, lambda, pity: Math.round(pity) };
}

function weibullCDF(t, k, lambda) {
  if (t <= 0) return 0;
  return 1 - Math.exp(-Math.pow(t / lambda, k));
}

/** 条件概率 P(T <= s+dt | T > s)，叠加保底加速 */
function conditionalProb(s, dt, k, lambda, pity) {
  const base = 1 - Math.exp(
    -(Math.pow((s + dt) / lambda, k) - Math.pow(Math.max(0, s) / lambda, k)),
  );
  const pityRatio = Math.min(1, s / pity);
  const pityBoost = pityRatio > 0.7
    ? Math.pow((pityRatio - 0.7) / 0.3, 2) * (1 - base)
    : 0;
  return Math.min(1, base + pityBoost);
}

/** 二分找 50% 概率对应的 ETA */
function findEta50(s, k, lambda, pity) {
  let lo = 0;
  let hi = Math.max(1, pity - s + 10);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (conditionalProb(s, mid, k, lambda, pity) >= 0.5) hi = mid;
    else lo = mid;
  }
  return Math.round(hi);
}

function computePrediction() {
  const now = Date.now();
  const nowDate = new Date(now);
  const nowMinute = nowDate.getMinutes();

  // 小城连打检测
  const recentAll = selAllAttacksDesc.all();
  let smallCityStreak = 0;
  for (const r of recentAll) {
    if (["4", "5", "6", "7"].includes(r.city_id)) smallCityStreak++;
    else break;
  }
  const lastCityId = recentAll.length > 0 ? recentAll[0].city_id : null;

  // 转移概率（下一城预测）
  const transCount = {};
  let transTotal = 0;
  if (lastCityId) {
    for (let i = 1; i < recentAll.length; i++) {
      if (recentAll[i].city_id === lastCityId) {
        const nextId = recentAll[i - 1].city_id;
        transCount[nextId] = (transCount[nextId] || 0) + 1;
        transTotal++;
      }
    }
  }
  const nextCityProbs = Object.entries(transCount)
    .map(([cityId, count]) => ({
      cityId,
      cityName: SIEGE_CITY_NAMES[cityId] ?? cityId,
      count,
      prob: transTotal > 0 ? count / transTotal : 0,
      pct: transTotal > 0 ? ((count / transTotal) * 100).toFixed(1) : "0",
    }))
    .sort((a, b) => b.prob - a.prob);

  // 逐城预测
  const cities = PRED_CITY_IDS.map((cityId) => {
    const cityName = SIEGE_CITY_NAMES[cityId] ?? cityId;
    const allRows = selAllAttacksByCityDesc.all(cityId);

    // 计算间隔
    const intervals = [];
    for (let i = 0; i < allRows.length - 1; i++) {
      const gap = Math.round((allRows[i].attack_at - allRows[i + 1].attack_at) / 60000);
      if (gap > 0 && gap < 500) intervals.push(gap);
    }

    // 动态拟合韦布尔
    const wp = fitWeibull(intervals);

    // 距上次
    let sinceLastMin = null;
    if (allRows.length > 0) {
      sinceLastMin = Math.round((now - allRows[0].attack_at) / 60000);
    }
    const s = sinceLastMin ?? 0;
    const justAppeared = lastCityId === cityId;
    const pityProgress = sinceLastMin != null ? Math.min(1, s / wp.pity) : 0;

    // 条件概率
    let prob5min = conditionalProb(s, 5, wp.k, wp.lambda, wp.pity);
    if (justAppeared) prob5min *= 0.05; // 连击抑制
    if (smallCityStreak >= 6 && !justAppeared) {
      prob5min = Math.min(1, prob5min * (1 + Math.min(0.5, smallCityStreak * 0.04)));
    }

    // 50% ETA
    let eta50 = sinceLastMin != null ? findEta50(s, wp.k, wp.lambda, wp.pity) : null;
    if (justAppeared && eta50 != null) {
      eta50 = Math.max(eta50, Math.round(wp.lambda * 0.7));
    }
    if (smallCityStreak >= 6 && !justAppeared && eta50 != null) {
      eta50 = Math.max(0, eta50 - Math.min(5, Math.floor(smallCityStreak / 3)));
    }

    // 预测时间点（eta50 附近 + 热力分钟）
    // 热力分钟从最新快照的 report_minute_tower 取
    const latestSnap = selLatestOk.get();
    const report = parseWeeklyPayload(latestSnap?.payload);
    const tower = report?.report_minute_tower?.[cityId];
    const hotMinutes = [];
    if (tower) {
      for (const [m, c] of Object.entries(tower)) {
        if (Number(c) > 0) hotMinutes.push({ minute: Number(m), count: Number(c) });
      }
      hotMinutes.sort((a, b) => b.count - a.count);
    }
    const hotSet = new Set(hotMinutes.slice(0, 12).map((h) => h.minute));

    const predictedTimes = [];
    const etaBase = eta50 ?? Math.round(wp.lambda);

    // 50% ETA 时间
    const t50 = new Date(now + etaBase * 60000);
    predictedTimes.push(
      `${String(t50.getHours()).padStart(2, "0")}:${String(t50.getMinutes()).padStart(2, "0")}`,
    );

    // 热力命中时间
    for (let off = Math.max(0, etaBase - 8); off <= etaBase + 20 && predictedTimes.length < 4; off++) {
      const t = new Date(now + off * 60000);
      const m = t.getMinutes();
      if (hotSet.has(m)) {
        const label = `${String(t.getHours()).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
        if (!predictedTimes.includes(label)) predictedTimes.push(label);
      }
    }

    // 等级
    let level = "none";
    const nearbyHot = hotMinutes.slice(0, 8).some((h) => {
      const diff = Math.abs(h.minute - nowMinute);
      return diff <= 3 || diff >= 57;
    });
    if (justAppeared) {
      level = "none";
    } else if (prob5min >= 0.4 || pityProgress >= 0.85) {
      level = "high";
    } else if (prob5min >= 0.2) {
      level = nearbyHot ? "high" : "medium";
    } else if (prob5min >= 0.08) {
      level = nearbyHot ? "medium" : "low";
    }

    return {
      cityId,
      cityName,
      weibull: { k: Math.round(wp.k * 100) / 100, lambda: Math.round(wp.lambda), pity: wp.pity },
      sinceLastMin,
      justAppeared,
      pityProgress: Math.round(pityProgress * 1000) / 1000,
      prob5min: Math.round(prob5min * 10000) / 10000,
      eta50,
      level,
      predictedTimes,
      hotMinutes: hotMinutes.slice(0, 5),
      sampleCount: intervals.length,
    };
  });

  return {
    now,
    smallCityStreak,
    lastCityId,
    lastCityName: lastCityId ? (SIEGE_CITY_NAMES[lastCityId] ?? lastCityId) : null,
    nextCityProbs,
    cities,
  };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(res, code, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...CORS,
  });
  res.end(JSON.stringify({ code, data }));
}

function apiPathname(rawPath) {
  let p = rawPath || "/";
  const prefix = "/__fmz_defense";
  if (p === prefix || p === `${prefix}/`) return "/";
  if (p.startsWith(`${prefix}/`)) p = p.slice(prefix.length);
  return p || "/";
}

function parseWeeklyPayload(payload) {
  if (!payload) return null;
  try {
    const j = JSON.parse(payload);
    const first = j?.data?.[0];
    return first && typeof first === "object" ? first : null;
  } catch {
    return null;
  }
}

function normalizeAttackAt(fetchedAt, timeLabel) {
  const m = String(timeLabel).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return null;
  }
  const d = new Date(fetchedAt);
  d.setHours(hh, mm, 0, 0);
  let attackAt = d.getTime();
  if (attackAt > fetchedAt + 2 * 60_000) {
    attackAt -= 24 * 60 * 60_000;
  }
  if (fetchedAt - attackAt > 36 * 60 * 60_000) return null;
  return attackAt;
}

function extractAttackRecords(report, snapshotId, fetchedAt) {
  const rows = report?.report_minute;
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const pairs = Object.entries(row);
    if (pairs.length === 0) continue;
    const [timeLabel, rawCityId] = pairs[0];
    const cityId = String(rawCityId).trim();
    if (!timeLabel || !SIEGE_CITY_NAMES[cityId]) continue;
    const attackAt = normalizeAttackAt(fetchedAt, timeLabel);
    if (attackAt == null) continue;
    const dedupeKey = `${attackAt}|${cityId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      attack_at: attackAt,
      attack_time_label: timeLabel,
      city_id: cityId,
      snapshot_id: snapshotId,
      fetched_at: fetchedAt,
    });
  }
  return out;
}

function persistAttackRecordsFromReport(report, snapshotId, fetchedAt) {
  const records = extractAttackRecords(report, snapshotId, fetchedAt);
  if (!records.length) return 0;
  upsertAttackBatch(records);
  return records.length;
}

function backfillAttackRecords() {
  const rows = selAllOkRows.all();
  for (const row of rows) {
    const report = parseWeeklyPayload(row.payload);
    if (!report) continue;
    persistAttackRecordsFromReport(report, row.id, row.fetched_at);
  }
}

async function pullUpstream() {
  const fetchedAt = Date.now();
  let httpStatus = 0;
  try {
    const r = await fetch(UPSTREAM, {
      headers: {
        "user-agent": "fmz-dashboard-defense-tower/1",
        accept: "application/json",
      },
    });
    httpStatus = r.status;
    const text = await r.text();
    if (!r.ok) {
      ins.run({ fetched_at: fetchedAt, http_status: httpStatus, ok: 0, payload: text.slice(0, 8000) });
      return { fetchedAt, httpStatus, ok: false, error: `HTTP ${r.status}` };
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      ins.run({ fetched_at: fetchedAt, http_status: httpStatus, ok: 0, payload: text.slice(0, 8000) });
      return { fetchedAt, httpStatus, ok: false, error: "invalid json" };
    }
    if (!j?.status || j.status.code !== 0) {
      ins.run({
        fetched_at: fetchedAt,
        http_status: httpStatus,
        ok: 0,
        payload: text.slice(0, 8000),
      });
      return { fetchedAt, httpStatus, ok: false, error: j?.status?.message || "upstream business error" };
    }
    const info = ins.run({ fetched_at: fetchedAt, http_status: httpStatus, ok: 1, payload: text });
    const snapshotId = Number(info.lastInsertRowid);
    const report = j?.data?.[0] ?? null;
    const persistedAttackCount = persistAttackRecordsFromReport(report, snapshotId, fetchedAt);
    return { fetchedAt, httpStatus, ok: true, parsed: j, snapshotId, persistedAttackCount };
  } catch (e) {
    ins.run({
      fetched_at: fetchedAt,
      http_status: httpStatus,
      ok: 0,
      payload: String(e).slice(0, 4000),
    });
    return { fetchedAt, httpStatus, ok: false, error: String(e) };
  }
}

function parseWeeklyFromRow(row) {
  const report = parseWeeklyPayload(row?.payload);
  if (!report) return null;
  return { snapshotId: row.id, fetchedAt: row.fetched_at, report };
}

/** 与源站一致：有实时链路时用 48s，否则 55s（此处无 SSE，固定 48s 对齐其公告） */
function secondsToDataTick() {
  const sec = new Date().getSeconds();
  const target = 48;
  let rem = target - sec;
  if (rem < 0) rem += 60;
  return rem;
}

let lastPull = Promise.resolve();
let lastNewMinuteLabel = ""; // 上次成功拉到的最新分钟标签

function currentMinuteLabel() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 拉取一次，如果没拿到当前分钟的新数据，每2秒重试最多10次 */
async function pullWithRetry() {
  const targetLabel = currentMinuteLabel();
  for (let attempt = 0; attempt < 10; attempt++) {
    await pullUpstream();
    // 检查最新记录是否是当前分钟的
    const latest = selRecentAttacks.all(1);
    if (latest.length > 0 && latest[0].attack_time_label === targetLabel) {
      lastNewMinuteLabel = targetLabel;
      return;
    }
    if (attempt < 9) {
      await new Promise((r) => setTimeout(r, 2000)); // 等2秒后重试
    }
  }
}

function scheduleAlignedPoll() {
  const align = () => {
    const now = new Date();
    const sec = now.getSeconds();
    const ms = now.getMilliseconds();
    // 对齐到第48秒
    let wait = (48 - sec) * 1000 - ms;
    if (wait < 2000) wait += 60_000;
    setTimeout(() => {
      lastPull = lastPull.then(() => pullWithRetry());
      setInterval(() => {
        lastPull = lastPull.then(() => pullWithRetry());
      }, 60_000);
    }, wait);
  };
  align();
}

const server = http.createServer((req, res) => {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const u = new URL(req.url || "/", `http://${host}`);
  const pathname = apiPathname(u.pathname);

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Cache-Control": "no-store", ...CORS });
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    json(res, 0, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/overview") {
    void (async () => {
      try {
        let row = selLatestOk.get();
        if (!row) {
          await pullUpstream();
          row = selLatestOk.get();
        }
        const parsed = parseWeeklyFromRow(row);
        const total = countRows.get().c;
        const attackRecordCount = countAttackRows.get().c;
        json(res, 0, {
          upstream: UPSTREAM,
          secondsToSync: secondsToDataTick(),
          snapshot: parsed,
          historyCount: total,
          attackRecordCount,
          lastRow: row
            ? {
                id: row.id,
                fetchedAt: row.fetched_at,
                httpStatus: row.http_status,
                ok: row.ok,
              }
            : null,
        });
      } catch (e) {
        json(res, 500, { message: String(e) }, 500);
      }
    })();
    return;
  }

  if (req.method === "GET" && pathname === "/api/history") {
    const lim = Math.min(500, Math.max(1, Number(u.searchParams.get("limit")) || 80));
    const rows = selHistory.all(lim);
    json(res, 0, { rows });
    return;
  }

  if (req.method === "GET" && pathname === "/api/recent-attacks") {
    const lim = Math.min(1500, Math.max(1, Number(u.searchParams.get("limit")) || 60));
    const rows = selRecentAttacks.all(lim).map((row) => ({
      ...row,
      city_name: SIEGE_CITY_NAMES[row.city_id] ?? row.city_id,
    }));
    json(res, 0, { rows, totalCount: countAttackRows.get().c });
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/snapshot/")) {
    const id = Number(pathname.replace("/api/snapshot/", ""));
    if (!Number.isFinite(id) || id <= 0) {
      json(res, 400, { message: "bad id" }, 400);
      return;
    }
    const row = selById.get(id);
    if (!row) {
      json(res, 404, { message: "not found" }, 404);
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      parsed = null;
    }
    json(res, 0, { row, parsed });
    return;
  }

  if (req.method === "POST" && pathname === "/api/refresh") {
    pullUpstream()
      .then((r) => json(res, 0, r))
      .catch((e) => json(res, 500, { message: String(e) }, 500));
    return;
  }

  if (req.method === "GET" && pathname === "/api/prediction") {
    try {
      const predictionData = computePrediction();
      json(res, 0, predictionData);
    } catch (e) {
      json(res, 500, { message: String(e) }, 500);
    }
    return;
  }

  json(res, 404, { message: `no route ${pathname}` }, 404);
});

server.listen(PORT, BIND, () => {
  console.log(`fmz-defense-tower-server http://${BIND}:${PORT} db=${DB_PATH}`);
  backfillAttackRecords();
  void pullUpstream();
  scheduleAlignedPoll();
});
