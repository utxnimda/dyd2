import {
  CAPTAIN_COUNT,
  preliminaryRoster48,
  type CaptainMoneyCard,
} from "./captainTeams";

/** 半数以上队长 id 已不在当前金库列表时，视为数据源已换（或首次未正确种子），整表按当前列表重算 */
const ROSTER_RESEED_STALE_CAPTAINS = Math.ceil(CAPTAIN_COUNT / 2);

const DB_NAME = "fmz-dashboard";
/**
 * 须单调递增。同名库若已是更高 version，不可降低。
 * v2 可能由其它逻辑打开但未建 `roster` 表，会导致 transaction 报 object store not found；
 * 升到 v3 会再次触发 upgradeneeded，从而补建缺失的 store。
 */
const DB_VERSION = 3;
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
function buildEntriesFromCards(cards: CaptainMoneyCard[]): RosterEntry[] {
  const p48 = preliminaryRoster48(cards);
  const rankById = new Map(p48.map((c, i) => [String(c.id), i + 1]));
  return cards.map((c, i) => ({
    id: String(c.id),
    captainSlot: i < CAPTAIN_COUNT ? i : null,
    preliminaryRank: rankById.get(String(c.id)) ?? null,
  }));
}

/** 清空档案并按当前金库列表重写（与首次种子规则一致） */
export async function replaceRosterSeedFromCards(cards: CaptainMoneyCard[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.onerror = () => reject(tx.error ?? new Error("clear roster failed"));
    tx.oncomplete = () => resolve();
    tx.objectStore(STORE).clear();
  });
  const entries = buildEntriesFromCards(cards);
  await putRosterEntries(entries);
}

export async function seedRosterIfEmpty(cards: CaptainMoneyCard[]): Promise<boolean> {
  const n = await rosterEntryCount();
  if (n > 0) return false;
  await putRosterEntries(buildEntriesFromCards(cards));
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

/**
 * 与当前金库列表同步本地档案：首次写入；之后仅合并新 id。
 * 若本地队长槽位里过半数 id 已不在本次列表中，则整表重算（解决换届/换房间后战斗爽空白）。
 */
export async function initRosterFromFetchedCards(
  cards: CaptainMoneyCard[],
): Promise<void> {
  if (!cards.length) return;

  const n = await rosterEntryCount();
  if (n > 0) {
    const map = await loadRosterMap();
    const cardIds = new Set(cards.map((c) => String(c.id)));
    let staleCaptainRows = 0;
    for (const e of map.values()) {
      if (e.captainSlot != null && !cardIds.has(e.id)) staleCaptainRows += 1;
    }
    if (staleCaptainRows >= ROSTER_RESEED_STALE_CAPTAINS) {
      await replaceRosterSeedFromCards(cards);
      return;
    }
  }

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
