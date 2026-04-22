<script setup lang="ts">
import { ref, watch, computed, nextTick, onBeforeUnmount } from "vue";

const props = defineProps<{
  src: string | null;
  label?: string;
}>();

const emit = defineEmits<{
  (e: "ended"): void;
  (e: "close"): void;
}>();

/* ---- State ---- */
const audioEl = ref<HTMLAudioElement | null>(null);
const playing = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const volume = ref(1);
const seeking = ref(false);
const seekTime = ref(0);
const waitingForSeek = ref(false); // Guard: ignore timeupdate until browser confirms seek

/* ---- Local blob cache (avoids repeated network traffic) ---- */
const blobSrc = ref<string | null>(null);   // The actual src fed to <audio>
const caching = ref(false);                 // True while downloading to blob
const cacheError = ref(false);              // True if blob download failed
const blobCache = new Map<string, string>(); // url → blobURL

/* ---- Computed ---- */
const progress = computed(() => {
  if (duration.value <= 0) return 0;
  const t = seeking.value ? seekTime.value : currentTime.value;
  return Math.min(1, Math.max(0, t / duration.value));
});

const displayCurrent = computed(() => {
  const t = seeking.value ? seekTime.value : currentTime.value;
  return fmtTime(t);
});

const displayDuration = computed(() => fmtTime(duration.value));

/* ---- Helpers ---- */
function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/* ---- Audio event handlers ---- */
function onLoadedMetadata() {
  if (audioEl.value) {
    duration.value = audioEl.value.duration || 0;
  }
}

function onTimeUpdate() {
  if (audioEl.value && !seeking.value && !waitingForSeek.value) {
    currentTime.value = audioEl.value.currentTime;
  }
}

/** Called when the browser has finished seeking to the new position */
function onSeeked() {
  waitingForSeek.value = false;
  if (audioEl.value) {
    currentTime.value = audioEl.value.currentTime;
  }
}

function onEnded() {
  playing.value = false;
  currentTime.value = 0;
  emit("ended");
}

function onPlay() { playing.value = true; }
function onPause() { playing.value = false; }

/* ---- Controls ---- */
function togglePlay() {
  if (!audioEl.value) return;
  if (playing.value) {
    audioEl.value.pause();
  } else {
    audioEl.value.play().catch(() => {});
  }
}

function setVolume(e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value);
  volume.value = v;
  if (audioEl.value) audioEl.value.volume = v;
}

/* ---- Progress bar seek via Pointer Events + setPointerCapture ---- */
const progressBar = ref<HTMLElement | null>(null);

function calcTimeFromPointer(e: PointerEvent): number {
  if (!progressBar.value || duration.value <= 0) return 0;
  const rect = progressBar.value.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  return ratio * duration.value;
}

/** Commit the seek — apply seekTime to the audio element */
function commitSeek() {
  const t = seekTime.value;
  seeking.value = false;
  if (audioEl.value && isFinite(t) && duration.value > 0) {
    // Set guard BEFORE assigning currentTime — the browser will fire
    // timeupdate with the OLD position before it finishes seeking.
    waitingForSeek.value = true;
    currentTime.value = t;              // Optimistic UI update
    audioEl.value.currentTime = t;      // Tell browser to seek
  }
}

