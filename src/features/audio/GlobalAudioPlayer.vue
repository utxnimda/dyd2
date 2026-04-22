<script setup lang="ts">
import { ref, watch, computed, nextTick, onBeforeUnmount, onMounted } from "vue";
import {
  currentTrack,
  playerVisible,
  shuffleMode,
  shuffleModeLabels,
  shuffleModeIcons,
  playNext,
  playPrev,
  cycleShuffleMode,
  stopPlayback,
  playlist,
} from "./audioPlayerStore";

/* ---- Audio state ---- */
const audioEl = ref<HTMLAudioElement | null>(null);
const playing = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const volume = ref(1);
const seeking = ref(false);
const seekTime = ref(0);
const waitingForSeek = ref(false);

/* ---- Blob cache ---- */
const blobSrc = ref<string | null>(null);
const caching = ref(false);
const blobCache = new Map<string, string>();

/* ---- Drag state ---- */
const floatEl = ref<HTMLElement | null>(null);
const collapsed = ref(false);
const posX = ref(16);
const posY = ref(window.innerHeight - 120);
const dragging = ref(false);
const dragOffset = ref({ x: 0, y: 0 });

/* ---- Computed ---- */
const progress = computed(() => {
  if (duration.value <= 0) return 0;
  const t = seeking.value ? seekTime.value : currentTime.value;
  return Math.min(1, Math.max(0, t / duration.value));
});

const displayCurrent = computed(() => fmtTime(seeking.value ? seekTime.value : currentTime.value));
const displayDuration = computed(() => fmtTime(duration.value));

const trackLabel = computed(() => currentTrack.value?.label || "");
const trackBvid = computed(() => currentTrack.value?.bvid || "");
const hasPlaylist = computed(() => playlist.value.length > 1);

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* ---- Audio event handlers ---- */
function onLoadedMetadata() {
  if (audioEl.value) duration.value = audioEl.value.duration || 0;
  updateMediaSession();
}
function onTimeUpdate() {
  if (audioEl.value && !seeking.value && !waitingForSeek.value) {
    currentTime.value = audioEl.value.currentTime;
  }
  updateMediaPositionState();
}
function onSeeked() {
  waitingForSeek.value = false;
  if (audioEl.value) currentTime.value = audioEl.value.currentTime;
}
function onEnded() {
  playing.value = false;
  currentTime.value = 0;
  // "loop" mode is handled by audioEl.loop — this handler shouldn't fire.
  // "once" mode: stop, don't advance.
  // Other modes: auto-play next.
  playNext(/* fromEnded */ true);
}
function onPlay() {
  playing.value = true;
  updateMediaSessionPlaybackState();
}
function onPause() {
  playing.value = false;
  updateMediaSessionPlaybackState();
}

/* ---- Controls ---- */
function togglePlay() {
  if (!audioEl.value) return;
  if (playing.value) audioEl.value.pause();
  else audioEl.value.play().catch(() => {});
}

function setVolume(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value);
  volume.value = v;
  if (audioEl.value) audioEl.value.volume = v;
}

function close() {
  stopPlayback();
}

/* ---- Progress bar seek ---- */
const progressBar = ref<HTMLElement | null>(null);

function calcTimeFromPointer(e: PointerEvent): number {
  if (!progressBar.value || duration.value <= 0) return 0;
  const rect = progressBar.value.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * duration.value;
}

function commitSeek() {
  const t = seekTime.value;
  seeking.value = false;
  if (audioEl.value && isFinite(t) && duration.value > 0) {
    waitingForSeek.value = true;
    currentTime.value = t;
    audioEl.value.currentTime = t;
  }
}

