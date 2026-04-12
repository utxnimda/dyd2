/** 主站 hash 路由（无 vue-router，便于静态部署与 OBS 单链打开指定页） */

export type MainTab = "pre" | "users" | "battle" | "treasury";

export type PrePanelTab = "total" | "nogf" | "perround" | "gf" | "logging";

const PRE_SUBS = new Set<string>(["total", "nogf", "perround", "gf", "logging"]);

export type ParsedAppHash =
  | { kind: "captain-hud" }
  | {
      kind: "main";
      tab: MainTab;
      prePanel: PrePanelTab;
      /** 仅 tab===battle：#/battle 后的路径段，如 all、captain+member */
      battleShowPath: string | null;
    };

/** 解析 location.hash，支持 #/pre/gf、#captain-hud（全屏）、#/battle、#/treasury 等 */
export function parseAppHash(hash: string): ParsedAppHash {
  let h = (hash || "").replace(/^#/, "").trim();
  if (h === "captain-hud" || h === "/captain-hud") return { kind: "captain-hud" };
  h = h.replace(/^\/*/, "");
  const parts = h.split("/").filter(Boolean);
  if (parts[0] === "captain-hud") return { kind: "captain-hud" };
  if (parts.length === 0)
    return { kind: "main", tab: "pre", prePanel: "total", battleShowPath: null };

  const head = parts[0];
  if (head === "pre" || head === "preliminary") {
    const sub = parts[1];
    const prePanel =
      sub && PRE_SUBS.has(sub) ? (sub as PrePanelTab) : "total";
    return { kind: "main", tab: "pre", prePanel, battleShowPath: null };
  }
  if (head === "users")
    return { kind: "main", tab: "users", prePanel: "total", battleShowPath: null };
  if (head === "battle") {
    const seg = parts[1] != null && String(parts[1]).trim() !== "" ? String(parts[1]) : null;
    return { kind: "main", tab: "battle", prePanel: "total", battleShowPath: seg };
  }
  if (head === "treasury")
    return { kind: "main", tab: "treasury", prePanel: "total", battleShowPath: null };

  return { kind: "main", tab: "pre", prePanel: "total", battleShowPath: null };
}

/** 生成与 parseAppHash 一致的 hash 字符串（含 # 前缀） */
export function formatAppHash(
  captainHudOnly: boolean,
  tab: MainTab,
  prePanel: PrePanelTab,
  battleShowPath?: string | null,
): string {
  if (captainHudOnly) return "#/captain-hud";
  if (tab === "users") return "#/users";
  if (tab === "battle") {
    const s = battleShowPath?.trim();
    if (!s) return "#/battle";
    return `#/battle/${s}`;
  }
  if (tab === "treasury") return "#/treasury";
  if (prePanel === "total") return "#/pre";
  return `#/pre/${prePanel}`;
}

export function replaceAppHash(nextHash: string): void {
  const n = nextHash.startsWith("#") ? nextHash : `#${nextHash}`;
  if (window.location.hash === n) return;
  const url = `${window.location.pathname}${window.location.search}${n}`;
  history.replaceState(null, "", url);
}
