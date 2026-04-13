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
const countRows = db.prepare(`SELECT COUNT(*) AS c FROM defense_snapshots`);

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

async function pullUpstream() {
  const fetchedAt = Date.now();
  let httpStatus = 0;
  let ok = 0;
  let payload = "";
  try {
    const r = await fetch(UPSTREAM, {
      headers: {
        "user-agent": "fmz-dashboard-defense-tower/1",
        accept: "application/json",
      },
    });
    httpStatus = r.status;
    const text = await r.text();
    payload = text;
    if (!r.ok) {
      ins.run({ fetched_at: fetchedAt, http_status: httpStatus, ok: 0, payload: text.slice(0, 8000) });
      return { fetchedAt, httpStatus, ok: false, error: `HTTP ${r.status}` };
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch (e) {
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
    ok = 1;
    ins.run({ fetched_at: fetchedAt, http_status: httpStatus, ok: 1, payload: text });
    return { fetchedAt, httpStatus, ok: true, parsed: j };
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
  if (!row?.payload) return null;
  try {
    const j = JSON.parse(row.payload);
    const first = j?.data?.[0];
    if (!first) return null;
    return { snapshotId: row.id, fetchedAt: row.fetched_at, report: first };
  } catch {
    return null;
  }
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
function scheduleAlignedPoll() {
  const align = () => {
    const now = new Date();
    const sec = now.getSeconds();
    const ms = now.getMilliseconds();
    let wait = (50 - sec) * 1000 - ms;
    if (wait < 2000) wait += 60_000;
    setTimeout(() => {
      lastPull = lastPull.then(() => pullUpstream());
      setInterval(() => {
        lastPull = lastPull.then(() => pullUpstream());
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
        json(res, 0, {
          upstream: UPSTREAM,
          secondsToSync: secondsToDataTick(),
          snapshot: parsed,
          historyCount: total,
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

  json(res, 404, { message: `no route ${pathname}` }, 404);
});

server.listen(PORT, BIND, () => {
  console.log(`fmz-defense-tower-server http://${BIND}:${PORT} db=${DB_PATH}`);
  void pullUpstream();
  scheduleAlignedPoll();
});
