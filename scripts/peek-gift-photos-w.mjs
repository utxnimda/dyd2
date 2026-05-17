/**
 * 解析 webconf giftPhotos_w.json（JSONP），打印结构摘要。
 * 用法: node scripts/peek-gift-photos-w.mjs [本地文件路径可选]
 */
import { readFileSync } from "node:fs";
import https from "node:https";

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

async function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      })
      .on("error", reject);
  });
}

const url = "https://webconf.douyucdn.cn/resource/common/giftPhotos_w.json";
const pathArg = process.argv[2];
const text = pathArg ? readFileSync(pathArg, "utf-8") : await fetchText(url);

/** 根对象形如 { "data": {...}, "callback": "giftPhoto" }，应用整段 JSON.parse（比早停括号稳） */
function parseGiftPhotosJsonp(text) {
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

const root = parseGiftPhotosJsonp(text);
if (!root?.data) {
  console.error("解析失败");
  process.exit(1);
}

console.log("callback:", root.callback);
const d = root.data;
console.log("data 顶层键:", Object.keys(d));
console.log("tabInfos 分组数:", d.tabInfos?.length ?? 0);
const pg = d.pgInfos;
if (Array.isArray(pg)) {
  console.log("pgInfos 条数（数组）:", pg.length);
  console.log("示例:", JSON.stringify(pg[0]));
} else if (pg && typeof pg === "object") {
  const ids = Object.keys(pg);
  console.log("pgInfos 条目数（对象键）:", ids.length);
  const sid = ids[0];
  console.log("示例 pgId=", sid, JSON.stringify(pg[sid]));
}
if (d.skin && typeof d.skin === "object") {
  console.log("skin 条目数:", Object.keys(d.skin).length);
}
console.log("unlockStar:", d.unlockStar);
console.log("photoSwitch / allSwitch:", d.photoSwitch, d.allSwitch);
