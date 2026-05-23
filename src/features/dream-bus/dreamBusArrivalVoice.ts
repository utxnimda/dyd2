import {
  DREAM_BUS_ALL_VOICE_URLS,
  prefetchDreamBusVoices,
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

function sampleUnlockUrl(): string | null {
  return START_VOICE_URLS[0] ?? DREAM_BUS_ALL_VOICE_URLS[0] ?? null;
}

function dreamBusVoicePageActive(): boolean {
  return typeof document === "undefined" || !document.hidden;
}

export function isDreamBusMobileTouch(): boolean {
  if (typeof window === "undefined") return false;
  if (isIosLike()) return true;
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return "ontouchstart" in window;
  }
}

function isIosLike(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

type AudioContextCtor = typeof AudioContext;

function getAudioContextClass(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

let audioCtx: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let domAudio: HTMLAudioElement | null = null;

let voiceUnlocked = false;
const pendingVoiceUrls: string[] = [];
const voiceUnlockListeners = new Set<() => void>();
const unlockStateListeners = new Set<(unlocked: boolean) => void>();
const decodedBuffers = new Map<string, AudioBuffer>();

export function isDreamBusVoiceUnlocked(): boolean {
  return voiceUnlocked;
}

/** 解锁成功后通知（用于补播到站/发车语音） */
export function onDreamBusVoiceUnlocked(fn: () => void): () => void {
  voiceUnlockListeners.add(fn);
  return () => voiceUnlockListeners.delete(fn);
}

/** 解锁状态变化（含 iOS 后台重置） */
export function onDreamBusVoiceUnlockState(fn: (unlocked: boolean) => void): () => void {
  unlockStateListeners.add(fn);
  fn(voiceUnlocked);
  return () => unlockStateListeners.delete(fn);
}

function notifyVoiceUnlocked(): void {
  for (const fn of voiceUnlockListeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

function setVoiceUnlocked(next: boolean): void {
  if (voiceUnlocked === next) return;
  voiceUnlocked = next;
  for (const fn of unlockStateListeners) {
    try {
      fn(next);
    } catch {
      /* ignore */
    }
  }
  if (next) notifyVoiceUnlocked();
}

function getAudioContext(): AudioContext | null {
  const Ctx = getAudioContextClass();
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  return audioCtx;
}

function ensureDomAudio(): HTMLAudioElement {
  if (domAudio) return domAudio;
  const audio = document.createElement("audio");
  audio.preload = "auto";
  audio.setAttribute("playsinline", "true");
  audio.setAttribute("webkit-playsinline", "true");
  audio.style.cssText =
    "position:fixed;width:0;height:0;opacity:0;pointer-events:none;left:-9999px;top:-9999px";
  document.body.appendChild(audio);
  domAudio = audio;
  return audio;
}

function stopCurrentPlayback(): void {
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      /* already stopped */
    }
    try {
      currentSource.disconnect();
    } catch {
      /* ignore */
    }
    currentSource = null;
  }
  if (domAudio) {
    domAudio.pause();
    domAudio.currentTime = 0;
  }
}

function pauseDreamBusVoice(): void {
  stopCurrentPlayback();
  if (isIosLike()) {
    setVoiceUnlocked(false);
    if (audioCtx?.state === "running") void audioCtx.suspend();
  }
}

/** 页面失焦时暂停；回焦点时不补播 */
export function bindDreamBusVoiceVisibility(root: Document = document): () => void {
  const onVis = () => {
    if (root.hidden) pauseDreamBusVoice();
  };
  root.addEventListener("visibilitychange", onVis);
  return () => root.removeEventListener("visibilitychange", onVis);
}

async function decodeVoiceBuffer(url: string): Promise<AudioBuffer | null> {
  const cached = decodedBuffers.get(url);
  if (cached) return cached;
  const ctx = getAudioContext();
  if (!ctx) return null;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const ab = await resp.arrayBuffer();
    const buf = await ctx.decodeAudioData(ab.slice(0));
    decodedBuffers.set(url, buf);
    return buf;
  } catch {
    return null;
  }
}

async function prefetchDecodedBuffers(): Promise<void> {
  if (!voiceUnlocked) return;
  await Promise.all(DREAM_BUS_ALL_VOICE_URLS.map((u) => decodeVoiceBuffer(u)));
}

function resumeWebAudioContext(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === "suspended") void ctx.resume();
}

/** 解锁后逐条播放待播队列；失败则保留队首供下次重试 */
async function flushPendingVoiceUrls(): Promise<void> {
  if (!dreamBusVoicePageActive() || !voiceUnlocked) return;
  while (pendingVoiceUrls.length > 0) {
    const url = pendingVoiceUrls[0]!;
    const ok = await playVoiceUrlInternal(url);
    if (ok) pendingVoiceUrls.shift();
    else break;
  }
}

