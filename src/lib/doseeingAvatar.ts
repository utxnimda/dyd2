import { douyuAvatarUrl, nicknameLetterDataUrl } from "./api";
import type { CaptainMoneyCard } from "./captainTeams";

/**
 * 通过 [在看直播 doseeing.com](https://www.doseeing.com/) 的搜索建议与房间页补全斗鱼**主播**头像。
 * 观众：`suggest_all` 的 fan 取 `user_id` 后请求 **`/api/fan/{id}`**（与站内搜索页同源数据）得到 `avatar` 相对路径，再经 `douyuAvatarUrl` 拼 CDN（含 `avatar_v3` 的 `_middle.jpg`）。
 * 开发环境请使用 Vite 代理 `/doseeing`（见 vite.config）；生产环境若遇 CORS 可设置 `VITE_DOSEEING_BASE` 为同源反代路径。
 */
type SuggestResp = {
  suggest?: {
    room?: Array<{ nickname: string; user_id: string }>;
    fan?: Array<{ nickname: string; user_id: string }>;
  };
};

const cache = new Map<string, string | null>();

export function isDoseeingAvatarEnrichEnabled(): boolean {
  return import.meta.env.VITE_DOSEEING_AVATAR !== "0";
}

export function doseeingRequestBase(): string {
  const raw = (import.meta.env.VITE_DOSEEING_BASE as string | undefined)?.trim();
  if (raw) return raw.replace(/\/$/, "");
  return import.meta.env.DEV ? "/doseeing" : "https://www.doseeing.com";
}

function pickRoom(j: SuggestResp, query: string) {
  const rooms = j.suggest?.room ?? [];
  const q = query.trim();
  if (!rooms.length) return undefined;
  let hit = rooms.find((r) => r.nickname === q);
  if (!hit) hit = rooms.find((r) => r.nickname.toLowerCase() === q.toLowerCase());
  return hit ?? rooms[0];
}

function pickFan(j: SuggestResp, query: string) {
  const fans = j.suggest?.fan ?? [];
  const q = query.trim();
  if (!fans.length) return undefined;
  let hit = fans.find((r) => r.nickname === q);
  if (!hit) hit = fans.find((r) => r.nickname.toLowerCase() === q.toLowerCase());
  return hit ?? fans[0];
}

function parseRoomPageAvatar(html: string): string {
  const re = /https:\/\/apic\.douyucdn\.cn\/upload\/avatar[^"'\\\s>]+/i;
  const m = html.match(re);
  return m ? m[0] : "";
}

type FanApiResp = { fan?: { avatar?: string; nickname?: string } };

async function fetchFanAvatarFromDoseeingApi(userId: string): Promise<string | null> {
  const id = String(userId).trim();
  if (!id) return null;
  const base = doseeingRequestBase();
  try {
    const r = await fetch(`${base}/api/fan/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    const j = (await r.json()) as FanApiResp;
    const raw = j.fan?.avatar?.trim();
    if (!raw) return null;
    const url = douyuAvatarUrl(raw);
    return url || null;
  } catch {
    return null;
  }
}

/** 按斗鱼主播昵称在看网查头像（有缓存）；用于流水操作者不在金库列表时的飞入展示 */
export async function resolveAvatarByStreamerNickname(
  name: string,
): Promise<string | null> {
  const n = name.trim();
  if (!n) return null;
  return fetchAvatarUrlByStreamerName(n);
}

/** 优先真实头像；无主播房间图时（多为观众）用昵称首字彩色圆图，避免飞入只有问号 */
export async function resolveAvatarForNicknameDisplay(name: string): Promise<string> {
  const n = name.trim();
  if (!n) return nicknameLetterDataUrl("?");
  const photo = await fetchAvatarUrlByStreamerName(n);
  if (photo) return photo;
  return nicknameLetterDataUrl(n);
}

async function fetchAvatarUrlByStreamerName(name: string): Promise<string | null> {
  if (cache.has(name)) return cache.get(name)!;
  const base = doseeingRequestBase();
  try {
    const su = `${base}/api/suggest_all?type=all&nickname=${encodeURIComponent(name)}`;
    const r = await fetch(su);
    if (!r.ok) {
      cache.set(name, null);
      return null;
    }
    const j = (await r.json()) as SuggestResp;
    const room = pickRoom(j, name);
    if (room?.user_id) {
      const ru = `${base}/room/${room.user_id}`;
      const hr = await fetch(ru);
      if (hr.ok) {
        const html = await hr.text();
        const av = parseRoomPageAvatar(html);
        if (av) {
          cache.set(name, av);
          return av;
        }
      }
    }
    const fan = pickFan(j, name);
    if (fan?.user_id) {
      const fanAv = await fetchFanAvatarFromDoseeingApi(fan.user_id);
      if (fanAv) {
        cache.set(name, fanAv);
        return fanAv;
      }
      cache.set(name, null);
      return null;
    }
    cache.set(name, null);
    return null;
  } catch {
    cache.set(name, null);
    return null;
  }
}

/** 为缺少 avatar 的卡片按昵称在看网补图（带内存缓存与轻量间隔，避免请求过快） */
export async function enrichMissingAvatarsFromDoseeing(
  cards: CaptainMoneyCard[],
): Promise<CaptainMoneyCard[]> {
  if (!isDoseeingAvatarEnrichEnabled()) return cards;
  const out = cards.map((c) => ({ ...c }));
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    if (c.avatar) continue;
    const name = String(c.name ?? "").trim();
    if (!name) continue;
    const url = await fetchAvatarUrlByStreamerName(name);
    if (url) out[i] = { ...c, avatar: url };
    await new Promise<void>((r) => setTimeout(r, 85));
  }
  return out;
}
