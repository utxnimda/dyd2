/**
 * 倒计时：以服务端 phaseEndsAt（绝对截止毫秒）为主，刷新后仍准确。
 */
import type { DreamBusLive } from "./dreamBusApi";
import { dreamBusNowMs, syncDreamBusServerClock } from "./dreamBusServerClock";

let phaseEndsAtMs = 0;
let phaseEndsSessionId = "";

function interpCountdown(leftTime: number, updatedAt: number, nowMs: number): number {
  if (!Number.isFinite(leftTime)) return 0;
  if (!updatedAt) return Math.max(0, leftTime);
  return Math.max(0, leftTime - (nowMs - updatedAt) / 1000);
}

export function leftSecFromLive(live: DreamBusLive | null, nowMs = dreamBusNowMs()): number {
  if (!live) return 0;
  return interpCountdown(live.leftTime, live.updatedAt, nowMs);
}

/** 心跳 / SSE / 首次加载：写入阶段截止时刻 */
export function syncDreamBusPhaseDeadline(
  serverNowMs: number,
  leftRemainingSec: number,
  sessionId = "",
): void {
  syncDreamBusServerClock(serverNowMs);
  phaseEndsSessionId = String(sessionId ?? "").trim();
  phaseEndsAtMs = serverNowMs + Math.max(0, leftRemainingSec) * 1000;
}

export function resetDreamBusLiveHeartbeat(): void {
  phaseEndsAtMs = 0;
  phaseEndsSessionId = "";
}

export function dreamBusLiveLeftSec(live: DreamBusLive | null, nowMs = dreamBusNowMs()): number {
  if (!live) return 0;
  const sid = String(live.sessionId ?? "").trim();
  if (phaseEndsAtMs > 0 && sid && sid === phaseEndsSessionId) {
    return Math.max(0, (phaseEndsAtMs - nowMs) / 1000);
  }
  return leftSecFromLive(live, nowMs);
}

/** @deprecated 兼容旧调用 */
export function syncDreamBusLiveHeartbeat(
  serverNowMs: number,
  leftRemainingSec: number,
  sessionId = "",
): void {
  syncDreamBusPhaseDeadline(serverNowMs, leftRemainingSec, sessionId);
}
