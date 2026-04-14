/** 同源 `/__fmz_defense` 由 Vite 反代至本地 defense-tower-server */

export type WeeklyReport = {
  report_day: Record<string, Record<string, number>>;
  report_hour: Record<string, Record<string, number>>;
  report_minute: Array<Record<string, number>>;
  report_minute_tower: Record<string, Record<string, number>>;
  report_prediction?: {
    hight_priority?: Record<string, string[]>;
    middle_priority?: Record<string, string[]>;
  };
};

export type DefenseSnapshotPayload = {
  snapshotId: number;
  fetchedAt: number;
  report: WeeklyReport;
};

export type DefenseOverview = {
  upstream: string;
  secondsToSync: number;
  snapshot: DefenseSnapshotPayload | null;
  historyCount: number;
  attackRecordCount?: number;
  lastRow: { id: number; fetchedAt: number; httpStatus: number; ok: number } | null;
};

export type DefenseHistoryRow = {
  id: number;
  fetched_at: number;
  http_status: number;
  ok: number;
};

export type DefenseAttackRow = {
  id: number;
  attack_at: number;
  attack_time_label: string;
  city_id: string;
  city_name: string;
  first_seen_snapshot_id: number;
  last_seen_snapshot_id: number;
  last_seen_fetched_at: number;
};

const BASE = "/__fmz_defense";

export async function fetchDefenseOverview(): Promise<DefenseOverview> {
  let r: Response;
  try {
    r = await fetch(`${BASE}/api/overview`);
  } catch (e) {
    throw new Error(
      `连不上本地攻城服务。请在项目根目录执行「npm run defense-tower-server」或「npm run dev:all」（需占用 8788）。详情：${String(e)}`,
    );
  }
  if (!r.ok) throw new Error(`overview HTTP ${r.status}`);
  const text = await r.text();
  let j: { code: number; data: DefenseOverview };
  try {
    j = JSON.parse(text) as { code: number; data: DefenseOverview };
  } catch {
    throw new Error(
      "overview 返回不是 JSON：多为未走 Vite 代理（开发请用 npm run dev）或 8788 未启动。",
    );
  }
  if (j.code !== 0) throw new Error("overview code");
  return j.data;
}

export async function postDefenseRefresh(): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(`${BASE}/api/refresh`, { method: "POST" });
  } catch (e) {
    throw new Error(`无法连接攻城服务：${String(e)}`);
  }
  if (!r.ok) throw new Error(`refresh HTTP ${r.status}`);
  const text = await r.text();
  let j: { code: number; data: unknown };
  try {
    j = JSON.parse(text) as { code: number; data: unknown };
  } catch {
    throw new Error("refresh 返回非 JSON，请确认攻城服务与代理已启动。");
  }
  if (j.code !== 0) throw new Error("refresh code");
  return j.data;
}

export async function fetchDefenseHistory(
  limit = 80,
): Promise<{ rows: DefenseHistoryRow[] }> {
  const r = await fetch(`${BASE}/api/history?limit=${encodeURIComponent(String(limit))}`);
  if (!r.ok) throw new Error(`history ${r.status}`);
  const j = (await r.json()) as { code: number; data: { rows: DefenseHistoryRow[] } };
  if (j.code !== 0) throw new Error("history code");
  return j.data;
}

export async function fetchDefenseRecentAttacks(
  limit = 60,
): Promise<{ rows: DefenseAttackRow[]; totalCount: number }> {
  const r = await fetch(`${BASE}/api/recent-attacks?limit=${encodeURIComponent(String(limit))}`);
  if (!r.ok) throw new Error(`recent-attacks ${r.status}`);
  const j = (await r.json()) as {
    code: number;
    data: { rows: DefenseAttackRow[]; totalCount: number };
  };
  if (j.code !== 0) throw new Error("recent-attacks code");
  return j.data;
}

export type PredictionCity = {
  cityId: string;
  cityName: string;
  weibull: { k: number; lambda: number; pity: number };
  sinceLastMin: number | null;
  justAppeared: boolean;
  pityProgress: number;
  prob5min: number;
  eta50: number | null;
  level: "high" | "medium" | "low" | "none";
  predictedTimes: string[];
  hotMinutes: { minute: number; count: number }[];
  sampleCount: number;
};

export type NextCityProb = {
  cityId: string;
  cityName: string;
  count: number;
  prob: number;
  pct: string;
};

export type PredictionData = {
  now: number;
  smallCityStreak: number;
  lastCityId: string | null;
  lastCityName: string | null;
  nextCityProbs: NextCityProb[];
  cities: PredictionCity[];
};

export async function fetchPrediction(): Promise<PredictionData> {
  const r = await fetch(`${BASE}/api/prediction`);
  if (!r.ok) throw new Error(`prediction ${r.status}`);
  const j = (await r.json()) as { code: number; data: PredictionData };
  if (j.code !== 0) throw new Error("prediction code");
  return j.data;
}

export const DEFENSE_TOWER_NAMES: Record<string, string> = {
  "1": "洛阳",
  "2": "成都",
  "3": "建业",
};

export const DEFENSE_SIEGE_CITY_NAMES: Record<string, string> = {
  "1": "洛阳",
  "2": "成都",
  "3": "建业",
  "4": "荆州",
  "5": "长安",
  "6": "许昌",
  "7": "汉中",
};

/** 近 60 分钟条目的合并热度（分钟 -> 合计次数） */
export function mergeMinuteHeat(
  report_minute: WeeklyReport["report_minute"] | undefined,
  top = 12,
): { minute: string; count: number }[] {
  if (!report_minute?.length) return [];
  const map = new Map<string, number>();
  for (const o of report_minute) {
    for (const [k, v] of Object.entries(o)) {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      map.set(k, (map.get(k) ?? 0) + n);
    }
  }
  return [...map.entries()]
    .map(([minute, count]) => ({ minute, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
}

/** 各城外攻城最常出现的「分钟刻度 00–59」 */
export function towerTopClockMinutes(
  report_minute_tower: WeeklyReport["report_minute_tower"] | undefined,
  towerId: string,
  top = 6,
): { minute: string; count: number }[] {
  const t = report_minute_tower?.[towerId];
  if (!t) return [];
  return Object.entries(t)
    .map(([minute, count]) => ({ minute, count: Number(count) || 0 }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
}

/** 与源站公告一致：数据在每分钟第 48 秒左右刷新 */
export function secondsToUpstreamSyncTick(): number {
  const sec = new Date().getSeconds();
  const target = 48;
  let rem = target - sec;
  if (rem < 0) rem += 60;
  return rem;
}
