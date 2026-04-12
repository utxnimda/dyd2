import { type ClientConfig } from "./lib/api";
import type { ThemePresetId } from "./lib/themePresets";

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
};

export const defaultSettings = (): StoredSettings => ({
  /** 与 Nginx / Vite 反代一致；未注入 VITE_API_BASE 时走同源 /__fmz_api，避免生产环境误直连跨域 */
  apiBase: import.meta.env.VITE_API_BASE || "/__fmz_api",
  liveRoom: "888",
  xProject: "888",
  currencyProportion: 100,
  bearerToken: "",
  reactionsApiBase: "/__fmz_reactions",
  reactionsSecret: "",
  themePreset: "dark-default",
  backgroundColor: "#0f1419",
  textColor: "#e8eef7",
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
