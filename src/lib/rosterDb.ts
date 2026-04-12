import {
  CAPTAIN_COUNT,
  preliminaryRoster48,
  type CaptainMoneyCard,
} from "./captainTeams";

const DB_NAME = "fmz-dashboard";
const DB_VERSION = 1;
const STORE = "roster";

/** 本地团员档案：队长槽位与预赛名次均由库内字段决定，不随金库列表排序变化 */
export type RosterEntry = {
  id: string;
  /** 0..15 为队长在四角中的固定槽位；null 非队长 */
  captainSlot: number | null;
  /** 1..48 为预赛名单内顺序；null 表示不在预赛 48 名单 */
  preliminaryRank: number | null;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
  });
}

export async function getAllRosterEntries(): Promise<RosterEntry[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as RosterEntry[]);
    req.onerror = () => reject(req.error);
 });
}

export async function rosterEntryCount(): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putRosterEntries(entries: RosterEntry[]): Promise<void> {
  if (!entries.length) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.onerror = () => reject(tx.error ?? new Error("roster write failed"));
    tx.oncomplete = () => resolve();
    const store = tx.objectStore(STORE);
    for (const e of entries) store.put(e);
  });
}

export async function loadRosterMap(): Promise<Map<string, RosterEntry>> {
  const rows = await getAllRosterEntries();
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * 首次：用当前接口数据写入档案（队长 = 当时列表前 16 人槽位固定；预赛 48 = 当前 preliminary 规则）。
 * 之后队长槽位与预赛名次不再随列表顺序自动改写（队长不变）。
 */
export async function seedRosterIfEmpty(cards: CaptainMoneyCard[]): Promise<boolean> {
  const n = await rosterEntryCount();
  if (n > 0) return false;
  const p48 = preliminaryRoster48(cards);
  const rankById = new Map(p48.map((c, i) => [String(c.id), i + 1]));
  const entries: RosterEntry[] = cards.map((c, i) => ({
    id: String(c.id),
    captainSlot: i < CAPTAIN_COUNT ? i : null,
    preliminaryRank: rankById.get(String(c.id)) ?? null,
  }));
  await putRosterEntries(entries);
  return true;
}

/** 新出现的金库成员写入档案，默认「其他」（非队长、非预赛名单） */
export async function mergeNewCardsIntoRoster(cards: CaptainMoneyCard[]): Promise<void> {
  const existing = new Set((await getAllRosterEntries()).map((e) => e.id));
  const toAdd: RosterEntry[] = [];
  for (const c of cards) {
    const id = String(c.id);
    if (!existing.has(id)) {
      toAdd.push({ id, captainSlot: null, preliminaryRank: null });
      existing.add(id);
    }
  }
  await putRosterEntries(toAdd);
}

export async function initRosterFromFetchedCards(
  cards: CaptainMoneyCard[],
): Promise<void> {
  await seedRosterIfEmpty(cards);
  await mergeNewCardsIntoRoster(cards);
}

export async function clearRosterStore(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.onerror = () => reject(tx.error ?? new Error("clear roster failed"));
    tx.oncomplete = () => resolve();
    tx.objectStore(STORE).clear();
  });
}
