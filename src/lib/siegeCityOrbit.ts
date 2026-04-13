import type { WeeklyReport } from "./defenseTowerApi";
import { ORBIT_SECTOR_PANEL } from "./orbitSectorPanel";

/** 分钟窗口选项：展示最近 N 分钟里各城的最近一次攻城时间 */
export const SIEGE_MINUTE_WINDOWS = [10, 30, 60, 120] as const;
export type SiegeMinuteWindow = (typeof SIEGE_MINUTE_WINDOWS)[number];

/** 最内圈只保留 6 个城市扇形 */
export const SIEGE_VISIBLE_CITY_COUNT = 6;
/** 攻城城市环相对中心 Hub 的内侧偏移（rem） */
export const SIEGE_CITY_INNER_OFFSET_REM = 0.28;
/** 攻城城市扇形的径向厚度（rem）：只保留装下城市名+时间所需的厚度 */
export const SIEGE_CITY_OUTER_EXTRA_REM = 1.58;
/** 最近一次攻城城市固定占据 0–60°，因此扇形中线位于 30° */
export const SIEGE_LATEST_CITY_MID_DEG = 30;

export type SiegeCitySlotDef = {
  cityId: string;
  name: string;
  accent: string;
};

const CITY_DEFS: SiegeCitySlotDef[] = [
  { cityId: "1", name: "洛阳", accent: "#F7B52A" },
  { cityId: "2", name: "成都", accent: "#8F42A2" },
  { cityId: "3", name: "建业", accent: "#F17EDF" },
  { cityId: "4", name: "荆州", accent: "#3B9E95" },
  { cityId: "5", name: "长安", accent: "#477FBE" },
  { cityId: "6", name: "许昌", accent: "#61A0C5" },
  { cityId: "7", name: "汉中", accent: "#69A7BF" },
];

const CITY_DEF_MAP = new Map(CITY_DEFS.map((item) => [item.cityId, item]));

export type SiegeCityMinuteSummary = SiegeCitySlotDef & {
  latestTimeLabel: string;
  latestMinuteIndex: number | null;
  attackCount: number;
  isLatest: boolean;
  opacityScale: number;
};

export type SiegeInnerCitySector = SiegeCityMinuteSummary & {
  slotIndex: number;
  a0: number;
  a1: number;
  innerRem: number;
  outerRem: number;
  labelRem: number;
  /** 0–1：活跃度，用于控制扇形亮度 */
  heatNorm: number;
};

type MinuteAttackEntry = {
  cityId: string;
  timeLabel: string;
  minuteIndex: number;
};

type VisibleCityState = SiegeCityMinuteSummary & {
  orderIndex: number;
};

function collectRecentMinuteEntries(
  report: WeeklyReport | null | undefined,
  maxMinutes: SiegeMinuteWindow,
): MinuteAttackEntry[] {
  const rows = report?.report_minute;
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const out: MinuteAttackEntry[] = [];
  for (const row of rows.slice(0, Math.max(1, maxMinutes))) {
    if (!row || typeof row !== "object") continue;
    for (const [timeLabel, rawCityId] of Object.entries(row)) {
      const cityId = String(rawCityId).trim();
      if (!timeLabel || !CITY_DEF_MAP.has(cityId)) continue;
      out.push({ cityId, timeLabel, minuteIndex: out.length });
      break;
    }
  }
  return out;
}

function rotateCitiesToLatest(latestCityId: string | null): SiegeCitySlotDef[] {
  if (!latestCityId) return [...CITY_DEFS];
  const latestIdx = CITY_DEFS.findIndex((item) => item.cityId === latestCityId);
  if (latestIdx <= 0) return [...CITY_DEFS];
  return [...CITY_DEFS.slice(latestIdx), ...CITY_DEFS.slice(0, latestIdx)];
}

function isBeijingLikeCity(city: SiegeCitySlotDef): boolean {
  return /北京/u.test(city.name) || /^beijing$/i.test(city.cityId);
}

