/**
 * 宝宝巴士跑者：45s 起点准备 → 揭晓后逐站 1s 驶向目标 → 停留至下趟准备后消失。
 */
import type { DreamBusLive } from "./dreamBusApi";
import { dreamBusLiveLeftSec } from "./dreamBusLiveClock";
import { dreamBusNowMs } from "./dreamBusServerClock";
import {
  buildValueRouteWaypoints,
  dreamBusRoutePosition,
  type DreamBusRoutePoint,
} from "./dreamBusMapLayout";

/** status=0 准备阶段（起点站立倒计时） */
export const DREAM_BUS_PREP_SEC = 45;
export const DREAM_BUS_ROUND_SEC = DREAM_BUS_PREP_SEC;
/** status=2 揭晓展示总时长（与斗鱼 leftTime≈15 一致） */
export const DREAM_BUS_REVEAL_SEC = 15;
/** 每经过一站的行驶秒数 */
export const DREAM_BUS_DRIVE_SEGMENT_SEC = 1;
/** @deprecated 总时长随目标站段数变化，请用 dreamBusDriveDurationSec */
export const DREAM_BUS_DRIVE_SEC = 15;
/** @deprecated 不再回起点，到站停留至下趟准备 */
export const DREAM_BUS_RETURN_SEC = 2;

export type DreamBusRunnerPhase = "idle" | "wait" | "drive" | "hold" | "return";

export type DreamBusRunnerAnimState = {
  phase: DreamBusRunnerPhase;
  sessionId: string;
  driveStartedAt: number;
  holdStartedAt: number;
  returnStartedAt: number;
  arrivedStationId: number;
};

export function createDreamBusRunnerAnimState(): DreamBusRunnerAnimState {
  return {
    phase: "idle",
    sessionId: "",
    driveStartedAt: 0,
    holdStartedAt: 0,
    returnStartedAt: 0,
    arrivedStationId: 0,
  };
}

export function dreamBusInterpCountdown(
  leftTime: number,
  updatedAt: number,
  nowMs = Date.now(),
): number {
  if (!Number.isFinite(leftTime)) return 0;
  if (!updatedAt) return Math.max(0, leftTime);
  return Math.max(0, leftTime - (nowMs - updatedAt) / 1000);
}

export function dreamBusDisplaySeconds(seconds: number): number {
  return Math.max(0, Math.ceil(seconds - 1e-6));
}

function liveLeftSec(live: DreamBusLive, nowMs: number): number {
  return dreamBusLiveLeftSec(live, nowMs);
}

/** status=2 已流逝秒数：与斗鱼 leftTime 同源（15→0） */
export function dreamBusRevealElapsedSec(
  live: DreamBusLive | null,
  nowMs = dreamBusNowMs(),
): number {
  if (!live || String(live.status) !== "2") return 0;
  const left = liveLeftSec(live, nowMs);
  return Math.max(0, Math.min(DREAM_BUS_REVEAL_SEC, DREAM_BUS_REVEAL_SEC - left));
}

function driveElapsedSec(
  state: DreamBusRunnerAnimState,
  live: DreamBusLive | null,
  nowMs: number,
): number {
  if (live?.status === "2") {
    return dreamBusRevealElapsedSec(live, nowMs);
  }
  if (state.phase === "drive") {
    return Math.max(0, (nowMs - state.driveStartedAt) / 1000);
  }
  return 0;
}

/** 从起点到目标站需经过的段数 × 每段秒数 */
export function dreamBusDriveDurationSec(
  arrivedStationId: number,
  waypoints: DreamBusRoutePoint[],
  segmentSec = DREAM_BUS_DRIVE_SEGMENT_SEC,
): number {
  const idx = waypoints.findIndex((p) => p.stationId === arrivedStationId);
  if (idx <= 0) return segmentSec;
  return idx * segmentSec;
}

function dreamBusTargetWaypointIndex(
  arrivedStationId: number,
  waypoints: DreamBusRoutePoint[],
): number {
  const idx = waypoints.findIndex((p) => p.stationId === arrivedStationId);
  return idx > 0 ? idx : 0;
}

