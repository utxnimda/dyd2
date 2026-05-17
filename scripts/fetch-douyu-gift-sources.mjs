/**
 * 拉取斗鱼 prop_gift_config（全局 JSONP）与 gift v3 web list（按房间 rid）。
 *
 *   node scripts/fetch-douyu-gift-sources.mjs [rid]
 *
 * 默认 rid=9046690（与本仓库礼物归档示例一致）；可改成你的直播间短号。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, ".fmz-dev", "cache");

const PROP_GIFT_CONFIG_URL =
  "https://webconf.douyucdn.cn/resource/common/prop_gift_list/prop_gift_config.json";

/** 与 server/douyu-danmaku-server.mjs 同源：DYConfigCallback({ ... }) */
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

const rid = String(process.argv[2] ?? "9046690").trim() || "9046690";

mkdirSync(OUT_DIR, { recursive: true });

console.log(`[fetch-gifts] rid=${rid}`);
console.log(`[fetch-gifts] 输出目录: ${OUT_DIR}`);

// --- prop ---
const propResp = await fetch(PROP_GIFT_CONFIG_URL);
if (!propResp.ok) throw new Error(`prop HTTP ${propResp.status}`);
const propText = await propResp.text();

const propRawPath = join(OUT_DIR, "prop_gift_config.raw.txt");
writeFileSync(propRawPath, propText, "utf8");
console.log(`[fetch-gifts] ✓ 原始 JSONP → ${propRawPath}`);

const propRoot = parseDouyuConfigJsonpPayload(propText);
if (!propRoot) throw new Error("prop JSONP 解析失败");
const propParsedPath = join(OUT_DIR, "prop_gift_config.parsed.json");
writeFileSync(propParsedPath, JSON.stringify(propRoot, null, 2), "utf8");
const propKeys =
  propRoot.data && typeof propRoot.data === "object"
    ? Object.keys(propRoot.data).length
    : 0;
console.log(`[fetch-gifts] ✓ 解析后 JSON → ${propParsedPath}（data 条目约 ${propKeys}）`);

// --- v3 ---
const v3Url = `https://gift.douyucdn.cn/api/gift/v3/web/list?rid=${encodeURIComponent(rid)}`;
const v3Resp = await fetch(v3Url);
if (!v3Resp.ok) throw new Error(`v3 HTTP ${v3Resp.status}`);
const v3Json = await v3Resp.json();
const v3Path = join(OUT_DIR, `gift-v3-web-list-r${rid}.json`);
writeFileSync(v3Path, JSON.stringify(v3Json, null, 2), "utf8");
console.log(`[fetch-gifts] ✓ v3 → ${v3Path}`);
console.log("[fetch-gifts] 完成。");
