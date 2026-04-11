/**
 * 浏览器本地「数据库」：IndexedDB `fmz-dashboard`，按金库/直播用户等成员 id 存点赞、点踩次数。
 * 每次点击按钮 +1，多标签页可共享同一库（同源）。
 */
import { reactive } from "vue";

const DB_NAME = "fmz-dashboard";
const STORE_LIKES = "member_likes";
const STORE_DISLIKES = "member_dislikes";
const DB_VERSION = 2;

export type MemberCountRow = { id: string; count: number };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_LIKES)) {
        db.createObjectStore(STORE_LIKES, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_DISLIKES)) {
        db.createObjectStore(STORE_DISLIKES, { keyPath: "id" });
      }
    };
  });
}

async function readStore(storeName: string): Promise<Record<string, number>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const r = store.getAll();
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const rows = r.result as MemberCountRow[];
      const m: Record<string, number> = {};
      for (const row of rows) m[row.id] = row.count;
      resolve(m);
    };
  });
}

async function incrementStore(storeName: string, id: string): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const g = store.get(id);
    g.onerror = () => reject(g.error);
    g.onsuccess = () => {
      const prev = (g.result as MemberCountRow | undefined)?.count ?? 0;
      const next = prev + 1;
      const p = store.put({ id, count: next });
      p.onerror = () => reject(p.error);
      p.onsuccess = () => resolve(next);
    };
  });
}

/** 点赞计数（IndexedDB，与金库 / 预赛成员 id 一致） */
export const memberLikesState = reactive({
  counts: {} as Record<string, number>,
  ready: false,
});

/** 点踩计数 */
export const memberDislikesState = reactive({
  counts: {} as Record<string, number>,
  ready: false,
});

let loadPromise: Promise<void> | null = null;

/** 加载赞、踩（只请求一次 IndexedDB） */
export function loadMemberVotes(): Promise<void> {
  if (memberLikesState.ready && memberDislikesState.ready) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      if (typeof indexedDB !== "undefined") {
        const [likes, dislikes] = await Promise.all([
          readStore(STORE_LIKES),
          readStore(STORE_DISLIKES),
        ]);
        Object.assign(memberLikesState.counts, likes);
        Object.assign(memberDislikesState.counts, dislikes);
      }
    } catch {
      /* 私密模式等 */
    } finally {
      memberLikesState.ready = true;
      memberDislikesState.ready = true;
    }
  })();
  return loadPromise;
}

export function loadMemberLikes(): Promise<void> {
  return loadMemberVotes();
}

async function bump(
  state: typeof memberLikesState,
  storeName: string,
  id: string | number,
): Promise<number> {
  await loadMemberVotes();
  const key = String(id);
  let next: number;
  try {
    if (typeof indexedDB === "undefined") {
      next = (state.counts[key] ?? 0) + 1;
    } else {
      next = await incrementStore(storeName, key);
    }
  } catch {
    next = (state.counts[key] ?? 0) + 1;
  }
  state.counts[key] = next;
  return next;
}

/** 每次点击点赞 +1 */
export async function addMemberLike(id: string | number): Promise<number> {
  return bump(memberLikesState, STORE_LIKES, id);
}

/** 每次点击点踩 +1 */
export async function addMemberDislike(id: string | number): Promise<number> {
  return bump(memberDislikesState, STORE_DISLIKES, id);
}

export function memberLikeCount(id: string | number): number {
  return memberLikesState.counts[String(id)] ?? 0;
}

export function memberDislikeCount(id: string | number): number {
  return memberDislikesState.counts[String(id)] ?? 0;
}
