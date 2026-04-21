/**
 * 赞 / 踩：经同源「赞踩服务」写入服务器 SQLite，不再使用浏览器 IndexedDB。
 * 配置由 App.vue provide（X-Project + 房间号 区分命名空间）。
 */
import { reactive, type ComputedRef, type InjectionKey } from "vue";

export type ReactionsClient = {
  /** 如 /__fmz_reactions 或完整 URL */
  baseUrl: string;
  /** 与金库配置一致，如 `${xProject}_${liveRoom}` */
  projectKey: string;
  /** 可选，与服务器 FMZ_REACTIONS_SECRET 一致 */
  secret: string;
};

export const FMZ_REACTIONS_CLIENT_KEY: InjectionKey<ComputedRef<ReactionsClient>> =
  Symbol("fmzReactionsClient");

/** 由 settings 构造（供 App watch 与文档） */
export function reactionsClientFromSettings(s: {
  reactionsApiBase: string;
  xProject: string;
  liveRoom: string;
  reactionsSecret: string;
}): ReactionsClient {
  let base = (s.reactionsApiBase || "/__fmz_reactions").trim();
  if (base && !base.startsWith("http") && !base.startsWith("/")) {
    base = `/${base}`;
  }
  return {
    baseUrl: base.replace(/\/$/, "") || "/__fmz_reactions",
    projectKey: `${s.xProject}_${s.liveRoom}`,
    secret: (s.reactionsSecret || "").trim(),
  };
}

export const memberLikesState = reactive({
  counts: {} as Record<string, number>,
  ready: false,
  lastError: "" as string,
});

export const memberDislikesState = reactive({
  counts: {} as Record<string, number>,
  ready: false,
  lastError: "" as string,
});

let loadSeq = 0;

/** 客户端：两次操作之间的基础间隔（毫秒） */
export const CLIENT_REACTION_BASE_COOLDOWN_MS = 500;

/** 连续成功赞或踩的间隔小于此值（毫秒）视为同一段「连点」，分别累加各自 streak */
const RAPID_REACTION_STREAK_WINDOW_MS = 4000;

/**
 * 连续成功「赞」或「踩」各自计数；达到该次数后，该操作类型在基础间隔上额外加长冷却。
 * 赞/踩互不干扰；不同成员互不干扰（键含 projectKey + memberId）。
 */
const REACTION_STREAK_THRESHOLD = 5;

/** 每多1 次 streak，在基础间隔上多加的毫秒数（封顶见下） */
const COOLDOWN_EXTRA_PER_STREAK_MS = 550;

/** 有效冷却上限（含基础间隔） */
const CLIENT_REACTION_COOLDOWN_MAX_MS = 4000;

type ClientReactionSlot = {
  lastLikeAt: number;
  likeStreak: number;
  lastLikeSuccessAt: number;
  lastDislikeAt: number;
  dislikeStreak: number;
  lastDislikeSuccessAt: number;
};

const clientSlots = new Map<string, ClientReactionSlot>();

function clientReactionKey(ctx: ReactionsClient, memberId: string | number): string {
  return `${ctx.projectKey}\t${String(memberId)}`;
}

function getSlot(k: string): ClientReactionSlot {
  return (
    clientSlots.get(k) ?? {
      lastLikeAt: 0,
      likeStreak: 0,
      lastLikeSuccessAt: 0,
      lastDislikeAt: 0,
      dislikeStreak: 0,
      lastDislikeSuccessAt: 0,
    }
  );
}

function effectiveCooldownMs(streak: number): number {
  if (streak < REACTION_STREAK_THRESHOLD) {
    return CLIENT_REACTION_BASE_COOLDOWN_MS;
  }
  const over = streak - REACTION_STREAK_THRESHOLD + 1;
  const extra = over * COOLDOWN_EXTRA_PER_STREAK_MS;
  return Math.min(CLIENT_REACTION_COOLDOWN_MAX_MS, CLIENT_REACTION_BASE_COOLDOWN_MS + extra);
}

/** @deprecated 请用 CLIENT_REACTION_BASE_COOLDOWN_MS；实际间隔随连赞 streak 变长 */
export const CLIENT_REACTION_COOLDOWN_MS = CLIENT_REACTION_BASE_COOLDOWN_MS;

