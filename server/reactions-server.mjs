/**
 * 赞 / 踩 计数服务：SQLite 持久化，供 fmz-dashboard 前端通过同源 /__fmz_reactions 反代访问。
 *
 * 启动（在 server 目录已 npm install 后）：
 *   node reactions-server.mjs
 * 环境变量：
 *   PORT=8787（默认）
 *   BIND=127.0.0.1（默认；需外网直连可设 0.0.0.0，建议仍走 Nginx）
 *   FMZ_REACTIONS_SECRET=可选，与前端设置里「赞踩 API 密钥」一致
 *   FMZ_DATA_DIR=数据目录（默认 ./data）
 *   FMZ_REACTION_COOLDOWN_MS=同一 IP对同一成员连续点赞/踩最短间隔（默认 2500）
 *   FMZ_REACTION_IP_WINDOW_MS=全局限流统计窗口（默认 60000）
 *   FMZ_REACTION_IP_MAX=每 IP 每窗口内最多多少次 inc（默认 48）
 */
import Database from "better-sqlite3";
import http from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const BIND = process.env.BIND || "127.0.0.1";
const SECRET = process.env.FMZ_REACTIONS_SECRET || "";
const DATA_DIR = process.env.FMZ_DATA_DIR || join(__dirname, "data");
const DB_PATH = process.env.FMZ_DB_PATH || join(DATA_DIR, "reactions.db");
const MEMBER_COOLDOWN_MS = Number(process.env.FMZ_REACTION_COOLDOWN_MS || 2500);
const IP_WINDOW_MS = Number(process.env.FMZ_REACTION_IP_WINDOW_MS || 60_000);
const IP_MAX_INC = Number(process.env.FMZ_REACTION_IP_MAX || 48);

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

/** 同一 IP + 项目 + 成员：最短间隔（防连点、多标签略快于客户端时仍挡住） */
const lastMemberInc = new Map();
/** 每 IP 滑动窗口内 inc 次数 */
const ipIncTimestamps = new Map();

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.trim()) {
    return xf.split(",")[0].trim().slice(0, 96);
  }
  return String(req.socket.remoteAddress || "unknown").slice(0, 96);
}

function pruneIpList(ip) {
  const now = Date.now();
  let arr = ipIncTimestamps.get(ip);
  if (!arr) {
    arr = [];
    ipIncTimestamps.set(ip, arr);
  }
  while (arr.length > 0 && arr[0] < now - IP_WINDOW_MS) arr.shift();
  return arr;
}

function peekIpAllow(ip) {
  const arr = pruneIpList(ip);
  return arr.length < IP_MAX_INC;
}

function recordIpInc(ip) {
  const arr = pruneIpList(ip);
  arr.push(Date.now());
}

const _pruneTimer = setInterval(() => {
  const cut = Date.now() - Math.max(IP_WINDOW_MS * 2, MEMBER_COOLDOWN_MS * 3);
  for (const [k, t] of lastMemberInc) {
    if (t < cut) lastMemberInc.delete(k);
  }
  for (const [ip, arr] of ipIncTimestamps) {
    const now = Date.now();
    const next = arr.filter((x) => x > now - IP_WINDOW_MS);
    if (next.length === 0) ipIncTimestamps.delete(ip);
    else ipIncTimestamps.set(ip, next);
  }
}, 120_000);
if (typeof _pruneTimer.unref === "function") _pruneTimer.unref();

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS member_votes (
    project_key TEXT NOT NULL,
    member_id TEXT NOT NULL,
    likes INTEGER NOT NULL DEFAULT 0,
    dislikes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_key, member_id)
  );
`);

const selAll = db.prepare(
  `SELECT member_id, likes, dislikes FROM member_votes WHERE project_key = ?`,
);
const upsertLike = db.prepare(`
  INSERT INTO member_votes (project_key, member_id, likes, dislikes)
  VALUES (@project_key, @member_id, 1, 0)
  ON CONFLICT(project_key, member_id) DO UPDATE SET likes = likes + 1
`);
const upsertDis = db.prepare(`
  INSERT INTO member_votes (project_key, member_id, likes, dislikes)
  VALUES (@project_key, @member_id, 0, 1)
  ON CONFLICT(project_key, member_id) DO UPDATE SET dislikes = dislikes + 1
