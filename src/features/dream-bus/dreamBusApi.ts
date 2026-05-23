export type DreamBusStation = {
  stationId: number;
  stationName: string;
  multiple: number;
  rate: number;
};

export type DreamBusConfig = {
  gift_id?: number;
  gift_name?: string;
  gift_pic?: string;
  gift_price?: number;
  medal_name?: string;
  medal_pic?: string;
  propList?: Array<{
    awardId: number;
    awardName: string;
    awardPic: string;
    intimacy: number;
    price: number;
  }>;
  stations?: DreamBusStation[];
};

export type DreamBusLive = {
  sessionId: string;
  hitStation: number;
  leftTime: number;
  status: string;
  roomId: string;
  updatedAt: number;
  createTime?: number;
};

export type DreamBusRecord = {
  sessionId: string;
  hitStation: number;
  createTime: number;
  recordedAt: number;
  roomId: string;
  timeLabel?: string;
};

import {
  resetDreamBusLiveHeartbeat,
  syncDreamBusPhaseDeadline,
} from "./dreamBusLiveClock";

const API = "/__fmz_danmaku";

export type DreamBusLiveSnapshot = {
  live: DreamBusLive | null;
  serverNow: number;
  leftRemaining: number;
  phaseEndsAt: number;
};

let lastAppliedSessionId = "";

function applyDreamBusLiveSnapshot(j: Record<string, unknown>): DreamBusLiveSnapshot {
  const live = (j?.live ?? null) as DreamBusLive | null;
  const serverNow = Number(j?.serverNow ?? j?.ts);
  let leftRemaining = Number(j?.leftRemaining);
  const phaseEndsAt = Number(j?.phaseEndsAt);
  const sessionId = String((live as DreamBusLive | null)?.sessionId ?? "").trim();

  if (sessionId && lastAppliedSessionId && sessionId !== lastAppliedSessionId) {
    resetDreamBusLiveHeartbeat();
  }
  if (sessionId) lastAppliedSessionId = sessionId;
  else if (!live) lastAppliedSessionId = "";

  if (live && Number.isFinite(serverNow)) {
    if (!Number.isFinite(leftRemaining) && Number.isFinite(phaseEndsAt)) {
      leftRemaining = Math.max(0, (phaseEndsAt - serverNow) / 1000);
    }
    if (!Number.isFinite(leftRemaining)) {
      const updatedAt = Number(live.updatedAt) || 0;
      const leftTime = Number(live.leftTime) || 0;
      const elapsed = updatedAt > 0 ? Math.max(0, (serverNow - updatedAt) / 1000) : 0;
      leftRemaining = Math.max(0, leftTime - elapsed);
    }
    syncDreamBusPhaseDeadline(serverNow, leftRemaining, sessionId);
  } else if (!live) {
    resetDreamBusLiveHeartbeat();
    lastAppliedSessionId = "";
  }

  const endsAt =
    Number.isFinite(phaseEndsAt) && phaseEndsAt > 0
      ? phaseEndsAt
      : Number.isFinite(serverNow) && Number.isFinite(leftRemaining)
        ? serverNow + leftRemaining * 1000
        : 0;

  return {
    live,
    serverNow: Number.isFinite(serverNow) ? serverNow : 0,
    leftRemaining: Number.isFinite(leftRemaining) ? leftRemaining : 0,
    phaseEndsAt: endsAt,
  };
}

/** SSE dream-bus 事件：同步时钟 + 阶段截止 */
export function applyDreamBusSseEvent(d: {
  live?: DreamBusLive | null;
  serverNow?: number;
  leftRemaining?: number;
  phaseEndsAt?: number;
  ts?: number;
}): DreamBusLiveSnapshot {
  return applyDreamBusLiveSnapshot({
    live: d.live ?? null,
    serverNow: d.serverNow ?? d.ts,
    leftRemaining: d.leftRemaining,
    phaseEndsAt: d.phaseEndsAt,
  });
}

export async function fetchDreamBusLiveSnapshot(): Promise<DreamBusLiveSnapshot | null> {
  const r = await fetch(`${API}/dream-bus/live`);
  if (!r.ok) return null;
  const j = await r.json();
  return applyDreamBusLiveSnapshot(j as Record<string, unknown>);
}

export async function fetchDreamBusLive(): Promise<DreamBusLive | null> {
  const snap = await fetchDreamBusLiveSnapshot();
  return snap?.live ?? null;
}

export async function fetchDreamBusConfig(): Promise<DreamBusConfig | null> {
  const r = await fetch(`${API}/dream-bus/config`);
  if (!r.ok) return null;
  const j = await r.json();
  return (j?.config ?? null) as DreamBusConfig | null;
}

export async function fetchDreamBusRecords(limit = 1440): Promise<DreamBusRecord[]> {
  const r = await fetch(`${API}/dream-bus/records?limit=${encodeURIComponent(String(limit))}`);
  if (!r.ok) return [];
  const j = await r.json();
  return Array.isArray(j?.records) ? j.records : [];
}

/** 12 站配色（按 stationId 1–12） */
export const DREAM_BUS_STATION_ACCENTS: Record<number, string> = {
  1: "#8B7355",
  2: "#6B8E4E",
  3: "#4A90A4",
  4: "#7CB342",
  5: "#D4A574",
  6: "#2E7D52",
  7: "#F4A460",
  8: "#5DADE2",
  9: "#5A8FA8",
  10: "#48C9B0",
  11: "#4A8FC9",
  12: "#BB8FCE",
};

function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  const s = hex.replace("#", "").trim();
  if (s.length === 3) {
    return {
      r: parseInt(s[0] + s[0], 16),
      g: parseInt(s[1] + s[1], 16),
      b: parseInt(s[2] + s[2], 16),
    };
  }
  if (s.length === 6) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
    };
  }
  return null;
}

function relativeLuminance(r: number, g: number, b: number): number {
  const linear = [r, g, b].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

/** 过浅的主题色在面板底色上加深，避免边框/背景/文字看不清 */
export function dreamBusReadableAccent(hex: string): string {
  const rgb = parseHexColor(hex);
  if (!rgb) return hex;
  if (relativeLuminance(rgb.r, rgb.g, rgb.b) < 0.52) return hex;
  const mix = 0.58;
  const target = { r: 0x3a, g: 0x6a, b: 0x82 };
  const r = Math.round(rgb.r * (1 - mix) + target.r * mix);
  const g = Math.round(rgb.g * (1 - mix) + target.g * mix);
  const b = Math.round(rgb.b * (1 - mix) + target.b * mix);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

export function dreamBusStationName(
  stations: DreamBusStation[] | undefined,
  stationId: number,
): string {
  const row = stations?.find((s) => s.stationId === stationId);
  return row?.stationName ?? `站${stationId}`;
}

export function dreamBusStationAccent(stationId: number): string {
  return dreamBusReadableAccent(DREAM_BUS_STATION_ACCENTS[stationId] ?? "#69A7BF");
}

/** 到站时刻 HH:mm（优先 sessionId 内嵌时间，否则 createTime） */
export function dreamBusArrivalClock(
  sessionId: string,
  createTime?: number,
  timeLabel?: string,
): string {
  if (timeLabel && /^\d{2}:\d{2}$/.test(timeLabel)) return timeLabel;
  const s = String(sessionId || "");
  if (s.length >= 12) return `${s.slice(8, 10)}:${s.slice(10, 12)}`;
  if (createTime && Number.isFinite(createTime)) {
    const d = new Date(createTime * 1000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  return timeLabel ?? "—";
}
