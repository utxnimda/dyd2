import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 开发：仓库 shared/；部署：与同目录 runnable *.mjs 并列的 fmz-static.json（见 pack-release）。 */
function resolveFmzStaticPath() {
  const besideRunner = join(__dirname, "fmz-static.json");
  const repoShared = join(__dirname, "..", "shared", "fmz-static.json");
  if (existsSync(besideRunner)) return besideRunner;
  if (existsSync(repoShared)) return repoShared;
  return besideRunner;
}

let cacheParsed;
/** @type {number} */
let cacheMtime = -1;

/**
 * fmz-static.json 的磁盘 mtime（ms），用于礼单等缓存失效；文件不存在时为 0。
 */
export function fmzStaticFileMtimeMs() {
  try {
    const p = resolveFmzStaticPath();
    if (!existsSync(p)) return 0;
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * FMZ 全仓静态配置（与 SPA 同源：仓库内 shared/fmz-static.json，线上可与 *.mjs 同目录）。
 * 随配置文件 mtime 自动重读。
 */
export function loadFmzStatic() {
  const path = resolveFmzStaticPath();
  let mt = 0;
  try {
    if (existsSync(path)) mt = statSync(path).mtimeMs;
  } catch {
    mt = 0;
  }
  if (cacheParsed !== undefined && mt === cacheMtime) return cacheParsed;
  try {
    const raw = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
    cacheParsed = JSON.parse(raw);
  } catch (e) {
    console.error(`[fmz-static] JSON 解析失败（不使用缓存快照）：${path} → ${e.message}`);
    cacheParsed = undefined;
    cacheMtime = -1;
    return {};
  }
  cacheMtime = mt;
  return cacheParsed;
}

/**
 * 合并礼单时读取战功保底条目：**不走 loadFmzStatic 快照**，避免首次解析失败写入 `{}` 后，
 * 文件修好但 mtime 未变导致永久短路；亦可绕过与其它缓存不一致的边缘情况。
 */
export function readDouyuFallbackGiftMetricsFresh() {
  const path = resolveFmzStaticPath();
  try {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
    const j = JSON.parse(raw);
    return Array.isArray(j?.douyuFallbackGiftMetrics) ? j.douyuFallbackGiftMetrics : [];
  } catch (e) {
    console.error(`[fmz-static] douyuFallbackGiftMetrics 直读失败（${path}）：${e.message}`);
    return [];
  }
}

export function fmzStaticConfigPath() {
  return resolveFmzStaticPath();
}
