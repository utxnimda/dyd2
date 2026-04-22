import { ref, computed, shallowRef } from "vue";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface PlayableTrack {
  /** Remote URL served by audio-extractor-server */
  url: string;
  /** Display label */
  label: string;
  /** BV id of the source video */
  bvid: string;
  /** Page number (multi-part video) */
  page: number;
  /** Duration in seconds (0 if unknown) */
  duration: number;
}

export type ShuffleMode = "once" | "loop" | "off" | "bv" | "all";

/* ------------------------------------------------------------------ */
/*  Singleton reactive state                                          */
/* ------------------------------------------------------------------ */

/** The track currently playing (null = nothing) */
export const currentTrack = shallowRef<PlayableTrack | null>(null);

/** Full playlist — all available tracks for next/prev/shuffle */
export const playlist = ref<PlayableTrack[]>([]);

/** Shuffle mode: off = sequential, bv = random within same BV, all = random from entire library */
export const shuffleMode = ref<ShuffleMode>("off");

/** Whether the global floating player is visible (user can dismiss it) */
export const playerVisible = ref(false);

/* ------------------------------------------------------------------ */
/*  Derived                                                           */
/* ------------------------------------------------------------------ */

/** Index of the current track in the playlist (-1 if not found) */
export const currentIndex = computed(() => {
  if (!currentTrack.value) return -1;
  return playlist.value.findIndex((t) => t.url === currentTrack.value!.url);
});

/** Unique BV ids in the playlist */
const bvSet = computed(() => {
  const s = new Set<string>();
  for (const t of playlist.value) s.add(t.bvid);
  return s;
});

/** Tracks sharing the same BV as the current track */
const sameBvTracks = computed(() => {
  if (!currentTrack.value) return [];
  const bv = currentTrack.value.bvid;
  return playlist.value.filter((t) => t.bvid === bv);
});

/* ------------------------------------------------------------------ */
/*  Actions                                                           */
/* ------------------------------------------------------------------ */

/** Start playing a specific track and show the player */
export function playTrack(track: PlayableTrack) {
  currentTrack.value = track;
  playerVisible.value = true;
}

/** Stop playback and hide the player */
export function stopPlayback() {
  currentTrack.value = null;
  playerVisible.value = false;
}

/** Replace the entire playlist（如从「宝宝no声」点歌时按 BV 顺序整表同步） */
export function setPlaylist(tracks: PlayableTrack[]) {
  playlist.value = tracks;
}

/** Append tracks to the playlist (de-duplicated by url) */
export function appendToPlaylist(tracks: PlayableTrack[]) {
  const existing = new Set(playlist.value.map((t) => t.url));
  const newTracks = tracks.filter((t) => !existing.has(t.url));
  if (newTracks.length > 0) {
    playlist.value = [...playlist.value, ...newTracks];
  }
}

/** Pick a random element from an array */
function pickRandom<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Play the next track based on the current shuffle mode.
 *  `fromEnded` = true means this was triggered by the "ended" event (auto-advance).
 *  In "once" mode, auto-advance does nothing; manual next still works. */
export function playNext(fromEnded = false) {
  // "once" mode: if auto-advance, just stop; manual skip still works
  if (fromEnded && shuffleMode.value === "once") return;

  // "loop" mode is handled in GlobalAudioPlayer (audioEl.loop), so playNext
  // should never be called from ended in loop mode. But if called manually, treat as sequential.

  if (playlist.value.length === 0) return;

  if (shuffleMode.value === "all") {
    const candidates = playlist.value.length > 1
      ? playlist.value.filter((t) => t.url !== currentTrack.value?.url)
      : playlist.value;
    const next = pickRandom(candidates);
    if (next) playTrack(next);
    return;
  }

  if (shuffleMode.value === "bv") {
    const pool = sameBvTracks.value;
    const candidates = pool.length > 1
      ? pool.filter((t) => t.url !== currentTrack.value?.url)
      : pool;
    const next = pickRandom(candidates);
    if (next) playTrack(next);
    return;
  }

  // Sequential ("off", "once", "loop" manual skip): play next in playlist
  const idx = currentIndex.value;
  if (idx < 0) {
    playTrack(playlist.value[0]);
  } else {
    const nextIdx = (idx + 1) % playlist.value.length;
    playTrack(playlist.value[nextIdx]);
  }
}

/** Play the previous track (sequential for off/once/loop — shuffle modes go random) */
export function playPrev() {
  if (playlist.value.length === 0) return;

  if (shuffleMode.value === "bv" || shuffleMode.value === "all") {
    // In shuffle modes, "prev" just picks another random
    playNext();
    return;
  }

  const idx = currentIndex.value;
  if (idx < 0) {
    playTrack(playlist.value[playlist.value.length - 1]);
  } else {
    const prevIdx = (idx - 1 + playlist.value.length) % playlist.value.length;
    playTrack(playlist.value[prevIdx]);
  }
}

/** Cycle shuffle mode: once → loop → off → bv → all → once */
export function cycleShuffleMode() {
  const modes: ShuffleMode[] = ["once", "loop", "off", "bv", "all"];
  const idx = modes.indexOf(shuffleMode.value);
  shuffleMode.value = modes[(idx + 1) % modes.length];
}

/** Shuffle mode display labels */
export const shuffleModeLabels: Record<ShuffleMode, string> = {
  once: "播放一次",
  loop: "单曲循环",
  off: "顺序",
  bv: "BV随机",
  all: "全部随机",
};

/** Shuffle mode icons */
export const shuffleModeIcons: Record<ShuffleMode, string> = {
  once: "1️⃣",
  loop: "🔂",
  off: "➡️",
  bv: "🔀",
  all: "🎲",
};