function onSeekDown(e: PointerEvent) {
  if (duration.value <= 0 || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  seeking.value = true;
  seekTime.value = calcTimeFromPointer(e);
}
function onSeekMove(e: PointerEvent) {
  if (!seeking.value) return;
  seekTime.value = calcTimeFromPointer(e);
}
function onSeekUp(e: PointerEvent) {
  if (!seeking.value) return;
  seekTime.value = calcTimeFromPointer(e);
  commitSeek();
}
function onSeekLost() {
  if (seeking.value) commitSeek();
}

/* ---- Blob caching ---- */
onBeforeUnmount(() => {
  for (const url of blobCache.values()) URL.revokeObjectURL(url);
  blobCache.clear();
});

async function cacheAndPlay(remoteUrl: string) {
  if (blobCache.has(remoteUrl)) {
    blobSrc.value = blobCache.get(remoteUrl)!;
    await nextTick();
    if (audioEl.value) { audioEl.value.load(); audioEl.value.play().catch(() => {}); }
    return;
  }
  caching.value = true;
  try {
    const resp = await fetch(remoteUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    blobCache.set(remoteUrl, blobUrl);
    if (currentTrack.value?.url === remoteUrl) {
      blobSrc.value = blobUrl;
      await nextTick();
      if (audioEl.value) { audioEl.value.load(); audioEl.value.play().catch(() => {}); }
    }
  } catch {
    if (currentTrack.value?.url === remoteUrl) {
      blobSrc.value = remoteUrl;
      await nextTick();
      if (audioEl.value) { audioEl.value.load(); audioEl.value.play().catch(() => {}); }
    }
  } finally {
    caching.value = false;
  }
}

/* ---- Media Session API (background playback + lock screen controls) ---- */
function updateMediaSession() {
  if (!("mediaSession" in navigator) || !currentTrack.value) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: currentTrack.value.label,
    artist: currentTrack.value.bvid,
    album: "歌曲库",
  });
}

function updateMediaSessionPlaybackState() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.playbackState = playing.value ? "playing" : "paused";
}

function updateMediaPositionState() {
  if (!("mediaSession" in navigator) || !audioEl.value) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: duration.value || 0,
      playbackRate: audioEl.value.playbackRate,
      position: Math.min(currentTime.value, duration.value || 0),
    });
  } catch { /* ignore */ }
}

function setupMediaSessionHandlers() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.setActionHandler("play", () => {
    audioEl.value?.play().catch(() => {});
  });
  navigator.mediaSession.setActionHandler("pause", () => {
    audioEl.value?.pause();
  });
  navigator.mediaSession.setActionHandler("previoustrack", () => {
    playPrev();
  });
  navigator.mediaSession.setActionHandler("nexttrack", () => {
    playNext();
  });
  navigator.mediaSession.setActionHandler("seekto", (details) => {
    if (audioEl.value && details.seekTime != null) {
      audioEl.value.currentTime = details.seekTime;
      currentTime.value = details.seekTime;
    }
  });
}

onMounted(() => {
  setupMediaSessionHandlers();
});

/* ---- Drag logic for floating panel ---- */
function onDragStart(e: MouseEvent) {
  if (e.button !== 0) return;
  dragging.value = true;
  dragOffset.value = { x: e.clientX - posX.value, y: e.clientY - posY.value };
  e.preventDefault();
}

function onDragMove(e: MouseEvent) {
  if (!dragging.value) return;
  posX.value = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - dragOffset.value.x));
  posY.value = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragOffset.value.y));
}

function onDragEnd() {
  dragging.value = false;
}

onMounted(() => {
  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", onDragEnd);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);
});

/* ---- Watch track changes ---- */
watch(currentTrack, async (track) => {
  currentTime.value = 0;
  duration.value = 0;
  playing.value = false;
  seeking.value = false;
  waitingForSeek.value = false;
  caching.value = false;
  if (track) {
    blobSrc.value = null;
    cacheAndPlay(track.url);
  } else {
    blobSrc.value = null;
  }
});

/* ---- Sync audio.loop with shuffleMode ---- */
watch(shuffleMode, (mode) => {
  if (audioEl.value) {
    audioEl.value.loop = mode === "loop";
  }
}, { immediate: true });
</script>

