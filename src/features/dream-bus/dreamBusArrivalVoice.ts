import {
  prefetchDreamBusVoices,
  resolveDreamBusVoicePlayUrl,
} from "./dreamBusVoiceCache";

/** 按价值排序后的序号 0…n-1 → 01v.mp3 … 12v.mp3（image/dream-bus/stations/voice/） */
const VOICE_URL_BY_RANK: Record<number, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob("../../../image/dream-bus/stations/voice/[0-9][0-9]v.mp3", {
      eager: true,
      query: "?url",
      import: "default",
    }) as Record<string, string>,
  )
    .map(([path, url]) => {
      const m = /\/(\d{2})v\.mp3$/i.exec(path);
      return m ? [Number(m[1]), url] : null;
    })
    .filter((x): x is [number, string] => x != null),
);

/** 发车前倒计时语音 start01.mp3、start02.mp3 … */
const START_VOICE_URLS: string[] = Object.values(
  import.meta.glob("../../../image/dream-bus/stations/voice/start*.mp3", {
    eager: true,
    query: "?url",
    import: "default",
  }) as Record<string, string>,
);

export function dreamBusArrivalVoiceUrl(valueRank: number): string | null {
  const n = Math.max(1, Math.min(12, valueRank + 1));
  return VOICE_URL_BY_RANK[n] ?? null;
}

function pickRandomStartVoiceUrl(): string | null {
  if (!START_VOICE_URLS.length) return null;
  const i = Math.floor(Math.random() * START_VOICE_URLS.length);
  return START_VOICE_URLS[i] ?? null;
}

async function playVoiceUrl(url: string): Promise<void> {
  const src = await resolveDreamBusVoicePlayUrl(url);
  const audio = new Audio(src);
  audio.play().catch(() => {
    /* 浏览器自动播放策略等 */
  });
}

let lastVoiceKey = "";
let lastDepartureVoiceKey = "";

export function resetDreamBusArrivalVoiceSession(): void {
  lastVoiceKey = "";
  lastDepartureVoiceKey = "";
}

/** 页面打开时预下载全部语音（幂等） */
export { prefetchDreamBusVoices };

/** 抵达目标站时播放对应价值序号语音（每 session+站 仅一次） */
export function playDreamBusArrivalVoice(
  valueRank: number,
  sessionId: string,
): void {
  if (typeof window === "undefined") return;
  const url = dreamBusArrivalVoiceUrl(valueRank);
  if (!url) return;

  const key = `${sessionId}:${valueRank}`;
  if (key === lastVoiceKey) return;
  lastVoiceKey = key;

  void playVoiceUrl(url);
}

/** 准备阶段倒计时显示「还有 5 秒发车」时播放（每 session 随机一条 start 语音，仅一次） */
export function playDreamBusDepartureVoice(sessionId: string): void {
  if (typeof window === "undefined") return;
  if (!sessionId) return;

  const key = `${sessionId}:departure`;
  if (key === lastDepartureVoiceKey) return;
  lastDepartureVoiceKey = key;

  const url = pickRandomStartVoiceUrl();
  if (!url) return;

  void playVoiceUrl(url);
}
