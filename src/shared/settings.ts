import { type ClientConfig } from "./api";
import type { ThemePresetId } from "./themePresets";

const KEY = "fmz_dashboard_settings_v1";

export type StoredSettings = {
  apiBase: string;
  liveRoom: string;
  xProject: string;
  currencyProportion: number;
  bearerToken: string;
  /**
   * 赞踩服务根路径（同源反代），默认 /__fmz_reactions
   * 开发时 Vite 会转发到本机 reactions-server
   */
  reactionsApiBase: string;
  /** 与服务器环境变量 FMZ_REACTIONS_SECRET 一致时可填，防止他人刷赞踩 */
  reactionsSecret: string;
  /** 配色方案：预设或自定义 */
  themePreset: ThemePresetId;
  /** 页面主背景色（自定义或同步自选预设） */
  backgroundColor: string;
  /** 主正文 / 标题用字色（自定义时生效；预设会覆盖到界面变量） */
  textColor: string;
  /** 宝宝版全局开关 — 开启后显示宝宝魅力时刻等宝宝专属功能 */
  baobaoMode: boolean;
};

function envNum(raw: string | undefined, fallback: number): number {
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 与仓库根 fmz_config.js（LIVE_ROOM / CURRENCY_PROPORTION）及官网 SPA 默认一致，可用 .env 覆盖 */
export const defaultSettings = (): StoredSettings => ({
  /** 与 Nginx / Vite 反代一致；未注入 VITE_API_BASE 时走同源 /__fmz_api，避免生产环境误直连跨域 */
  apiBase: import.meta.env.VITE_API_BASE || "/__fmz_api",
  liveRoom: String(import.meta.env.VITE_LIVE_ROOM ?? "888").trim() || "888",
  xProject:
    String(import.meta.env.VITE_X_PROJECT ?? import.meta.env.VITE_LIVE_ROOM ?? "888").trim() ||
    "888",
  currencyProportion: envNum(import.meta.env.VITE_CURRENCY_PROPORTION, 100),
  bearerToken: "",
  reactionsApiBase: "/__fmz_reactions",
  reactionsSecret: "",
  themePreset: "dark-default",
  backgroundColor: "#0f1419",
  textColor: "#e8eef7",
  baobaoMode: false,
});

export function loadSettings(): StoredSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<StoredSettings>;
    const base = defaultSettings();
    const merged = { ...base, ...parsed };
    if (!parsed.themePreset) {
      const bg = String(parsed.backgroundColor || "").toLowerCase();
      merged.themePreset =
        bg && bg !== "#0f1419" ? "custom" : "dark-default";
    }
    if (parsed.textColor == null || parsed.textColor === "") {
      merged.textColor = base.textColor;
    }
    if (parsed.reactionsApiBase == null || String(parsed.reactionsApiBase).trim() === "") {
      merged.reactionsApiBase = base.reactionsApiBase;
    }
    if (parsed.reactionsSecret == null) {
      merged.reactionsSecret = base.reactionsSecret;
    }
    if (parsed.baobaoMode == null) {
      merged.baobaoMode = base.baobaoMode;
    }
    return merged;
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s: StoredSettings) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function toClientConfig(s: StoredSettings): ClientConfig {
  return {
    apiBase: s.apiBase,
    liveRoom: s.liveRoom,
    xProject: s.xProject,
    currencyProportion: s.currencyProportion,
    bearerToken: s.bearerToken,
  };
}