function unlockWebAudioSilent(): boolean {
  const ctx = getAudioContext();
  if (!ctx) return false;
  try {
    if (ctx.state === "suspended") void ctx.resume();
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
    source.stop(ctx.currentTime + 0.02);
    return true;
  } catch {
    return false;
  }
}

async function warmUpAfterUnlock(sampleUrl: string): Promise<void> {
  resumeWebAudioContext();
  unlockWebAudioSilent();
  void prefetchDreamBusVoices();
  void decodeVoiceBuffer(sampleUrl);
  void prefetchDecodedBuffers();
  await flushPendingVoiceUrls();
}

/** 在用户手势中调用，解除 iOS / 移动端自动播放限制 */
export async function unlockDreamBusVoice(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (voiceUnlocked) return true;

  const sample = sampleUnlockUrl();
  if (!sample) return false;

  try {
    const audio = ensureDomAudio();
    audio.volume = 0.001;
    audio.src = sample;
    audio.load();
    await audio.play();
    audio.pause();
    audio.currentTime = 0;
    audio.volume = 1;
    setVoiceUnlocked(true);
    await warmUpAfterUnlock(sample);
    return true;
  } catch {
    if (!unlockWebAudioSilent()) return false;
    setVoiceUnlocked(true);
    await warmUpAfterUnlock(sample);
    return true;
  }
}

/** 桌面端预加载后尝试静默解锁（失败则仍依赖首次点击） */
export async function tryDreamBusVoiceBootUnlock(): Promise<void> {
  if (typeof window === "undefined" || isDreamBusMobileTouch()) return;
  await prefetchDreamBusVoices();
  await unlockDreamBusVoice();
}

/** 首次触摸/点击时解锁；返回取消监听的函数 */
export function bindDreamBusVoiceUnlock(root: HTMLElement | Document = document): () => void {
  const onGesture = () => {
    void unlockDreamBusVoice();
  };
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  root.addEventListener("touchstart", onGesture, opts);
  root.addEventListener("touchend", onGesture, opts);
  root.addEventListener("pointerdown", onGesture, opts);
  root.addEventListener("click", onGesture, opts);
  return () => {
    root.removeEventListener("touchstart", onGesture, opts);
    root.removeEventListener("touchend", onGesture, opts);
    root.removeEventListener("pointerdown", onGesture, opts);
    root.removeEventListener("click", onGesture, opts);
  };
}

async function playWithWebAudio(url: string): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      return false;
    }
  }
  const buffer = await decodeVoiceBuffer(url);
  if (!buffer) return false;
  try {
    stopCurrentPlayback();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
    currentSource = source;
    source.onended = () => {
      if (currentSource === source) currentSource = null;
    };
    return true;
  } catch {
    return false;
  }
}

async function playWithDomAudio(url: string): Promise<boolean> {
  try {
    const audio = ensureDomAudio();
    stopCurrentPlayback();
    audio.volume = 1;
    audio.src = url;
    audio.load();
    await audio.play();
    return true;
  } catch {
    return false;
  }
}

/** 已解锁时的实际播放；未解锁则入队 */
async function playVoiceUrlInternal(url: string): Promise<boolean> {
  if (!dreamBusVoicePageActive()) return false;

  resumeWebAudioContext();

  const domOk = await playWithDomAudio(url);
  if (domOk) return true;

  return playWithWebAudio(url);
}

async function playVoiceUrl(url: string): Promise<boolean> {
  if (!voiceUnlocked) {
    if (!pendingVoiceUrls.includes(url)) pendingVoiceUrls.push(url);
    return false;
  }
  return playVoiceUrlInternal(url);
}

let lastVoiceKey = "";
let lastDepartureVoiceKey = "";

export function resetDreamBusArrivalVoiceSession(): void {
  lastVoiceKey = "";
  lastDepartureVoiceKey = "";
}

/** 页面打开时预下载全部语音（幂等） */
export { prefetchDreamBusVoices };

/** 抵达目标站时播放（每 session+站 仅一次；播放失败可重试） */
export async function playDreamBusArrivalVoice(
  valueRank: number,
  sessionId: string,
): Promise<boolean> {
  if (typeof window === "undefined" || !dreamBusVoicePageActive()) return false;
  const url = dreamBusArrivalVoiceUrl(valueRank);
  if (!url) return false;

  const key = `${sessionId}:${valueRank}`;
  if (key === lastVoiceKey) return false;

  const ok = await playVoiceUrl(url);
  if (ok) lastVoiceKey = key;
  return ok;
}

/** 准备阶段「还有 5 秒发车」时播放（每 session 仅一次；失败可重试） */
export async function playDreamBusDepartureVoice(sessionId: string): Promise<boolean> {
  if (typeof window === "undefined" || !dreamBusVoicePageActive()) return false;
  if (!sessionId) return false;

  const key = `${sessionId}:departure`;
  if (key === lastDepartureVoiceKey) return false;

  const url = pickRandomStartVoiceUrl();
  if (!url) return false;

  const ok = await playVoiceUrl(url);
  if (ok) lastDepartureVoiceKey = key;
  return ok;
}