function recordLikeSuccess(ctx: ReactionsClient, memberId: string | number): void {
  const k = clientReactionKey(ctx, memberId);
  const now = Date.now();
  const slot = getSlot(k);
  if (
    slot.lastLikeSuccessAt > 0 &&
    now - slot.lastLikeSuccessAt <= RAPID_REACTION_STREAK_WINDOW_MS
  ) {
    slot.likeStreak += 1;
  } else {
    slot.likeStreak = 1;
  }
  slot.lastLikeSuccessAt = now;
  clientSlots.set(k, slot);
}

function recordDislikeSuccess(ctx: ReactionsClient, memberId: string | number): void {
  const k = clientReactionKey(ctx, memberId);
  const now = Date.now();
  const slot = getSlot(k);
  if (
    slot.lastDislikeSuccessAt > 0 &&
    now - slot.lastDislikeSuccessAt <= RAPID_REACTION_STREAK_WINDOW_MS
  ) {
    slot.dislikeStreak += 1;
  } else {
    slot.dislikeStreak = 1;
  }
  slot.lastDislikeSuccessAt = now;
  clientSlots.set(k, slot);
}

/** 过短间隔内再次点击返回 false（静默忽略，不请求服务器）。赞/踩、不同成员各自独立计时。 */
export function assertClientReactionAllowed(
  ctx: ReactionsClient,
  memberId: string | number,
  kind: "like" | "dislike",
): boolean {
  const k = clientReactionKey(ctx, memberId);
  const now = Date.now();
  const slot = getSlot(k);
  if (kind === "like") {
    const needMs = effectiveCooldownMs(slot.likeStreak);
    if (now - slot.lastLikeAt < needMs) {
      return false;
    }
    slot.lastLikeAt = now;
  } else {
    const needMs = effectiveCooldownMs(slot.dislikeStreak);
    if (now - slot.lastDislikeAt < needMs) {
      return false;
    }
    slot.lastDislikeAt = now;
  }
  clientSlots.set(k, slot);
  return true;
}

function headersFor(ctx: ReactionsClient, jsonBody?: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (jsonBody) h["Content-Type"] = "application/json";
  if (ctx.secret) h["X-FMZ-Reactions-Secret"] = ctx.secret;
  return h;
}

const REACTIONS_FETCH_MS = 20_000;

function fetchReactions(input: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), REACTIONS_FETCH_MS);
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() =>
    window.clearTimeout(t),
  );
}

function formatReactionsHttpError(
  status: number,
  raw: { code?: number; data?: { message?: string; retryAfterMs?: number } },
): string {
  const msg = raw.data?.message;
  if (status === 403 || raw.code === 403) {
    return (
      msg ||
      "403：赞踩密钥与服务器不一致，请清空或对齐「赞踩 API 密钥」与 FMZ_REACTIONS_SECRET"
    );
  }
  if (status === 429 || raw.code === 429) {
    const ra = raw.data?.retryAfterMs;
    const base = msg || "操作太频繁，请稍后再试";
    return typeof ra === "number" && ra > 0
      ? `${base}（约 ${Math.ceil(ra / 1000)} 秒后可再试）`
      : base;
  }
  if (msg) return msg;
  return `HTTP ${status} ${JSON.stringify(raw)}`;
}

