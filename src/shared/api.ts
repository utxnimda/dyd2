import axios, { type AxiosInstance } from "axios";

export type ClientConfig = {
  /** 开发环境默认 /__fmz_api；直连时填 https://api2.dongdongne.com */
  apiBase: string;
  liveRoom: string;
  xProject: string;
  currencyProportion: number;
  bearerToken: string;
};

function dyPrefix(room: string) {
  return `dy${room}`;
}

export function createApi(cfg: ClientConfig): {
  client: AxiosInstance;
  keyvalueData: (keys: string[]) => Promise<unknown>;
  liveUserList: (body: Record<string, unknown>) => Promise<unknown>;
  moneyList: (body: Record<string, unknown>) => Promise<unknown>;
  moneyGet: (id: string | number) => Promise<unknown>;
  moneyRecordList: (body: Record<string, unknown>) => Promise<unknown>;
  proxyExecute: (url: string, method?: string) => Promise<unknown>;
} {
  const client = axios.create({
    baseURL: cfg.apiBase.replace(/\/$/, ""),
    timeout: 120000,
  });

  client.interceptors.request.use((config) => {
    config.headers = config.headers ?? {};
    if (cfg.bearerToken) {
      (config.headers as Record<string, string>)["Authorization"] =
        `Bearer ${cfg.bearerToken}`;
    }
    (config.headers as Record<string, string>)["X-Project"] = cfg.xProject;
    (config.headers as Record<string, string>)["Content-Type"] =
      "application/json";
    return config;
  });

  const p = dyPrefix(cfg.liveRoom);

  return {
    client,
    keyvalueData: (keys) =>
      client.post("/api/keyvalue/data", { keys }).then((r) => r.data),
    liveUserList: (body) =>
      client.post("/api/live/user/list", body).then((r) => r.data),
    moneyList: (body) =>
      client.post(`/${p}/money/list`, body).then((r) => r.data),
    moneyGet: (id) =>
      client.get(`/${p}/money/${id}`, { params: {} }).then((r) => r.data),
    moneyRecordList: (body) =>
      client.post(`/${p}/money/record/list`, body).then((r) => r.data),
    /** 与原站一致：POST /dy{room}/proxy ，非 /money/proxy */
    proxyExecute: (url, method = "GET") =>
      client.post(`/${p}/proxy`, { url, method }).then((r) => r.data),
  };
}

/** 斗鱼头像（与站点逻辑一致：非 http 则拼接 CDN） */
export function douyuAvatarUrl(avatar: string | undefined): string {
  if (!avatar) return "";
  const a = String(avatar).trim();
  if (a.startsWith("//")) return `https:${a}`;
  if (a.startsWith("http://") || a.startsWith("https://")) return a;
  let path = a.startsWith("/") ? a.slice(1) : a;
  // avatar_v3 相对路径须带 _middle.jpg 等后缀，否则 CDN 仅返回 404 占位图
  if (path.startsWith("avatar_v3/") && !/\.(jpe?g|png|webp|gif)$/i.test(path)) {
    path = `${path}_middle.jpg`;
  }
  return `https://apic.douyucdn.cn/upload/${path}`;
}

/** 无真实头像时用昵称首字圆形图（data URL），保证飞入动画始终有图 */
export function nicknameLetterDataUrl(name: string): string {
  const t = name.trim();
  const first = t ? [...t][0]! : "?";
  const ch = /[\s]/.test(first) ? "?" : first;
  const safe = ch
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  const palette = ["#4f46e5", "#0d9488", "#c026d3", "#ea580c", "#0369a1", "#b45309", "#15803d"];
  const bg = palette[Math.abs(h) % palette.length]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect fill="${bg}" width="64" height="64" rx="32"/><text x="32" y="40" text-anchor="middle" fill="#f8fafc" font-size="26" font-weight="800" font-family="system-ui,sans-serif">${safe}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
