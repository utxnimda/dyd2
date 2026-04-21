import type { WeeklyReport } from "./defenseTowerApi";
import { DEFENSE_TOWER_NAMES } from "./defenseTowerApi";
import { predictionRingOffsetRem } from "./siegeCityOrbit";

export type SiegeOrbitPlaced = {
  id: string;
  angleDeg: number;
  /** 与战斗爽一致：赤道半径 rem，translateY(-orbitRRem) */
  orbitRRem: number;
  accent: string;
  towerName: string;
  tier: "high" | "mid";
  timeLabel: string;
  deltaLabel: string;
};

const TOWER_ACCENT: Record<string, string> = {
  "1": "#F7B52A",
  "2": "#8F42A2",
  "3": "#F17EDF",
};

/** 内圈更近：按距现在分钟数分环（与 translateY 负向一致：半径小=内圈） */
const RING_DELTA_MIN: readonly number[] = [0, 25, 70, 180, 720];
/** 每环赤道半径 rem（内→外），与 ORBIT_SECTOR_PANEL 尺度协调 */
export const SIEGE_ORBIT_RING_R_REM: readonly number[] = [
  5.85, 8.55, 11.35, 14.05, 16.85,
];

/** 预测外环：整体外移，避免与内圈 10 城扇形重叠 */
export function getSiegePredictionRingRRem(): number[] {
  const off = predictionRingOffsetRem();
  const d = off - SIEGE_ORBIT_RING_R_REM[0];
  return SIEGE_ORBIT_RING_R_REM.map((r) => r + d);
}

const RING_R_REM = getSiegePredictionRingRRem();

export function parseUpstreamDateTime(s: string): number | null {
  const t = s.trim();
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const ms = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    m[6] != null ? Number(m[6]) : 0,
    0,
  ).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function ringIndexForDeltaMin(deltaMin: number): number {
  if (deltaMin < 0) return RING_R_REM.length - 1;
  for (let i = RING_DELTA_MIN.length - 1; i >= 0; i--) {
    if (deltaMin >= RING_DELTA_MIN[i]) return Math.min(i, RING_R_REM.length - 1);
  }
  return 0;
}

function formatDeltaLabel(deltaMs: number): string {
  if (deltaMs <= -60_000) return "已过";
  if (deltaMs <= 0) return "临近";
  const m = Math.floor(deltaMs / 60_000);
  if (m < 1) return "1分钟内";
  if (m < 60) return `${m} 分钟后`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h} 小时 ${mm} 分后` : `${h} 小时后`;
}

function formatTimeLabel(ms: number): string {
  try {
    const d = new Date(ms);
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

function collectPredictionEvents(report: WeeklyReport | null | undefined): {
  at: number;
  tower: string;
  tier: "high" | "mid";
}[] {
  if (!report?.report_prediction) return [];
  const pred = report.report_prediction;
  const out: { at: number; tower: string; tier: "high" | "mid" }[] = [];
  const hi = pred.hight_priority;
  const mid = pred.middle_priority;
  for (const tier of ["high", "mid"] as const) {
    const block = tier === "high" ? hi : mid;
    if (!block) continue;
    for (const tid of ["1", "2", "3"] as const) {
      const arr = block[tid];
      if (!Array.isArray(arr)) continue;
      for (const s of arr) {
        const at = parseUpstreamDateTime(String(s));
        if (at == null) continue;
        out.push({ at, tower: tid, tier });
      }
    }
  }
  return out;
}

/** 同一时刻、同城保留一条：高优先覆盖中优先 */
function dedupeByTowerAndTime(
  events: { at: number; tower: string; tier: "high" | "mid" }[],
): { at: number; tower: string; tier: "high" | "mid" }[] {
  const m = new Map<string, { at: number; tower: string; tier: "high" | "mid" }>();
  for (const e of events) {
    const k = `${e.at}|${e.tower}`;
    const prev = m.get(k);
    if (!prev) m.set(k, e);
    else if (e.tier === "high" && prev.tier === "mid") m.set(k, e);
  }
  return [...m.values()].sort((a, b) => a.at - b.at);
}

/**
 * 将预测时间点摆到同心轨道上：距现在越近 → ring 越小 → orbitRRem 越小（越内圈）。
 */
export function buildSiegeOrbitPlacements(
  report: WeeklyReport | null | undefined,
  nowMs: number,
): SiegeOrbitPlaced[] {
  const raw = collectPredictionEvents(report);
  const horizon = nowMs + 72 * 3600 * 1000;
  const filtered = dedupeByTowerAndTime(
    raw.filter((e) => e.at >= nowMs - 3 * 60_000 && e.at <= horizon),
  );

  const byRing: SiegeOrbitPlaced[][] = RING_R_REM.map(() => []);
  for (const e of filtered) {
    const deltaMin = (e.at - nowMs) / 60_000;
    const ri = ringIndexForDeltaMin(deltaMin);
    const towerName = DEFENSE_TOWER_NAMES[e.tower] ?? e.tower;
    const accent = TOWER_ACCENT[e.tower] ?? "var(--primary)";
    byRing[ri].push({
      id: `siege-${e.tower}-${e.at}-${e.tier}`,
      angleDeg: 0,
      orbitRRem: RING_R_REM[ri] ?? RING_R_REM[RING_R_REM.length - 1],
      accent,
      towerName,
      tier: e.tier,
      timeLabel: formatTimeLabel(e.at),
      deltaLabel: formatDeltaLabel(e.at - nowMs),
    });
  }

  const out: SiegeOrbitPlaced[] = [];
  for (const ring of byRing) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const p = ring[i]!;
      p.angleDeg = n <= 1 ? 0 : (360 * i) / n;
      out.push(p);
    }
  }
  return out;
}
