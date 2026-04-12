/** 主站 hash 路由（无 vue-router，便于静态部署与 OBS 单链打开指定页） */

export type MainTab = "pre" | "users" | "treasury";

export type PrePanelTab = "total" | "nogf" | "perround" | "gf" | "logging";

const PRE_SUBS = new Set<string>(["total", "nogf", "perround", "gf", "logging"]);

export type ParsedAppHash =
  | { kind: "captain-hud" }
  | { kind: "main"; tab: MainTab; prePanel: PrePanelTab };

/** 解析 location.hash，支持 #/pre/gf、#captain-hud、#/treasury 等 */
export function parseAppHash(hash: string): ParsedAppHash {
  let h = (hash || "").replace(/^#/, "").trim();
  if (h === "captain-hud" || h === "/captain-hud") return { kind: "captain-hud" };
  h = h.replace(/^\/*/, "");
  const parts = h.split("/").filter(Boolean);
  if (parts[0] === "captain-hud") return { kind: "captain-hud" };
  if (parts.length === 0) return { kind: "main", tab: "pre", prePanel: "total" };

  const head = parts[0];
  if (head === "pre" || head === "preliminary") {
    const sub = parts[1];
    const prePanel =
      sub && PRE_SUBS.has(sub) ? (sub as PrePanelTab) : "total";
    return { kind: "main", tab: "pre", prePanel };
  }
  if (head === "users") return { kind: "main", tab: "users", prePanel: "total" };
  if (head === "treasury") return { kind: "main", tab: "treasury", prePanel: "total" };

  return { kind: "main", tab: "pre", prePanel: "total" };
}

/** 生成与 parseAppHash 一致的 hash 字符串（含 # 前缀） */
export function formatAppHash(
  captainHudOnly: boolean,
  tab: MainTab,
  prePanel: PrePanelTab,
): string {
  if (captainHudOnly) return "#/captain-hud";
  if (tab === "users") return "#/users";
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
