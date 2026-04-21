/** 可序列化的主题 token（写入 localStorage） */
export type ThemePresetId =
  | "dark-default"
  | "light-gray"
  | "light-paper"
  | "light-cool"
  | "light-blue"
  | "eye-green"
  | "custom";

export type ThemeCssVars = {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  primary: string;
  /** 主按钮上的文字色 */
  onPrimary: string;
  accent: string;
  danger: string;
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = String(hex).trim();
  if (!h.startsWith("#")) h = "#" + h;
  if (/^#[0-9A-Fa-f]{3}$/i.test(h)) {
    const r = h[1],
      g = h[2],
      b = h[3];
    h = "#" + r + r + g + g + b + b;
  }
  if (!/^#[0-9A-Fa-f]{6}$/i.test(h)) return null;
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function mixRgb(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  t: number,
): { r: number; g: number; b: number } {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const R = lin(rgb.r),
    G = lin(rgb.g),
    B = lin(rgb.b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function onPrimaryFor(primaryHex: string): string {
  const p = hexToRgb(primaryHex);
  if (!p) return "#f8fafc";
  return relativeLuminance(p) > 0.45 ? "#0f172a" : "#f8fafc";
}

/** 自定义背景 + 主文字色时，推导 surface / border / muted及强调色倾向 */
export function deriveCustomTheme(bgHex: string, textHex: string): ThemeCssVars {
  const bg = hexToRgb(bgHex) ?? { r: 15, g: 20, b: 25 };
  const text = hexToRgb(textHex) ?? { r: 232, g: 238, b: 247 };
  const lBg = relativeLuminance(bg);
  const lightish = lBg > 0.45;
  const toward = lightish
    ? { r: 30, g: 41, b: 59 }
    : { r: 255, g: 255, b: 255 };
  const surf = mixRgb(bg, toward, lightish ? 0.06 : 0.12);
  const surface = rgbToHex(surf.r, surf.g, surf.b);
  const border = rgbToHex(
    mixRgb(bg, text, 0.14).r,
    mixRgb(bg, text, 0.14).g,
    mixRgb(bg, text, 0.14).b,
  );
  const muted = rgbToHex(
    mixRgb(bg, text, 0.38).r,
    mixRgb(bg, text, 0.38).g,
    mixRgb(bg, text, 0.38).b,
  );
  const primary = lightish ? "#2563eb" : "#5c9eff";
  const accent = lightish ? "#059669" : "#3dd68c";
  const danger = lightish ? "#dc2626" : "#ff6b6b";
  return {
    bg: rgbToHex(bg.r, bg.g, bg.b),
    surface,
    border,
    text: rgbToHex(text.r, text.g, text.b),
    muted,
    primary,
    onPrimary: onPrimaryFor(primary),
    accent,
    danger,
  };
}

export const THEME_PRESETS: Array<{
  id: Exclude<ThemePresetId, "custom">;
  label: string;
  hint?: string;
  vars: ThemeCssVars;
}> = [
  {
    id: "dark-default",
    label: "深色默认",
    hint: "当前默认深蓝灰底",
    vars: {
      bg: "#0f1419",
      surface: "#1a2332",
      border: "#2d3a4d",
      text: "#e8eef7",
      muted: "#8b9cb3",
      primary: "#5c9eff",
      onPrimary: "#0a1628",
      accent: "#3dd68c",
      danger: "#ff6b6b",
    },
  },
  {
    id: "light-gray",
    label: "浅灰亮白",
    hint: "浅灰背景 + 黑灰字",
       vars: {
      bg: "#f2f4f7",
      surface: "#ffffff",
      border: "#dde2e8",
      text: "#1f2937",
      muted: "#5c6573",
      primary: "#2563eb",
      onPrimary: "#f8fafc",
      accent: "#059669",
      danger: "#dc2626",
    },
  },
  {
    id: "light-paper",
    label: "暖色纸感",
    hint: "米白暖底，阅读向",
    vars: {
      bg: "#f7f4ed",
      surface: "#fffcf6",
      border: "#e6dfd2",
      text: "#2d2620",
      muted: "#6b5f52",
      primary: "#1d4ed8",
      onPrimary: "#f8fafc",
      accent: "#0f766e",
      danger: "#b91c1c",
    },
  },
  {
    id: "light-cool",
    label: "冷灰办公",
    hint: "偏冷中性灰",
    vars: {
      bg: "#eef1f5",
      surface: "#f8fafc",
      border: "#cbd5e1",
      text: "#0f172a",
      muted: "#64748b",
      primary: "#2563eb",
      onPrimary: "#f8fafc",
      accent: "#0d9488",
      danger: "#dc2626",
    },
  },
  {
    id: "light-blue",
    label: "晴空浅蓝",
    hint: "淡蓝底 + 深藏青字",
    vars: {
      bg: "#eef3f9",
      surface: "#f6f9fc",
      border: "#c8d4e4",
      text: "#152238",
      muted: "#4a5f7a",
      primary: "#1e6feb",
      onPrimary: "#f8fafc",
      accent: "#0d9488",
      danger: "#c62828",
    },
  },
  {
    id: "eye-green",
    label: "豆沙护眼",
    hint: "淡绿底，减轻刺眼",
    vars: {
      bg: "#d8f0dc",
      surface: "#e8f6eb",
      border: "#b8d9c0",
      text: "#1e3a26",
      muted: "#3d5a47",
      primary: "#166534",
      onPrimary: "#f0fdf4",
      accent: "#0f766e",
      danger: "#b91c1c",
    },
  },
];

export function presetVars(id: Exclude<ThemePresetId, "custom">): ThemeCssVars {
  const p = THEME_PRESETS.find((x) => x.id === id);
  return p?.vars ?? THEME_PRESETS[0]!.vars;
}

export function applyThemeVarsToDocument(vars: ThemeCssVars) {
  const root = document.documentElement;
  root.style.setProperty("--bg", vars.bg);
  root.style.setProperty("--surface", vars.surface);
  root.style.setProperty("--border", vars.border);
  root.style.setProperty("--text", vars.text);
  root.style.setProperty("--muted", vars.muted);
  root.style.setProperty("--primary", vars.primary);
  root.style.setProperty("--on-primary", vars.onPrimary);
  root.style.setProperty("--accent", vars.accent);
  root.style.setProperty("--danger", vars.danger);
}
