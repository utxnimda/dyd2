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
export const TEAM_SIZE = 4;
export const TEAM_COUNT = CAPTAIN_COUNT / TEAM_SIZE;

export const TEAM_DEFS = [
  { label: "紫", accent: "#a855f7", corner: "tl" as const },
  { label: "绿", accent: "#22c55e", corner: "tr" as const },
  { label: "蓝", accent: "#3b82f6", corner: "bl" as const },
  { label: "粉", accent: "#ec4899", corner: "br" as const },
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

/** 左上紫、右上绿、左下蓝、右下粉，每队最多 4 人 */
export function captainTeamsFromCards(cards: CaptainMoneyCard[]) {
  const caps = cards
    .filter((c) => c._orderIndex < CAPTAIN_COUNT)
    .sort((a, b) => a._orderIndex - b._orderIndex);
  return TEAM_DEFS.map((def, teamIdx) => {
    const start = teamIdx * TEAM_SIZE;
    return { ...def, members: caps.slice(start, start + TEAM_SIZE) };
  });
}
