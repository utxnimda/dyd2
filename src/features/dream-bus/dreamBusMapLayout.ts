/**
 * 梦幻巴士路线布局：按倍率升序排列站点，巴士沿该线前进。
 */
export type DreamBusRouteStop = {
  stationId: number;
  stationName: string;
  multiple: number;
  rate: number;
  /** 在路线上的横向位置 % */
  leftPct: number;
  topPct: number;
  /** 按倍率排序后的序号 0…n-1 */
  valueRank: number;
};

export type DreamBusRoutePoint = {
  stationId: number;
  leftPct: number;
  topPct: number;
};

/** 星级标签色带：5–10 橙、12–20 青、40+ 红 */
export function dreamBusStarBand(multiple: number): "orange" | "teal" | "red" {
  if (multiple >= 40) return "red";
  if (multiple >= 12) return "teal";
  return "orange";
}

/** 价值档位：高 3 / 中 3 / 低 6（按倍率） */
export function dreamBusValueTier(multiple: number): "high" | "mid" | "low" {
  if (multiple >= 40) return "high";
  if (multiple >= 12) return "mid";
  return "low";
}

/** 按倍率升序生成路线站点（低价值在左，高价值在右） */
export function buildValueRouteStops(
  stations: Array<{
    stationId: number;
    stationName: string;
    multiple: number;
    rate: number;
  }>,
): DreamBusRouteStop[] {
  const sorted = [...stations].sort(
    (a, b) => a.multiple - b.multiple || a.stationId - b.stationId,
  );
  const n = sorted.length;
  if (n === 0) return [];
  const leftMin = 6;
  const leftMax = 94;
  return sorted.map((st, i) => ({
    ...st,
    valueRank: i,
    leftPct: n === 1 ? 50 : leftMin + ((leftMax - leftMin) * i) / (n - 1),
    topPct: 50,
  }));
}

/** 发车点 + 各站，用于沿路线插值 */
export function buildValueRouteWaypoints(stops: DreamBusRouteStop[]): DreamBusRoutePoint[] {
  if (!stops.length) return [{ stationId: 0, leftPct: 4, topPct: 50 }];
  const first = stops[0];
  return [
    { stationId: 0, leftPct: Math.max(2, first.leftPct - 8), topPct: 50 },
    ...stops.map((s) => ({
      stationId: s.stationId,
      leftPct: s.leftPct,
      topPct: s.topPct,
    })),
  ];
}

/**
 * 沿倍率路线插值：progress 0–1 从发车点到最高价值站；揭晓时停在 hitStation。
 */
export function dreamBusRoutePosition(
  progress01: number,
  targetStationId: number,
  mode: "drive" | "reveal" | "idle",
  waypoints: DreamBusRoutePoint[],
): { leftPct: number; topPct: number } {
  if (!waypoints.length) return { leftPct: 4, topPct: 50 };
  if (mode === "reveal" && targetStationId > 0) {
    const st = waypoints.find((p) => p.stationId === targetStationId);
    if (st) return { leftPct: st.leftPct, topPct: st.topPct };
  }
  if (mode === "idle" || waypoints.length < 2) {
    return { leftPct: waypoints[0].leftPct, topPct: waypoints[0].topPct };
  }
  const clamped = Math.max(0, Math.min(1, progress01));
  const segCount = waypoints.length - 1;
  const f = clamped * segCount;
  const i = Math.min(segCount - 1, Math.floor(f));
  const t = f - i;
  const a = waypoints[i];
  const b = waypoints[i + 1];
  return {
    leftPct: a.leftPct + (b.leftPct - a.leftPct) * t,
    topPct: a.topPct + (b.topPct - a.topPct) * t,
  };
}

/** 开车阶段某站被经过的秒数（每段 1s） */
export function dreamBusStationDriveArrivalSec(
  stationId: number,
  waypoints: DreamBusRoutePoint[],
  segmentSec = 1,
): number | null {
  const idx = waypoints.findIndex((p) => p.stationId === stationId);
  if (idx <= 0) return null;
  return idx * segmentSec;
}

export type DreamBusStationDriveTiming = {
  stationId: number;
  /** 从开车起算，经过该站的秒数（0–driveSec） */
  arrivalSec: number;
  /** 开车「第 N 秒」标签（1 起算，ceil） */
  driveSecond: number;
};

/** 各站在开车中的到达时间表（每站 1s） */
export function buildStationDriveTimings(
  stops: DreamBusRouteStop[],
  waypoints: DreamBusRoutePoint[],
  segmentSec = 1,
): DreamBusStationDriveTiming[] {
  return stops.map((stop) => {
    const arrivalSec =
      dreamBusStationDriveArrivalSec(stop.stationId, waypoints, segmentSec) ?? 0;
    return {
      stationId: stop.stationId,
      arrivalSec,
      driveSecond: Math.max(1, Math.ceil(arrivalSec - 1e-6)),
    };
  });
}

export type DreamBusDriveSegmentContext = {
  elapsedSec: number;
  /** 开车第几秒（1…driveSec） */
  driveSecond: number;
  passedStationId: number;
  passedStationName: string;
  nextStationId: number;
  nextStationName: string;
};

function dreamBusWaypointLabel(
  wp: DreamBusRoutePoint,
  stops: Array<{ stationId: number; stationName: string }>,
): string {
  if (wp.stationId <= 0) return "起点";
  return stops.find((s) => s.stationId === wp.stationId)?.stationName ?? "—";
}

/** 开车经过 elapsedSec 时，刚经过哪站、下一站是哪 */
export function dreamBusDriveSegmentContext(
  elapsedSec: number,
  waypoints: DreamBusRoutePoint[],
  stops: Array<{ stationId: number; stationName: string }>,
  driveSec: number,
): DreamBusDriveSegmentContext {
  const segCount = Math.max(1, waypoints.length - 1);
  const progress = Math.min(1, Math.max(0, elapsedSec / driveSec));
  const f = progress * segCount;
  const segIdx = Math.min(segCount - 1, Math.max(0, Math.floor(f)));
  const passedWp = waypoints[segIdx] ?? waypoints[0];
  const nextWp = waypoints[segIdx + 1] ?? passedWp;
  return {
    elapsedSec,
    driveSecond: Math.min(
      driveSec,
      Math.max(1, Math.floor(elapsedSec) + 1),
    ),
    passedStationId: passedWp.stationId,
    passedStationName: dreamBusWaypointLabel(passedWp, stops),
    nextStationId: nextWp.stationId,
    nextStationName: dreamBusWaypointLabel(nextWp, stops),
  };
}

/** 格式化开车秒数标签 */
export function dreamBusFormatDriveSec(sec: number): string {
  if (sec >= 10) return `${Math.round(sec)}s`;
  const rounded = Math.round(sec * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}s` : `${rounded.toFixed(1)}s`;
}
