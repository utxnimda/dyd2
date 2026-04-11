import { douyuAvatarUrl } from "./api";
import type { MoneyCard, MoneyRecord } from "../types";
import { formatRecordContent } from "./treasuryFormat";

type CaptainLite = Pick<MoneyCard, "id" | "name" | "avatar">;

const RECORD_NAME_KEYS = [
  "fromName",
  "fromNickname",
  "operatorName",
  "operatorNick",
  "sendName",
  "senderName",
  "userName",
  "userNick",
  "nickname",
  "nickName",
  "displayName",
];

const RECORD_AVATAR_KEYS = [
  "avatar",
  "head",
  "headUrl",
  "headImg",
  "headimg",
  "userAvatar",
  "fromAvatar",
  "operatorAvatar",
  "senderAvatar",
  "sendUserAvatar",
  "icon",
  "face",
  "dyAvatar",
];

/** 加减分飞入动画用的操作者（可能是队长，也可能是仅出现在流水文案里的用户） */
export type FlyActorHint = {
  name: string;
  avatar?: string;
  /** 若在队长列表中则带上，用于判断是否为目标本人 */
  captainId?: string | number;
};

/** 从流水解析飞入展示用的操作者：先匹配队长，再从 JSON/文案提取昵称 */
export function inferFlyActorFromRecord(
  record: MoneyRecord | null | undefined,
  captains: CaptainLite[],
  targetCaptainKey: string,
  targetDisplayName = "",
): FlyActorHint | undefined {
  if (!record || !captains.length) return undefined;

  let hint: FlyActorHint | undefined;

  const cap = inferSourceCaptain(record, captains);
  if (cap) {
    if (String(cap.id) === targetCaptainKey) return undefined;
    const n = String(cap.name ?? "").trim();
    if (!n) return undefined;
    const av = typeof cap.avatar === "string" && cap.avatar ? cap.avatar : undefined;
    hint = { name: n, avatar: av, captainId: cap.id };
    return flyHintWithRecordAvatar(record, hint);
  }

  const raw = record as Record<string, unknown>;

  const topPick = pickNameFromFlatRecord(raw);
  if (topPick && !isSameDisplayAsTarget(topPick, targetDisplayName)) {
    hint = { name: topPick };
    return flyHintWithRecordAvatar(record, hint);
  }

  const nested = tryParseContentObject(raw.content);
  if (nested) {
    const nestedName = pickNameFromNestedObject(nested);
    if (nestedName && !isSameDisplayAsTarget(nestedName, targetDisplayName)) {
      hint = { name: nestedName };
      return flyHintWithRecordAvatar(record, hint);
    }
  }

  const fromPlain = extractOperatorNameFromPlainRecord(record);
  if (fromPlain && !isSameDisplayAsTarget(fromPlain, targetDisplayName)) {
    hint = { name: fromPlain };
    return flyHintWithRecordAvatar(record, hint);
  }

  const plainContent = String(raw.content ?? "").trim();
  if (plainContent && !plainContent.startsWith("{")) {
    const generic = extractNameFromGenericContent(plainContent);
    if (generic && !isSameDisplayAsTarget(generic, targetDisplayName)) {
      hint = { name: generic };
      return flyHintWithRecordAvatar(record, hint);
    }
  }

  const fmt = formatRecordContent(record).trim();
  if (fmt) {
    const stripped = fmt.replace(/伐木积分\s*$/u, "").trim();
    const fromFmt = extractNameFromGenericContent(stripped);
    if (fromFmt && !isSameDisplayAsTarget(fromFmt, targetDisplayName)) {
      hint = { name: fromFmt };
      return flyHintWithRecordAvatar(record, hint);
    }
  }

  return undefined;
}

