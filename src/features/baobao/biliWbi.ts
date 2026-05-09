import md5 from "md5";

/** 与 bilibili-API-collect 文档一致：WBI mixin 重排表 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function getMixinKey(imgKeyPlusSubKey: string): string {
  return MIXIN_KEY_ENC_TAB.map((i) => imgKeyPlusSubKey[i]).join("").slice(0, 32);
}

type WbiCache = { mixinKey: string; fetchedAt: number };

let wbiCache: WbiCache | null = null;
const WBI_CACHE_MS = 20 * 60 * 60 * 1000;

export function invalidateBiliWbiCache(): void {
  wbiCache = null;
}

/** 解析 nav 接口里的 wbi png 伪装 URL → 文件名中的 key */
function keyFromPseudoPngUrl(url: string): string {
  const name = url.split("/").pop() ?? "";
  return name.replace(/\.png$/i, "");
}

/**
 * 获取当前 WBI mixin_key（由 img_key+sub_key 推导），带短时缓存。
 * 需经由同源 /__bili_api 反代（带 x-bili-buvid3 与浏览器环境一致）。
 */
export async function getOrFetchWbiMixinKey(buvid3: string): Promise<string> {
  const now = Date.now();
  if (wbiCache && now - wbiCache.fetchedAt < WBI_CACHE_MS) {
    return wbiCache.mixinKey;
  }
  const headers: Record<string, string> = {};
  if (buvid3) headers["x-bili-buvid3"] = buvid3;
  const resp = await fetch("/__bili_api/x/web-interface/nav", { headers });
  const json = (await resp.json()) as {
    code?: number;
    data?: { wbi_img?: { img_url?: string; sub_url?: string } };
  };
  const img_url = json.data?.wbi_img?.img_url;
  const sub_url = json.data?.wbi_img?.sub_url;
  if (!img_url || !sub_url) throw new Error("无法获取 WBI 口令（nav 无 wbi_img）");

  const raw = keyFromPseudoPngUrl(img_url) + keyFromPseudoPngUrl(sub_url);
  const mixinKey = getMixinKey(raw);
  wbiCache = { mixinKey, fetchedAt: now };
  return mixinKey;
}

const CHR_FILTER_RE = /[!'()*]/g;

/**
 * 为查询参数追加 wts / w_rid，返回可直接拼在路径后的 query（已编码）。
 */
export function signBiliWbiQuery(
  rawParams: Record<string, string | number>,
  mixinKey: string,
): string {
  const chr = CHR_FILTER_RE;
  const wts = String(Math.round(Date.now() / 1000));

  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawParams)) {
    params[k] = String(v).replace(chr, "");
  }
  params["wts"] = wts;

  const sortedKeys = Object.keys(params).sort();
  const query = sortedKeys
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join("&");
  const w_rid = md5(query + mixinKey);
  return `${query}&w_rid=${w_rid}`;
}
