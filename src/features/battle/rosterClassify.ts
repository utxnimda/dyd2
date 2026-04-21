import { CAPTAIN_COUNT, TEAM_DEFS, TEAM_SIZE, type CaptainMoneyCard } from "./captainTeams";
import type { RosterEntry } from "./rosterDb";

/** 四角队长分区：按本地档案 captainSlot 0..15，再按 A/B/C/D 四阵营切分 */
export function captainTeamsFromRoster(
  cards: CaptainMoneyCard[],
  roster: Map<string, RosterEntry>,
) {
  const byId = new Map(cards.map((c) => [String(c.id), c]));
  const slots: CaptainMoneyCard[] = [];
  for (let s = 0; s < CAPTAIN_COUNT; s++) {
    const id = [...roster.entries()].find(([, e]) => e.captainSlot === s)?.[0];
    if (!id) continue;
    const c = byId.get(id);
    if (c) slots.push(c);
  }
  return TEAM_DEFS.map((def, teamIdx) => {
    const start = teamIdx * TEAM_SIZE;
    return { ...def, members: slots.slice(start, start + TEAM_SIZE) };
  });
}

/** 预赛队员：档案中 preliminaryRank 有值且非队长；按名次排序 */
export function hudBottomTeamFromRoster(
  cards: CaptainMoneyCard[],
  roster: Map<string, RosterEntry>,
): CaptainMoneyCard[] {
  const byId = new Map(cards.map((c) => [String(c.id), c]));
  const rows = [...roster.values()]
    .filter((e) => e.preliminaryRank != null && e.captainSlot == null)
    .sort((a, b) => (a.preliminaryRank ?? 0) - (b.preliminaryRank ?? 0));
  const out: CaptainMoneyCard[] = [];
  for (const e of rows) {
    const c = byId.get(e.id);
    if (c) out.push(c);
  }
  return out;
}

/**
 * 其他：非队长且不在预赛 48 名单。
 * 无档案行的新成员（不应出现，merge 会补）视为其他。
 */
export function hudOtherMembersFromRoster(
  cards: CaptainMoneyCard[],
  roster: Map<string, RosterEntry>,
): CaptainMoneyCard[] {
  return cards
    .filter((c) => {
      const e = roster.get(String(c.id));
      if (!e) return true;
      return e.captainSlot == null && e.preliminaryRank == null;
    })
    .sort((a, b) => a._orderIndex - b._orderIndex);
}