/** 从服务器拉取当前 project 下全部计数 */
export async function loadMemberVotesFromServer(ctx: ReactionsClient): Promise<void> {
  const seq = ++loadSeq;
  memberLikesState.lastError = "";
  memberDislikesState.lastError = "";
  try {
    const q = `project=${encodeURIComponent(ctx.projectKey)}`;
    let res: Response;
    try {
      res = await fetchReactions(`${ctx.baseUrl}/api/votes?${q}`, {
        headers: headersFor(ctx),
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(
          `赞踩请求超时（${REACTIONS_FETCH_MS / 1000}s）：请确认 reactions-server 已启动（端口 8787）且反代 /__fmz_reactions 可用`,
        );
      }
      throw e;
    }
    const text = await res.text();
    let raw: { code?: number; data?: { likes?: Record<string, number>; dislikes?: Record<string, number> } };
    try {
      raw = JSON.parse(text) as {
        code?: number;
        data?: { likes?: Record<string, number>; dislikes?: Record<string, number> };
      };
    } catch {
      const hint =
        text.trim().startsWith("<") || text.includes("<!DOCTYPE")
          ? "请确认已启动 reactions-server（npm run reactions-server）且 Vite/Nginx 已反代 /__fmz_reactions"
          : "";
      throw new Error(`赞踩列表非 JSON ${hint} HTTP ${res.status}`);
    }
    if (seq !== loadSeq) return;
    if (!res.ok || raw.code !== 0 || !raw.data) {
      throw new Error(formatReactionsHttpError(res.status, raw));
    }
    memberLikesState.counts = { ...(raw.data.likes ?? {}) };
    memberDislikesState.counts = { ...(raw.data.dislikes ?? {}) };
  } catch (e) {
    if (seq !== loadSeq) return;
    const msg = e instanceof Error ? e.message : String(e);
    memberLikesState.lastError = msg;
    memberDislikesState.lastError = msg;
  } finally {
    if (seq === loadSeq) {
      memberLikesState.ready = true;
      memberDislikesState.ready = true;
    }
  }
}

/** 兼容旧名 */
export function loadMemberVotes(ctx: ReactionsClient): Promise<void> {
  return loadMemberVotesFromServer(ctx);
}

async function postInc(
  ctx: ReactionsClient,
  id: string | number,
  kind: "like" | "dislike",
): Promise<{ likes: number; dislikes: number }> {
  let res: Response;
  try {
    res = await fetchReactions(`${ctx.baseUrl}/api/votes/inc`, {
      method: "POST",
      headers: headersFor(ctx, true),
      body: JSON.stringify({
        project: ctx.projectKey,
        memberId: String(id),
        kind,
      }),
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(
        `赞踩请求超时（${REACTIONS_FETCH_MS / 1000}s）：请确认 reactions-server 已启动且 Nginx 反代 /__fmz_reactions 末尾带 /`,
      );
    }
    throw e;
  }
  const text = await res.text();
  let raw: {
    code?: number;
    data?: { likes?: number; dislikes?: number; message?: string };
  };
  try {
    raw = JSON.parse(text) as {
      code?: number;
      data?: { likes?: number; dislikes?: number; message?: string };
    };
  } catch {
    const hint =
      text.trim().startsWith("<") || text.includes("<!DOCTYPE")
        ? "（返回了 HTML：常见原因①未启动 reactions-server ② Nginx proxy_pass 未加尾斜杠 ③ 路径未反代）"
        : "";
    throw new Error(
      `赞踩服务返回非 JSON ${hint} HTTP ${res.status}：${text.slice(0, 160)}`,
    );
  }
  const data = raw.data;
  const success =
    res.ok &&
    raw.code === 0 &&
    data != null &&
    typeof (data as { likes?: unknown }).likes === "number";

  if (!success) {
    throw new Error(
      `赞踩同步失败 ${formatReactionsHttpError(res.status, raw)}`,
    );
  }
  return {
    likes: Number((data as { likes: number }).likes ?? 0),
    dislikes: Number((data as { dislikes: number }).dislikes ?? 0),
  };
}

export async function addMemberLike(id: string | number, ctx: ReactionsClient): Promise<number> {
  if (!assertClientReactionAllowed(ctx, id, "like")) {
    return memberLikeCount(id);
  }
  const next = await postInc(ctx, id, "like");
  recordLikeSuccess(ctx, id);
  const k = String(id);
  memberLikesState.counts[k] = next.likes;
  memberDislikesState.counts[k] = next.dislikes;
  return next.likes;
}

export async function addMemberDislike(id: string | number, ctx: ReactionsClient): Promise<number> {
  if (!assertClientReactionAllowed(ctx, id, "dislike")) {
    return memberDislikeCount(id);
  }
  const next = await postInc(ctx, id, "dislike");
  recordDislikeSuccess(ctx, id);
  const k = String(id);
  memberLikesState.counts[k] = next.likes;
  memberDislikesState.counts[k] = next.dislikes;
  return next.dislikes;
}

export function memberLikeCount(id: string | number): number {
  return memberLikesState.counts[String(id)] ?? 0;
}

export function memberDislikeCount(id: string | number): number {
  return memberDislikesState.counts[String(id)] ?? 0;
}

/** @deprecated 无本地库，仅保留接口避免误用 */
export function loadMemberLikes(ctx: ReactionsClient): Promise<void> {
  return loadMemberVotesFromServer(ctx);
}