function onPointerDown(e: PointerEvent) {
  if (duration.value <= 0 || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  seeking.value = true;
  seekTime.value = calcTimeFromPointer(e);
}

function onPointerMove(e: PointerEvent) {
  if (!seeking.value) return;
  seekTime.value = calcTimeFromPointer(e);
}

function onPointerUp(e: PointerEvent) {
  if (!seeking.value) return;
  seekTime.value = calcTimeFromPointer(e);
  commitSeek();
}

function onLostPointerCapture() {
  // If we're still in seeking state when capture is lost (e.g. touch cancel),
  // commit the seek at the last known position.
  if (seeking.value) {
    commitSeek();
  }
}

/* ---- Blob caching: download full file to local memory before playing ---- */

/** Revoke all cached blob URLs on unmount to free memory */
onBeforeUnmount(() => {
  for (const url of blobCache.values()) {
    URL.revokeObjectURL(url);
  }
  blobCache.clear();
});

async function cacheAndPlay(remoteUrl: string) {
  // Already cached?
  if (blobCache.has(remoteUrl)) {
    blobSrc.value = blobCache.get(remoteUrl)!;
    await nextTick();
    if (audioEl.value) {
      audioEl.value.load();
      audioEl.value.play().catch(() => {});
    }
    return;
  }

  // Download to blob
  caching.value = true;
  cacheError.value = false;
  try {
    const resp = await fetch(remoteUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    blobCache.set(remoteUrl, blobUrl);
    // Only apply if src hasn't changed while we were downloading
    if (props.src === remoteUrl) {
      blobSrc.value = blobUrl;
      await nextTick();
      if (audioEl.value) {
        audioEl.value.load();
        audioEl.value.play().catch(() => {});
      }
    }
  } catch {
    // Fallback: use remote URL directly (still works, just uses streaming)
    cacheError.value = true;
    if (props.src === remoteUrl) {
      blobSrc.value = remoteUrl;
      await nextTick();
      if (audioEl.value) {
        audioEl.value.load();
        audioEl.value.play().catch(() => {});
      }
    }
  } finally {
    caching.value = false;
  }
}

/* ---- Watch src changes ---- */
watch(() => props.src, async (newSrc) => {
  currentTime.value = 0;
  duration.value = 0;
  playing.value = false;
  seeking.value = false;
  waitingForSeek.value = false;
  caching.value = false;
  cacheError.value = false;
  if (newSrc) {
    blobSrc.value = null; // Clear old src while caching
    cacheAndPlay(newSrc);
  } else {
    blobSrc.value = null;
  }
});
</script>

<template>
  <div v-if="src" class="ap-bar">
    <!-- Hidden native audio element -->
    <!-- Caching indicator -->
    <div v-if="caching" class="ap-bar-caching">
      <span class="spinner"></span> 缓存中…
    </div>

    <audio
      ref="audioEl"
      :src="blobSrc"
      autoplay
      preload="auto"
      @loadedmetadata="onLoadedMetadata"
      @timeupdate="onTimeUpdate"
      @seeked="onSeeked"
      @ended="onEnded"
      @play="onPlay"
      @pause="onPause"
    ></audio>

    <!-- Label -->
    <span v-if="label" class="ap-bar-label" :title="label">🎵 {{ label }}</span>

    <!-- Play / Pause -->
    <button class="ap-bar-btn play" @click="togglePlay" :title="playing ? '暂停' : '播放'">
      {{ playing ? '⏸' : '▶' }}
    </button>

    <!-- Time current -->
    <span class="ap-bar-time">{{ displayCurrent }}</span>

    <!-- Progress bar (draggable via pointer capture) -->
    <div
      ref="progressBar"
      class="ap-bar-progress"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onLostPointerCapture"
      @lostpointercapture="onLostPointerCapture"
    >
      <div class="ap-bar-track">
        <div class="ap-bar-fill" :style="{ width: (progress * 100) + '%' }"></div>
        <div
          class="ap-bar-thumb"
          :class="{ active: seeking }"
          :style="{ left: (progress * 100) + '%' }"
        ></div>
      </div>
    </div>

    <!-- Time duration -->
    <span class="ap-bar-time">{{ displayDuration }}</span>

    <!-- Volume -->
    <input
      type="range"
      class="ap-bar-volume"
      min="0"
      max="1"
      step="0.05"
      :value="volume"
      @input="setVolume"
      title="音量"
    />

    <!-- Close -->
    <button class="ap-bar-btn close" @click="$emit('close')" title="关闭">✕</button>
  </div>
</template>

<style scoped>
.ap-bar {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.45rem 0.75rem;
  background: var(--surface);
  border-top: 1px solid var(--border);
  box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
  min-height: 42px;
}

.ap-bar-label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}

.ap-bar-btn {
  width: 28px;
  height: 28px;
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
.ap-bar-btn:hover {
  border-color: var(--primary);
  background: var(--surface);
}
.ap-bar-btn.play {
  width: 32px;
  height: 32px;
  font-size: 0.82rem;
}
.ap-bar-btn.close {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 1rem;
  width: 24px;
  height: 24px;
}
.ap-bar-btn.close:hover {
  color: var(--text);
}

.ap-bar-time {
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  flex-shrink: 0;
  min-width: 36px;
  text-align: center;
}

/* ---- Progress bar ---- */
.ap-bar-progress {
  flex: 1;
  height: 24px;
  display: flex;
  align-items: center;
  cursor: pointer;
  position: relative;
  touch-action: none; /* Prevent scroll/pan on touch drag */
  user-select: none;  /* Prevent text selection during drag */
}

.ap-bar-track {
  width: 100%;
  height: 4px;
  background: var(--border);
  border-radius: 2px;
  position: relative;
  overflow: visible;
  transition: height 0.1s;
  pointer-events: none; /* Let parent .ap-bar-progress handle all pointer events */
}

.ap-bar-fill {
  height: 100%;
  background: var(--primary);
  border-radius: 2px;
  pointer-events: none;
}

.ap-bar-thumb {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--primary);
  border: 2px solid var(--surface);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  transform: translate(-50%, -50%);
  transition: transform 0.1s, box-shadow 0.1s;
  pointer-events: none;
}
.ap-bar-thumb.active,
.ap-bar-progress:hover .ap-bar-thumb {
  transform: translate(-50%, -50%) scale(1.3);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.ap-bar-progress:hover .ap-bar-track {
  height: 6px;
}

/* ---- Volume slider ---- */
.ap-bar-volume {
  width: 60px;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--border);
  border-radius: 2px;
  outline: none;
  flex-shrink: 0;
  cursor: pointer;
}
.ap-bar-volume::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text);
  cursor: pointer;
}
.ap-bar-volume::-moz-range-thumb {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text);
  cursor: pointer;
  border: none;
}

/* ---- Caching indicator ---- */
.ap-bar-caching {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.72rem;
  color: var(--muted);
  flex-shrink: 0;
  white-space: nowrap;
}
.spinner {
  display: inline-block;
  width: 0.85em;
  height: 0.85em;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: ap-spin 0.6s linear infinite;
}
@keyframes ap-spin { to { transform: rotate(360deg); } }

/* ---- Mobile ---- */
@media (max-width: 600px) {
  .ap-bar { gap: 0.3rem; padding: 0.35rem 0.5rem; }
  .ap-bar-label { max-width: 100px; font-size: 0.72rem; }
  .ap-bar-volume { width: 40px; }
}
</style>
