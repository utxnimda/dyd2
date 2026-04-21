/** Hash-based routing (no vue-router — works with static deploy & OBS deep links) */

export type MainTab = "pre" | "users" | "battle" | "treasury" | "sanguo" | "baobao" | "quota";

export type PrePanelTab = "total" | "nogf" | "perround" | "gf" | "logging";

const PRE_SUBS = new Set<string>(["total", "nogf", "perround", "gf", "logging"]);

export type ParsedAppHash =
  | { kind: "captain-hud" }
  | {
      kind: "main";
      tab: MainTab;
      prePanel: PrePanelTab;
      /** Only for tab===battle: path segment after #/battle/, e.g. all, captain+member */
      battleShowPath: string | null;
    };

/** Shorthand for the common "main" result with default prePanel & no battleShowPath. */
function mainResult(tab: MainTab): ParsedAppHash {
  return { kind: "main", tab, prePanel: "total", battleShowPath: null };
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
  quota: "quota",
  usage: "quota",
  dashboard: "quota",
  audio: "sanguo",
  "audio-extractor": "sanguo",
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
    return { kind: "main", tab: "pre", prePanel, battleShowPath: null };
  }

  // Battle has a show-path segment
  if (head === "battle") {
    const seg = parts[1] != null && String(parts[1]).trim() !== "" ? String(parts[1]) : null;
    return { kind: "main", tab: "battle", prePanel: "total", battleShowPath: seg };
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

  // All other tabs are simple
  return `#/${tab}`;
}

export function replaceAppHash(nextHash: string): void {
  const n = nextHash.startsWith("#") ? nextHash : `#${nextHash}`;
  if (window.location.hash === n) return;
  const url = `${window.location.pathname}${window.location.search}${n}`;
  history.replaceState(null, "", url);
}