function summarizeCitiesByMinuteWindow(
  report: WeeklyReport | null | undefined,
  maxMinutes: SiegeMinuteWindow,
): SiegeCityMinuteSummary[] {
  const entries = collectRecentMinuteEntries(report, maxMinutes);
  const latestCityId = entries[0]?.cityId ?? null;

  const state = new Map(
    CITY_DEFS.map((city) => [city.cityId, {
      latestTimeLabel: "—",
      latestMinuteIndex: null as number | null,
      attackCount: 0,
    }]),
  );

  for (const entry of entries) {
    const s = state.get(entry.cityId);
    if (!s) continue;
    s.attackCount += 1;
    if (s.latestMinuteIndex == null) {
      s.latestMinuteIndex = entry.minuteIndex;
      s.latestTimeLabel = entry.timeLabel;
    }
  }

  const rotated = rotateCitiesToLatest(latestCityId).map((city, orderIndex): VisibleCityState => {
    const s = state.get(city.cityId)!;
    return {
      ...city,
      latestTimeLabel: s.latestTimeLabel,
      latestMinuteIndex: s.latestMinuteIndex,
      attackCount: s.attackCount,
      isLatest: city.cityId === latestCityId,
      opacityScale: isBeijingLikeCity(city) ? 0.66 : 1,
      orderIndex,
    };
  });

  const active = rotated
    .filter((city) => city.latestMinuteIndex != null)
    .sort((a, b) => {
      if (a.isLatest !== b.isLatest) return a.isLatest ? -1 : 1;
      if (a.latestMinuteIndex !== b.latestMinuteIndex) {
        return (a.latestMinuteIndex ?? Number.MAX_SAFE_INTEGER)
          - (b.latestMinuteIndex ?? Number.MAX_SAFE_INTEGER);
      }
      if (a.attackCount !== b.attackCount) return b.attackCount - a.attackCount;
      return a.orderIndex - b.orderIndex;
    });

  const idle = rotated
    .filter((city) => city.latestMinuteIndex == null)
    .sort((a, b) => a.orderIndex - b.orderIndex);

  return [...active, ...idle]
    .slice(0, SIEGE_VISIBLE_CITY_COUNT)
    .map(({ orderIndex: _orderIndex, ...city }) => city);
}

export function buildInnerCitySectors(
  report: WeeklyReport | null | undefined,
  maxMinutes: SiegeMinuteWindow,
): SiegeInnerCitySector[] {
  const P = ORBIT_SECTOR_PANEL;
  const cities = summarizeCitiesByMinuteWindow(report, maxMinutes);
  const maxCount = Math.max(1, ...cities.map((item) => item.attackCount));
  const spanDeg = 360 / Math.max(1, cities.length);
  const seamDeg = 0.8;

  const innerRem = P.hubSectorInnerRem + SIEGE_CITY_INNER_OFFSET_REM;
  const outerRem = innerRem + SIEGE_CITY_OUTER_EXTRA_REM;
  const labelRem = innerRem + (outerRem - innerRem) * 0.52;

  return cities.map((city, slotIndex) => {
    const mid = SIEGE_LATEST_CITY_MID_DEG + slotIndex * spanDeg;
    const densityNorm = city.attackCount > 0 ? city.attackCount / maxCount : 0;
    const recencyNorm = city.latestMinuteIndex == null
      ? 0
      : Math.max(0, 1 - city.latestMinuteIndex / Math.max(1, maxMinutes - 1));
    const heatNorm = city.latestMinuteIndex == null
      ? 0.08
      : Math.min(1, Math.max(0.28, densityNorm * 0.44 + recencyNorm * 0.56));

    return {
      ...city,
      slotIndex,
      a0: mid - spanDeg / 2 + seamDeg / 2,
      a1: mid + spanDeg / 2 - seamDeg / 2,
      innerRem,
      outerRem,
      labelRem,
      heatNorm,
    };
  });
}

/** 外圈预测点相对内城环外沿的半径偏移 rem（在 siegeOrbitLayout 基值上叠加） */
export function predictionRingOffsetRem(): number {
  const P = ORBIT_SECTOR_PANEL;
  return P.hubSectorInnerRem
    + SIEGE_CITY_INNER_OFFSET_REM
    + SIEGE_CITY_OUTER_EXTRA_REM
    + P.ringRadialSeamRem
    + 0.35;
}
