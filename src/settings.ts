import { type ClientConfig } from "./lib/api";
import type { ThemePresetId } from "./lib/themePresets";

const KEY = "fmz_dashboard_settings_v1";

export type StoredSettings = {
  apiBase: string;
  liveRoom: string;
  xProject: string;
  currencyProportion: number;
  bearerToken: string;
  /** 配色方案：预设或自定义 */
  themePreset: ThemePresetId;
  /** 页面主背景色（自定义或同步自选预设） */
  backgroundColor: string;
  /** 主正文 / 标题用字色（自定义时生效；预设会覆盖到界面变量） */
  textColor: string;
};

export const defaultSettings = (): StoredSettings => ({
  apiBase:
    import.meta.env.VITE_API_BASE ||
    (import.meta.env.DEV ? "/__fmz_api" : "https://api2.dongdongne.com"),
  liveRoom: "888",
  xProject: "888",
  currencyProportion: 100,
  bearerToken: "",
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