`);
const selOne = db.prepare(
  `SELECT likes, dislikes FROM member_votes WHERE project_key = ? AND member_id = ?`,
);

/** 允许面板填「直连 http://127.0.0.1:8787」时与 :5173 不同源仍能请求（勿在公网 0.0.0.0 暴露且无密钥时依赖此条） */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-FMZ-Reactions-Secret",
  "Access-Control-Max-Age": "86400",
};

function json(res, code, data, status = 200) {
  const body = JSON.stringify({ code, data });
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...CORS,
  });
  res.end(body);
}

function checkSecret(req) {
  if (!SECRET) return true;
  const h = req.headers["x-fmz-reactions-secret"];
  return h === SECRET;
}

/** Nginx 若写成 proxy_pass http://127.0.0.1:8787;（无尾斜杠）会把完整路径转发成 /__fmz_reactions/api/...，此处剥掉前缀以兼容 */
function apiPathname(rawPath) {
  let p = rawPath || "/";
  const prefix = "/__fmz_reactions";
  if (p === prefix || p === `${prefix}/`) return "/";
  if (p.startsWith(`${prefix}/`)) p = p.slice(prefix.length);
  return p || "/";
}

const server = http.createServer((req, res) => {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const u = new URL(req.url || "/", `http://${host}`);
  const pathname = apiPathname(u.pathname);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Cache-Control": "no-store",
      Allow: "GET, POST, OPTIONS",
      ...CORS,
    });
    res.end();
    return;
  }

  if (!checkSecret(req)) {
    json(
      res,
      403,
      { message: "密钥不匹配：请核对服务器 FMZ_REACTIONS_SECRET 与面板「赞踩 API 密钥」" },
      403,
    );
    return;
  }

  if (req.method === "GET" && pathname === "/api/votes") {
    const project = u.searchParams.get("project") || "";
    if (!project) {
      json(res, 400, { message: "missing project" }, 400);
      return;
    }
    const likes = {};
    const dislikes = {};
    for (const row of selAll.all(project)) {
      if (row.likes > 0) likes[row.member_id] = row.likes;
      if (row.dislikes > 0) dislikes[row.member_id] = row.dislikes;
    }
    json(res, 0, { likes, dislikes });
    return;
  }

  if (req.method === "POST" && pathname === "/api/votes/inc") {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("error", () => {
      res.writeHead(400, { ...CORS });
      res.end();
    });
    req.on("end", () => {
      try {
        const j = JSON.parse(body || "{}");
        const project = String(j.project || "");
        const memberId = String(j.memberId || "");
        const kind = j.kind === "dislike" ? "dislike" : "like";
        if (!project || !memberId) {
          json(res, 400, { message: "project and memberId required" }, 400);
          return;
        }

        const ip = clientIp(req);
        if (!peekIpAllow(ip)) {
          json(
            res,
            429,
            {
              message: "当前网络点赞/踩过于频繁，请约 1 分钟后再试",
              retryAfterMs: IP_WINDOW_MS,
            },
            429,
          );
          return;
        }

        const rk = `${ip}|${project}|${memberId}`;
        const now = Date.now();
        const prevTs = lastMemberInc.get(rk);
        if (prevTs != null && now - prevTs < MEMBER_COOLDOWN_MS) {
          json(
            res,
            429,
            {
              message: "点击太频繁，请稍后再试",
              retryAfterMs: MEMBER_COOLDOWN_MS - (now - prevTs),
            },
            429,
          );
          return;
        }
        lastMemberInc.set(rk, now);
        recordIpInc(ip);

        const run = kind === "like" ? upsertLike : upsertDis;
        try {
          run.run({ project_key: project, member_id: memberId });
        } catch (dbErr) {
          if (prevTs === undefined) lastMemberInc.delete(rk);
          else lastMemberInc.set(rk, prevTs);
          const arr = ipIncTimestamps.get(ip);
          if (arr?.length) arr.pop();
          json(res, 500, { message: String(dbErr) }, 500);
          return;
        }
        const row = selOne.get(project, memberId);
        json(res, 0, {
          memberId,
          likes: row?.likes ?? 0,
          dislikes: row?.dislikes ?? 0,
        });
      } catch (e) {
        json(res, 500, { message: String(e) }, 500);
      }
    });
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    json(res, 0, { ok: true });
    return;
  }

  json(
    res,
    404,
    {
      message: `无此接口 ${pathname}。若路径含 /__fmz_reactions，请检查 Nginx：location /__fmz_reactions/ { proxy_pass http://127.0.0.1:8787/; }（8787 后必须有 /）`,
    },
    404,
  );
});

server.listen(PORT, BIND, () => {
  console.log(`fmz-reactions-server http://${BIND}:${PORT} db=${DB_PATH}`);
});