function pickAvatarFromMoneyRecord(record: MoneyRecord): string | undefined {
  const raw = record as Record<string, unknown>;
  for (const k of RECORD_AVATAR_KEYS) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const c = raw.content;
  let obj: Record<string, unknown> | null = null;
  if (c != null && typeof c === "object" && !Array.isArray(c)) {
    obj = c as Record<string, unknown>;
  } else if (typeof c === "string" && c.trim().startsWith("{")) {
    try {
      obj = JSON.parse(c) as Record<string, unknown>;
    } catch {
      obj = null;
    }
  }
  if (!obj) return undefined;
  for (const k of RECORD_AVATAR_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const nest of ["user", "from", "operator", "sender", "data", "member"]) {
    const n = obj[nest];
    if (n && typeof n === "object" && !Array.isArray(n)) {
      const inner = n as Record<string, unknown>;
      for (const k of RECORD_AVATAR_KEYS) {
        const v = inner[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
  }
  return undefined;
}

function flyHintWithRecordAvatar(
  record: MoneyRecord | null | undefined,
  hint: FlyActorHint,
): FlyActorHint {
  if (!record) return hint;
  if (hint.avatar?.trim()) return hint;
  const rawAv = pickAvatarFromMoneyRecord(record);
  if (!rawAv) return hint;
  const u = douyuAvatarUrl(rawAv);
  return u ? { ...hint, avatar: u } : hint;
}

function isSameDisplayAsTarget(name: string, targetDisplayName: string) {
  const t = targetDisplayName.trim();
  if (!t) return false;
  return name.trim() === t;
}

function pickNameFromFlatRecord(raw: Record<string, unknown>): string | undefined {
  for (const k of RECORD_NAME_KEYS) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function pickNameFromNestedObject(obj: Record<string, unknown>): string | undefined {
  for (const k of RECORD_NAME_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const k of ["user", "from", "sender", "operator", "data"]) {
    const v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = v as Record<string, unknown>;
      for (const nk of ["nickname", "name", "userName", "nickName"]) {
        const nv = inner[nk];
        if (typeof nv === "string" && nv.trim()) return nv.trim();
      }
    }
  }
  const contentStr = obj.content;
  if (typeof contentStr === "string" && contentStr.trim()) {
    const g = extractNameFromGenericContent(contentStr);
    if (g) return g;
    const cons = extractConsumptionInnerString(contentStr);
    if (cons) {
      for (const sep of ["消费", "购买", "打赏", "赠送", "送给", "充值"]) {
        const part = cons.split(sep)[0]?.trim();
        if (part) {
          const cleaned = part.replace(/^\[[^\]]*\]\s*/g, "").trim();
          if (cleaned.length >= 2) return cleaned;
        }
      }
    }
  }
  return undefined;
}

/** 接口有时把 content 直接反序列化成对象 */
function tryParseContentObject(content: unknown): Record<string, unknown> | null {
  if (content != null && typeof content === "object" && !Array.isArray(content)) {
    return content as Record<string, unknown>;
  }
  if (typeof content !== "string") return null;
  const s = content.trim();
  if (!s.startsWith("{")) return null;
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 纯文案里解析操作者昵称。
 * 常见：`[专注gal的十八岁少女]扣除1伐木积分` → 方括号内为昵称，后面跟「扣除/消费」等。
 */
function extractNameFromGenericContent(content: string): string | undefined {
  let s = content.trim();
  if (!s) return;

  const bracketActor = s.match(
    /^\[([^\]]+)\]\s*(?:扣除|扣除了|消费|充值|打赏|获得|增加|减少|转给|赠送|送给|购买)/u,
  );
  if (bracketActor?.[1]) {
    const n = bracketActor[1].trim();
    if (n.length >= 2 && n.length <= 40) return n;
  }

  s = s.replace(/^\[[^\]]*\]\s*/g, "").trim();
  const seps =
    /消费|充值|打赏|转给|赠送给|送给|扣除了|扣除|减少|增加|获得|送给主播|送给用户|发起|操作/u;
  const head = s.split(seps)[0]?.trim();
  if (!head) return;
  const cleaned = head.replace(/[:：，,。.!！\s]+$/u, "").trim();
  if (cleaned.length >= 2 && cleaned.length <= 40) return cleaned;
  return undefined;
}

function extractConsumptionInnerString(rawContent: string): string | undefined {
  try {
    const o = JSON.parse(rawContent) as { content?: string };
    return o.content != null ? String(o.content) : "";
  } catch {
    return undefined;
  }
}

function extractOperatorNameFromPlainRecord(record: MoneyRecord): string | undefined {
  const type = String((record as Record<string, unknown>).type ?? "");
  const rawC = (record as Record<string, unknown>).content;
  const content =
    typeof rawC === "string"
      ? rawC
      : rawC != null && typeof rawC === "object"
        ? ""
        : String(rawC ?? "");

  if (type === "CONSUMPTION") {
    let inner = "";
    if (typeof rawC === "string") {
      const parsed = extractConsumptionInnerString(rawC);
      inner = parsed ?? rawC;
    } else if (rawC != null && typeof rawC === "object") {
      const co = (rawC as { content?: unknown }).content;
      inner = co != null ? String(co) : "";
    }
    if (inner) {
      for (const sep of ["消费", "购买", "打赏", "赠送", "送给", "充值"]) {
        const part = inner.split(sep)[0]?.trim();
        if (part) {
          const cleaned = part.replace(/^\[[^\]]*\]\s*/g, "").trim();
          if (cleaned.length >= 2) return cleaned;
        }
      }
    }
  }

  if (type === "RECHARGE" || type === "EXPLODE") {
    const m = content.match(/^(.{1,40}?)(?:获得|增加|充值|消费|打赏|减少|扣除)/u);
    if (m?.[1]) {
      const s = m[1].replace(/^\[[^\]]*\]\s*/g, "").trim();
      if (s.length >= 2) return s;
    }
  }

  if (content) return extractNameFromGenericContent(content);
  return undefined;
}

