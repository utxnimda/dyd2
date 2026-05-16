/** Hash-based routing (no vue-router — works with static deploy & OBS deep links) */

export type MainTab =
  | "pre"
  | "users"
  | "battle"
  | "treasury"
  | "sanguo"
  | "baobao"
  | "douyu"
  | "quota"
  | "songs"
  | "crimes"
  | "danmaku"
  | "ruins";

export type PrePanelTab = "total" | "nogf" | "perround" | "gf" | "logging";

/** 「废墟重建计划」静态子站点在 Tab 内的分栏（对应 public/ruins-rebuild/*.html） */
export type RuinsPanelTab = "hub" | "playlist" | "treasures" | "awards" | "admin";

const PRE_SUBS = new Set<string>(["total", "nogf", "perround", "gf", "logging"]);

const RUINS_SUBS = new Set<string>(["hub", "playlist", "treasures", "awards", "admin"]);

export type ParsedAppHash =
  | { kind: "captain-hud" }
  | {
      kind: "main";
      tab: MainTab;
      prePanel: PrePanelTab;
      /** Only for tab===battle: path segment after #/battle/, e.g. all, captain+member */
      battleShowPath: string | null;
      /** Only for tab===ruins: 子页面（#/ruins/playlist） */
      ruinsPanel: RuinsPanelTab;
    };

/** Shorthand for the common "main" result with default prePanel & no battleShowPath. */
function mainResult(tab: MainTab): ParsedAppHash {
  return { kind: "main", tab, prePanel: "total", battleShowPath: null, ruinsPanel: "hub" };
}

/**
 * 无有效路由段（`#` / `#/` / 空）— 与 `parseAppHash` 在「空 hash」时曾默认 `sanguo` 的分支对齐，
 * 供 App 在首次进入时保留 `firstAvailableMainTab()`，避免误切到夜观星象。
 */
export function isEmptyAppHash(hash: string): boolean {
  let h = (hash || "").replace(/^#/, "").trim();
  if (h === "captain-hud" || h === "/captain-hud") return false;
  h = h.replace(/^\/*/, "");
  return h.split("/").filter(Boolean).length === 0;
}

/**
 * Map of hash head aliases → MainTab.
 * Entries with multiple aliases (e.g. "baobao" | "bilibili" | "bili") are all listed.
 */
const TAB_ALIASES: Record<string, MainTab> = {
  users: "users",
  treasury: "treasury",
  sanguo: "sanguo",
  siege: "sanguo",
  defense: "sanguo",
  douyuDefenseTower: "sanguo",
  baobao: "baobao",
  bilibili: "baobao",
  bili: "baobao",
  douyu: "douyu",
  "douyu-replay": "douyu",
  quota: "quota",
  usage: "quota",
  dashboard: "quota",
  songs: "songs",
  "song-library": "songs",
  library: "songs",
  audio: "sanguo",
  "audio-extractor": "sanguo",
  crimes: "crimes",
  danmaku: "danmaku",
  "douyu-danmaku": "danmaku",
};

/** Parse location.hash — supports #/pre/gf, #captain-hud (fullscreen), #/battle, #/treasury, etc. */
export function parseAppHash(hash: string): ParsedAppHash {
  let h = (hash || "").replace(/^#/, "").trim();
  if (h === "captain-hud" || h === "/captain-hud") return { kind: "captain-hud" };
  h = h.replace(/^\/*/, "");
  const parts = h.split("/").filter(Boolean);
  if (parts[0] === "captain-hud") return { kind: "captain-hud" };
  if (parts.length === 0) return mainResult("sanguo");

  const head = parts[0];

  // Preliminary has sub-tabs
  if (head === "pre" || head === "preliminary") {
    const sub = parts[1];
    const prePanel = sub && PRE_SUBS.has(sub) ? (sub as PrePanelTab) : "total";
    return { kind: "main", tab: "pre", prePanel, battleShowPath: null, ruinsPanel: "hub" };
  }

  // Battle has a show-path segment
  if (head === "battle") {
    const seg = parts[1] != null && String(parts[1]).trim() !== "" ? String(parts[1]) : null;
    return { kind: "main", tab: "battle", prePanel: "total", battleShowPath: seg, ruinsPanel: "hub" };
  }

  // 废墟重建计划：#/ruins / #/ruins/playlist
  if (head === "ruins" || head === "fuxu") {
    const sub = parts[1];
    const ruinsPanel = sub && RUINS_SUBS.has(sub) ? (sub as RuinsPanelTab) : "hub";
    return { kind: "main", tab: "ruins", prePanel: "total", battleShowPath: null, ruinsPanel };
  }

  // Simple alias lookup
  const mapped = TAB_ALIASES[head];
  if (mapped) return mainResult(mapped);

  return mainResult("sanguo");
}

/** Generate a hash string (with # prefix) consistent with parseAppHash. */
export function formatAppHash(
  captainHudOnly: boolean,
  tab: MainTab,
  prePanel: PrePanelTab,
  battleShowPath?: string | null,
  ruinsPanel?: RuinsPanelTab,
): string {
  if (captainHudOnly) return "#/captain-hud";

  // Battle has an optional sub-path
  if (tab === "battle") {
    const s = battleShowPath?.trim();
    return s ? `#/battle/${s}` : "#/battle";
  }

  // Preliminary has sub-panel tabs
  if (tab === "pre") {
    return prePanel === "total" ? "#/pre" : `#/pre/${prePanel}`;
  }

  if (tab === "ruins") {
    const rp = ruinsPanel ?? "hub";
    return rp === "hub" ? "#/ruins" : `#/ruins/${rp}`;
  }

  // All other tabs are simple
  return `#/${tab}`;
}

export function replaceAppHash(nextHash: string): void {
  const n = nextHash.startsWith("#") ? nextHash : `#${nextHash}`;
  if (window.location.hash === n) return;
  const url = `${window.location.pathname}${window.location.search}${n}`;
  history.replaceState(null, "", url);
}
