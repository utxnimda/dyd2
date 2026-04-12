import type { MoneyCard } from "../types";
import { douyuAvatarUrl } from "./api";

function tryParseMoneyAttribute(card: MoneyCard): Record<string, unknown> | null {
  if (!card.attribute) return null;
  try {
    return JSON.parse(String(card.attribute)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const ATTR_AVATAR_KEYS = [
  "avatar",
  "head",
  "headimg",
  "headImg",
  "userAvatar",
  "icon",
  "face",
  "dyAvatar",
];

const ATTR_NAME_KEYS = ["name", "nickname", "userName", "nick", "userNick"];

/** 接口有时把头像放在 attribute JSON 里，顶层 avatar 为空 */
export function resolveMoneyCardAvatar(card: MoneyCard): string {
  const top = card.avatar;
  if (top != null && String(top).trim() !== "") {
    return douyuAvatarUrl(String(top).trim());
  }
  const attr = tryParseMoneyAttribute(card);
  if (!attr) return "";
  for (const k of ATTR_AVATAR_KEYS) {
    const v = attr[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return douyuAvatarUrl(s);
  }
  return "";
}

function isPreliminaryMoneyCard(card: MoneyCard): boolean {
  const attr = tryParseMoneyAttribute(card);
  return attr != null && Number(attr.preliminary) === 1;
}

function resolveMoneyCardNameFallback(card: MoneyCard): string {
  const top = card.name;
  if (top != null && String(top).trim() !== "") return String(top).trim();
  const attr = tryParseMoneyAttribute(card);
  if (!attr) return "";
  for (const k of ATTR_NAME_KEYS) {
    const v = attr[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

/** 与金库页约定一致：接口按 id 升序返回时，前 16 人为队长 */
export const CAPTAIN_COUNT = 16;
/** 预赛成员名单人数上限（attribute preliminary=1 中取前 N，与预赛数据一致） */
export const PRELIMINARY_ROSTER_CAP = 48;
export const TEAM_SIZE = 4;
export const TEAM_COUNT = CAPTAIN_COUNT / TEAM_SIZE;

export const TEAM_DEFS = [
  { label: "A", accent: "#a855f7", corner: "tl" as const },
  { label: "B", accent: "#22c55e", corner: "tr" as const },
  { label: "C", accent: "#3b82f6", corner: "bl" as const },
  { label: "D", accent: "#ec4899", corner: "br" as const },
] as const;

export type CaptainMoneyCard = MoneyCard & {
  _orderIndex: number;
  balance: number;
  avatar: string;
};

export function normalizeMoneyList(
  list: MoneyCard[],
  currencyProportion: number,
): CaptainMoneyCard[] {
  const p = currencyProportion || 100;
  return list.map((r, i) => {
    const nameFb = resolveMoneyCardNameFallback(r);
    return {
      ...r,
      _orderIndex: i,
      balance: Number(r.balance || 0) / p,
      avatar: resolveMoneyCardAvatar(r),
      ...(nameFb ? { name: nameFb } : {}),
    };
  });
}

/** 左上 A、右上 B、左下 C、右下 D 四阵营，每阵营最多 4 人 */
export function captainTeamsFromCards(cards: CaptainMoneyCard[]) {
  const caps = cards
    .filter((c) => c._orderIndex < CAPTAIN_COUNT)
    .sort((a, b) => a._orderIndex - b._orderIndex);
  return TEAM_DEFS.map((def, teamIdx) => {
    const start = teamIdx * TEAM_SIZE;
    return { ...def, members: caps.slice(start, start + TEAM_SIZE) };
  });
}

/** 预赛 48 人：preliminary=1 按金库顺序取前 48 */
export function preliminaryRoster48(cards: CaptainMoneyCard[]): CaptainMoneyCard[] {
  return cards
    .filter(isPreliminaryMoneyCard)
    .sort((a, b) => a._orderIndex - b._orderIndex)
    .slice(0, PRELIMINARY_ROSTER_CAP);
}

/** 队长：金库列表前 CAPTAIN_COUNT 条的 id（与 captainTeamsFromCards 一致） */
function captainIdSet(cards: CaptainMoneyCard[]): Set<string> {
  return new Set(
    cards.filter((c) => c._orderIndex < CAPTAIN_COUNT).map((c) => String(c.id)),
  );
}

/**
 * 团员分三类之「其他」：非队长，且不在预赛 48 人名单（id集合）内。
 * 含「有预赛标但未进前 48」等非名单成员。
 */
export function hudOtherMembers(cards: CaptainMoneyCard[]): CaptainMoneyCard[] {
  const capIds = captainIdSet(cards);
  const p48Ids = new Set(preliminaryRoster48(cards).map((c) => String(c.id)));
  return cards
    .filter(
      (c) =>
        c._orderIndex >= CAPTAIN_COUNT &&
        !p48Ids.has(String(c.id)) &&
        !capIds.has(String(c.id)),
    )
    .sort((a, b) => a._orderIndex - b._orderIndex);
}

/**
 * 团员分三类之「预赛队员」：预赛 48 人名单内成员，去掉已在四角展示的队长（按 id）。
 * 顺序与 preliminaryRoster48 一致。
 */
export function hudBottomTeam(cards: CaptainMoneyCard[]): CaptainMoneyCard[] {
  const capIds = captainIdSet(cards);
  return preliminaryRoster48(cards).filter((c) => !capIds.has(String(c.id)));
}