/** 从流水里尽量解析「来源」队长；解析不到则返回 undefined（HUD 会用顶部居中飞入代替） */
export function inferSourceCaptain(
  record: MoneyRecord | null | undefined,
  captains: CaptainLite[],
): CaptainLite | undefined {
  if (!record || !captains.length) return undefined;
  const raw = record as Record<string, unknown>;
  const byId = new Map<string, CaptainLite>();
  for (const c of captains) {
    byId.set(String(c.id), c);
  }

  const idKeys = [
    "fromMoneyId",
    "sourceMoneyId",
    "fromId",
    "sendMoneyId",
    "operatorMoneyId",
    "userMoneyId",
    "moneyId",
    "targetMoneyId",
  ];
  for (const k of idKeys) {
    const v = raw[k];
    if (v == null || v === "") continue;
    const hit = byId.get(String(v));
    if (hit) return hit;
  }

  const nested = tryParseContentObject(raw.content);
  if (nested) {
    for (const k of idKeys) {
      const v = nested[k];
      if (v == null || v === "") continue;
      const hit = byId.get(String(v));
      if (hit) return hit;
    }
    const fromName = nested.fromName ?? nested.userName ?? nested.nickname;
    if (typeof fromName === "string") {
      const byName = matchCaptainByName(String(fromName), captains);
      if (byName) return byName;
    }
  }

  const text = String(raw.content ?? "");
  return matchCaptainByContent(text, captains);
}

function matchCaptainByName(name: string, captains: CaptainLite[]) {
  const t = name.trim();
  if (!t) return undefined;
  return captains.find((c) => String(c.name ?? "").trim() === t);
}

/** 从文案里找队长昵称（长的优先，减少误匹配） */
function matchCaptainByContent(text: string, captains: CaptainLite[]) {
  const names = captains
    .map((c) => String(c.name ?? "").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const n of names) {
    if (text.includes(n)) {
      return captains.find((c) => String(c.name ?? "").trim() === n);
    }
  }
  return undefined;
}