<template>
  <Teleport to="body">
    <div
      v-if="playerVisible && currentTrack"
      ref="floatEl"
      class="gp"
      :class="{ collapsed, dragging }"
      :style="{ left: posX + 'px', top: posY + 'px' }"
    >
      <!-- Hidden audio element -->
      <audio
        ref="audioEl"
        :src="blobSrc"
        :loop="shuffleMode === 'loop'"
        preload="auto"
        @loadedmetadata="onLoadedMetadata"
        @timeupdate="onTimeUpdate"
        @seeked="onSeeked"
        @ended="onEnded"
        @play="onPlay"
        @pause="onPause"
      ></audio>

      <!-- Header (draggable) -->
      <div class="gp-header" @mousedown="onDragStart">
        <span class="gp-icon">🎵</span>
        <div class="gp-title" :title="trackLabel">
          <span class="gp-label">{{ trackLabel }}</span>
          <span class="gp-bvid">{{ trackBvid }}</span>
        </div>
        <div class="gp-header-btns">
          <button class="gp-hbtn" @click.stop="collapsed = !collapsed" :title="collapsed ? '展开' : '折叠'">
            {{ collapsed ? '▼' : '▲' }}
          </button>
          <button class="gp-hbtn close" @click.stop="close" title="关闭">✕</button>
        </div>
      </div>

      <!-- Body (hidden when collapsed) -->
      <div v-show="!collapsed" class="gp-body">
        <!-- Caching indicator -->
        <div v-if="caching" class="gp-caching">
          <span class="spinner"></span> 缓存中…
        </div>

        <!-- Progress bar -->
        <div
          ref="progressBar"
          class="gp-progress"
          @pointerdown="onSeekDown"
          @pointermove="onSeekMove"
          @pointerup="onSeekUp"
          @pointercancel="onSeekLost"
          @lostpointercapture="onSeekLost"
        >
          <div class="gp-track">
            <div class="gp-fill" :style="{ width: (progress * 100) + '%' }"></div>
            <div class="gp-thumb" :class="{ active: seeking }" :style="{ left: (progress * 100) + '%' }"></div>
          </div>
        </div>

        <!-- Time display -->
        <div class="gp-time">
          <span>{{ displayCurrent }}</span>
          <span>{{ displayDuration }}</span>
        </div>

        <!-- Controls row -->
        <div class="gp-controls">
          <!-- Shuffle mode -->
          <button
            class="gp-ctrl-btn shuffle"
            :class="{ active: shuffleMode !== 'off' }"
            :title="'播放模式: ' + shuffleModeLabels[shuffleMode]"
            @click="cycleShuffleMode"
          >
            {{ shuffleModeIcons[shuffleMode] }}
            <span class="gp-mode-label">{{ shuffleModeLabels[shuffleMode] }}</span>
          </button>

          <!-- Prev -->
          <button class="gp-ctrl-btn" title="上一首" :disabled="!hasPlaylist" @click="playPrev">⏮</button>

          <!-- Play / Pause -->
          <button class="gp-ctrl-btn play" @click="togglePlay" :title="playing ? '暂停' : '播放'">
            {{ playing ? '⏸' : '▶' }}
          </button>

          <!-- Next -->
          <button class="gp-ctrl-btn" title="下一首" :disabled="!hasPlaylist" @click="playNext">⏭</button>

          <!-- Volume -->
          <input
            type="range"
            class="gp-volume"
            min="0" max="1" step="0.05"
            :value="volume"
            @input="setVolume"
            title="音量"
          />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.gp {
  position: fixed;
  z-index: 10000;
  width: 320px;
  max-width: calc(100vw - 24px);
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--surface);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35), 0 2px 8px rgba(0, 0, 0, 0.15);
  backdrop-filter: blur(16px);
  overflow: hidden;
  transition: box-shadow 0.15s;
  user-select: none;
}
.gp.dragging {
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.45);
  opacity: 0.92;
}
.gp.collapsed {
  width: auto;
  min-width: 200px;
  max-width: 320px;
}

/* ---- Header ---- */
.gp-header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.6rem;
  cursor: grab;
  border-bottom: 1px solid var(--border);
  background: linear-gradient(180deg, rgba(255,255,255,0.04) 0%, transparent 100%);
}
.gp-header:active { cursor: grabbing; }