function dreamBusSegmentedLeftPct(
  elapsedSec: number,
  targetIdx: number,
  waypoints: DreamBusRoutePoint[],
  segmentSec = DREAM_BUS_DRIVE_SEGMENT_SEC,
): number {
  const startLeft = waypoints[0]?.leftPct ?? 4;
  if (targetIdx <= 0) return startLeft;

  const segIdx = Math.min(targetIdx - 1, Math.max(0, Math.floor(elapsedSec / segmentSec)));
  const segT = Math.min(
    1,
    Math.max(0, (elapsedSec - segIdx * segmentSec) / segmentSec),
  );
  const a = waypoints[segIdx] ?? waypoints[0];
  const b = waypoints[segIdx + 1] ?? a;
  return a.leftPct + (b.leftPct - a.leftPct) * segT;
}

function dreamBusSegmentedTopPx(
  elapsedSec: number,
  targetIdx: number,
  waypoints: DreamBusRoutePoint[],
  segmentSec = DREAM_BUS_DRIVE_SEGMENT_SEC,
  fallbackTopPx = 54,
): number {
  const startTop = waypoints[0]?.topPx ?? fallbackTopPx;
  if (targetIdx <= 0) return startTop;

  const segIdx = Math.min(targetIdx - 1, Math.max(0, Math.floor(elapsedSec / segmentSec)));
  const segT = Math.min(
    1,
    Math.max(0, (elapsedSec - segIdx * segmentSec) / segmentSec),
  );
  const a = waypoints[segIdx] ?? waypoints[0];
  const b = waypoints[segIdx + 1] ?? a;
  const aTop = a.topPx ?? fallbackTopPx;
  const bTop = b.topPx ?? fallbackTopPx;
  return aTop + (bTop - aTop) * segT;
}

/** 根据 live 信号切换动画阶段 */
export function syncDreamBusRunnerFromLive(
  state: DreamBusRunnerAnimState,
  live: DreamBusLive | null,
  nowMs = dreamBusNowMs(),
  waypoints: DreamBusRoutePoint[] = [],
): void {
  if (!live) {
    state.phase = "idle";
    state.sessionId = "";
    return;
  }

  const sid = String(live.sessionId ?? "");
  const status = String(live.status ?? "");
  const hitStation = Math.max(0, Number(live.hitStation) || 0);

  if (status === "0") {
    const entering =
      state.phase === "idle" ||
      state.sessionId !== sid ||
      state.phase === "hold" ||
      state.phase === "drive";
    if (state.sessionId !== sid) {
      state.sessionId = sid;
    }
    state.arrivedStationId = 0;
    state.phase = "wait";
    if (entering) {
      state.driveStartedAt = 0;
      state.holdStartedAt = 0;
    }
    return;
  }

  if (status === "2" && hitStation > 0) {
    const entering =
      state.sessionId !== sid ||
      state.phase === "wait" ||
      state.phase === "idle";
    if (entering) {
      state.sessionId = sid;
      state.arrivedStationId = hitStation;
      state.driveStartedAt = nowMs;
      const driveSec = dreamBusDriveDurationSec(hitStation, waypoints);
      const elapsed = dreamBusRevealElapsedSec(live, nowMs);
      state.phase = elapsed >= driveSec ? "hold" : "drive";
      if (state.phase === "hold") state.holdStartedAt = nowMs;
      return;
    }
    if (state.phase === "drive") {
      const driveSec = dreamBusDriveDurationSec(state.arrivedStationId, waypoints);
      if (dreamBusRevealElapsedSec(live, nowMs) >= driveSec) {
        state.phase = "hold";
        state.holdStartedAt = nowMs;
      }
    }
  }
}

/** 推进 drive → hold（到站停留至下趟准备，不再回起点） */
export function tickDreamBusRunnerAnim(
  state: DreamBusRunnerAnimState,
  live: DreamBusLive | null,
  nowMs = dreamBusNowMs(),
  waypoints: DreamBusRoutePoint[] = [],
): void {
  if (state.phase === "drive") {
    const driveSec = dreamBusDriveDurationSec(state.arrivedStationId, waypoints);
    const elapsed = driveElapsedSec(state, live, nowMs);
    if (elapsed >= driveSec) {
      state.phase = "hold";
      state.holdStartedAt = nowMs;
    }
  }
}

