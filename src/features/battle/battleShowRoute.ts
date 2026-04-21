/** 战斗爽「展示」勾选：与 #/battle/... 路径及 localStorage 同步，刷新后保持 */

export type BattleShowState = {
  attackedShowAll: boolean;
  captain: boolean;
  other: boolean;
  member: boolean;
};

const STORAGE_KEY = "fmz-dashboard-battle-show";

const DEFAULT_STATE: BattleShowState = {
  attackedShowAll: true,
  captain: true,
  other: true,
  member: true,
};

export function loadBattleShowFromStorage(): BattleShowState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const j = JSON.parse(raw) as Record<string, unknown>;
    return {
      attackedShowAll: Boolean(j.attackedShowAll ?? j.a),
      captain: Boolean(j.captain ?? j.c),
      other: Boolean(j.other ?? j.o),
      member: Boolean(j.member ?? j.m),
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveBattleShowToStorage(s: BattleShowState): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        attackedShowAll: s.attackedShowAll,
        captain: s.captain,
        other: s.other,
        member: s.member,
      }),
    );
  } catch {
    /* ignore quota */
  }
}

/** 路径段：all | none | captain+other+member（固定顺序 captain, other, member） */
export function formatBattleShowPath(s: BattleShowState): string {
  if (s.attackedShowAll) return "all";
  const parts: string[] = [];
  if (s.captain) parts.push("captain");
  if (s.other) parts.push("other");
  if (s.member) parts.push("member");
  return parts.length ? parts.join("+") : "none";
}

export function parseBattleShowPath(
  segment: string | null | undefined,
): BattleShowState | null {
  if (segment == null || segment === "") return null;
  const raw = decodeURIComponent(segment.trim()).toLowerCase();
  if (raw === "all") {
    return {
      attackedShowAll: true,
      captain: true,
      other: true,
      member: true,
    };
  }
  if (raw === "none") {
    return {
      attackedShowAll: false,
      captain: false,
      other: false,
      member: false,
    };
  }
  const tokens = raw.split("+").map((t) => t.trim()).filter(Boolean);
  const set = new Set(tokens);
  const has = (k: string) => set.has(k);
  const c = has("captain") || has("cap") || has("c");
  const o = has("other") || has("oth") || has("o");
  const m = has("member") || has("mem") || has("m");
  if (!c && !o && !m) return null;
  return {
    attackedShowAll: false,
    captain: c,
    other: o,
    member: m,
  };
}