.gp-icon { font-size: 1rem; flex-shrink: 0; }

.gp-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}
.gp-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.2;
}
.gp-bvid {
  font-size: 0.62rem;
  color: var(--muted);
  font-family: monospace;
  line-height: 1.2;
}

.gp-header-btns {
  display: flex;
  gap: 0.15rem;
  flex-shrink: 0;
}
.gp-hbtn {
  width: 24px; height: 24px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  transition: color 0.12s, background 0.12s;
}
.gp-hbtn:hover { color: var(--text); background: var(--bg); }
.gp-hbtn.close:hover { color: #ff6b6b; }

/* ---- Body ---- */
.gp-body {
  padding: 0.5rem 0.6rem 0.55rem;
}

.gp-caching {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.68rem;
  color: var(--muted);
  margin-bottom: 0.3rem;
}

/* ---- Progress bar ---- */
.gp-progress {
  height: 20px;
  display: flex;
  align-items: center;
  cursor: pointer;
  position: relative;
  touch-action: none;
  user-select: none;
}
.gp-track {
  width: 100%;
  height: 4px;
  background: var(--border);
  border-radius: 2px;
  position: relative;
  overflow: visible;
  pointer-events: none;
  transition: height 0.1s;
}
.gp-progress:hover .gp-track { height: 6px; }
.gp-fill {
  height: 100%;
  background: var(--primary);
  border-radius: 2px;
  pointer-events: none;
}
.gp-thumb {
  position: absolute;
  top: 50%;
  width: 12px; height: 12px;
  border-radius: 50%;
  background: var(--primary);
  border: 2px solid var(--surface);
  box-shadow: 0 1px 4px rgba(0,0,0,0.3);
  transform: translate(-50%, -50%);
  pointer-events: none;
  transition: transform 0.1s;
}
.gp-thumb.active,
.gp-progress:hover .gp-thumb {
  transform: translate(-50%, -50%) scale(1.3);
}

/* ---- Time ---- */
.gp-time {
  display: flex;
  justify-content: space-between;
  font-size: 0.65rem;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  margin-top: 0.1rem;
  margin-bottom: 0.35rem;
}

/* ---- Controls ---- */
.gp-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
}

.gp-ctrl-btn {
  width: 30px; height: 30px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.72rem;
  flex-shrink: 0;
  transition: border-color 0.12s, background 0.12s;
}
.gp-ctrl-btn:hover { border-color: var(--primary); }
.gp-ctrl-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.gp-ctrl-btn.play {
  width: 36px; height: 36px;
  font-size: 0.85rem;
  background: var(--primary);
  color: var(--on-primary);
  border-color: var(--primary);
}
.gp-ctrl-btn.play:hover { opacity: 0.85; }

.gp-ctrl-btn.shuffle {
  width: auto;
  border-radius: 14px;
  padding: 0 0.5rem;
  gap: 0.2rem;
  font-size: 0.65rem;
}
.gp-ctrl-btn.shuffle.active {
  border-color: var(--primary);
  color: var(--primary);
}
.gp-mode-label {
  font-size: 0.6rem;
  font-weight: 600;
}

.gp-volume {
  width: 50px;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--border);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
  flex-shrink: 0;
}
.gp-volume::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 10px; height: 10px;
  border-radius: 50%;
  background: var(--text);
  cursor: pointer;
}
.gp-volume::-moz-range-thumb {
  width: 10px; height: 10px;
  border-radius: 50%;
  background: var(--text);
  cursor: pointer;
  border: none;
}

/* ---- Spinner ---- */
.spinner {
  display: inline-block;
  width: 0.85em; height: 0.85em;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: gp-spin 0.6s linear infinite;
}
@keyframes gp-spin { to { transform: rotate(360deg); } }

/* ---- Mobile ---- */
@media (max-width: 600px) {
  .gp { width: calc(100vw - 16px); max-width: none; border-radius: 12px; }
}
</style>