export function dreamBusRunnerLeftPct(
  state: DreamBusRunnerAnimState,
  waypoints: DreamBusRoutePoint[],
  nowMs = dreamBusNowMs(),
  live: DreamBusLive | null = null,
): number {
  const startLeft = waypoints[0]?.leftPct ?? 4;

  if (state.phase === "wait" || state.phase === "idle") {
    return startLeft;
  }

  if (state.phase === "drive") {
    const targetIdx = dreamBusTargetWaypointIndex(state.arrivedStationId, waypoints);
    const elapsed = driveElapsedSec(state, live, nowMs);
    return dreamBusSegmentedLeftPct(elapsed, targetIdx, waypoints);
  }

  if (state.phase === "hold") {
    return dreamBusRoutePosition(0, state.arrivedStationId, "reveal", waypoints)
      .leftPct;
  }

  return startLeft;
}

export function dreamBusRunnerTopPx(
  state: DreamBusRunnerAnimState,
  waypoints: DreamBusRoutePoint[],
  nowMs = dreamBusNowMs(),
  fallbackTopPx = 54,
  live: DreamBusLive | null = null,
): number {
  const startTop = waypoints[0]?.topPx ?? fallbackTopPx;

  if (state.phase === "wait" || state.phase === "idle") {
    return startTop;
  }

  if (state.phase === "drive") {
    const targetIdx = dreamBusTargetWaypointIndex(state.arrivedStationId, waypoints);
    const elapsed = driveElapsedSec(state, live, nowMs);
    return dreamBusSegmentedTopPx(elapsed, targetIdx, waypoints, DREAM_BUS_DRIVE_SEGMENT_SEC, fallbackTopPx);
  }

  if (state.phase === "hold") {
    const st = waypoints.find((p) => p.stationId === state.arrivedStationId);
    return st?.topPx ?? startTop;
  }

  return startTop;
}

export function dreamBusDriveProgress01(
  state: DreamBusRunnerAnimState,
  live: DreamBusLive | null,
  nowMs = Date.now(),
  waypoints: DreamBusRoutePoint[] = [],
): number {
  if (live?.status === "0" || state.phase === "wait") {
    const left = live ? liveLeftSec(live, nowMs) : DREAM_BUS_PREP_SEC;
    return Math.min(1, Math.max(0, (DREAM_BUS_PREP_SEC - left) / DREAM_BUS_PREP_SEC));
  }
  if (state.phase === "drive") {
    const driveSec = dreamBusDriveDurationSec(state.arrivedStationId, waypoints);
    const elapsed = (nowMs - state.driveStartedAt) / 1000;
    return Math.min(1, Math.max(0, elapsed / driveSec));
  }
  if (state.phase === "hold") return 1;
  return 0;
}

/** 发车后爬行 + 休假：共用服务端 live.leftTime（status=2） */
export function dreamBusPostDepartCountdownSec(
  state: DreamBusRunnerAnimState,
  live: DreamBusLive | null,
  nowMs = Date.now(),
  waypoints: DreamBusRoutePoint[] = [],
): number {
  if (state.phase !== "drive" && state.phase !== "hold") return 0;
  if (live?.status === "2") {
    return liveLeftSec(live, nowMs);
  }
  if (state.phase === "drive") {
    const driveSec = dreamBusDriveDurationSec(state.arrivedStationId, waypoints);
    return Math.max(0, driveSec - (nowMs - state.driveStartedAt) / 1000);
  }
  return 0;
}

export function dreamBusRunnerCountdownSec(
  state: DreamBusRunnerAnimState,
  live: DreamBusLive | null,
  nowMs = Date.now(),
  waypoints: DreamBusRoutePoint[] = [],
): number {
  if (state.phase === "wait" || live?.status === "0") {
    return live ? liveLeftSec(live, nowMs) : 0;
  }
  if (state.phase === "drive" || state.phase === "hold") {
    return dreamBusPostDepartCountdownSec(state, live, nowMs, waypoints);
  }
  if (live?.status === "2") {
    return dreamBusLiveLeftSec(live, nowMs);
  }
  return 0;
}

export function dreamBusRunnerUsesRunAnim(state: DreamBusRunnerAnimState): boolean {
  return state.phase === "drive";
}

export { buildValueRouteWaypoints };
