import { type ClientConfig } from "./lib/api";

const KEY = "fmz_dashboard_settings_v1";

export type StoredSettings = {
  apiBase: string;
  liveRoom: string;
  xProject: string;
  currencyProportion: number;
  bearerToken: string;
  /** 页面主背景色（十六进制，如 #0f1419） */
  backgroundColor: string;
};

export const defaultSettings = (): StoredSettings => ({
  apiBase:
    import.meta.env.VITE_API_BASE ||
    (import.meta.env.DEV ? "/__fmz_api" : "https://api2.dongdongne.com"),
  liveRoom: "888",
  xProject: "888",
  currencyProportion: 100,
  bearerToken: "",
  backgroundColor: "#0f1419",
});

export function loadSettings(): StoredSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSettings();
    return { ...defaultSettings(), ...JSON.parse(raw) };
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
