const CACHE_NAME = "fmz-dream-bus-voice-v1";

/** 到站语音 01v…12v + 发车 start*.mp3 */
export const DREAM_BUS_ALL_VOICE_URLS: string[] = [
  ...Object.values(
    import.meta.glob("../../../image/dream-bus/stations/voice/*.mp3", {
      eager: true,
      query: "?url",
      import: "default",
    }) as Record<string, string>,
  ),
];

const blobUrlByRemote = new Map<string, string>();
let prefetchPromise: Promise<void> | null = null;

function canUseCache(): boolean {
  return typeof window !== "undefined" && "caches" in window;
}

async function blobUrlFromCache(remoteUrl: string): Promise<string | null> {
  if (!canUseCache()) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(remoteUrl);
    if (!hit) return null;
    const blob = await hit.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

async function downloadToCache(remoteUrl: string): Promise<string | null> {
  try {
    const resp = await fetch(remoteUrl);
    if (!resp.ok) return null;
    if (canUseCache()) {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(remoteUrl, resp.clone());
      } catch {
        /* 缓存写入失败仍可用本次响应播放 */
      }
    }
    const blob = await resp.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

/** 手势解锁路径：仅同步读内存，避免 iOS Safari 因 await 丢失用户激活 */
export function resolveDreamBusVoicePlayUrlSync(remoteUrl: string): string {
  return blobUrlByRemote.get(remoteUrl) ?? remoteUrl;
}

/** 优先内存 → Cache Storage → 网络下载并写入缓存 */
export async function resolveDreamBusVoicePlayUrl(remoteUrl: string): Promise<string> {
  const cached = blobUrlByRemote.get(remoteUrl);
  if (cached) return cached;

  const fromStore = await blobUrlFromCache(remoteUrl);
  if (fromStore) {
    blobUrlByRemote.set(remoteUrl, fromStore);
    return fromStore;
  }

  const downloaded = await downloadToCache(remoteUrl);
  if (downloaded) {
    blobUrlByRemote.set(remoteUrl, downloaded);
    return downloaded;
  }

  return remoteUrl;
}

async function prefetchOne(remoteUrl: string): Promise<void> {
  if (blobUrlByRemote.has(remoteUrl)) return;
  const fromStore = await blobUrlFromCache(remoteUrl);
  if (fromStore) {
    blobUrlByRemote.set(remoteUrl, fromStore);
    return;
  }
  const downloaded = await downloadToCache(remoteUrl);
  if (downloaded) blobUrlByRemote.set(remoteUrl, downloaded);
}

/** 打开宝宝巴士页后预下载全部语音到本地（Cache + 内存 blob；桌面 HTMLAudio 用） */
export function prefetchDreamBusVoices(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (prefetchPromise) return prefetchPromise;
  prefetchPromise = Promise.all(DREAM_BUS_ALL_VOICE_URLS.map((u) => prefetchOne(u))).then(
    () => undefined,
  );
  return prefetchPromise;
}
