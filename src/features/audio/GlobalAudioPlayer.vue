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
const trackPageLabel = computed(() => {
  const p = currentTrack.value?.page;
  if (p == null || p < 1) return "";
  return `P${p}`;
});
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
    artist: `P${currentTrack.value.page}`,
    album: "忽闻宝声",
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

/* ---- Drag logic: Pointer Events，兼容触摸（旧版仅用 mouse* 在手机上拖不动） ---- */
function clampPanelPos() {
  const w = floatEl.value?.offsetWidth ?? 320;
  const h = floatEl.value?.offsetHeight ?? 80;
  const maxX = Math.max(0, window.innerWidth - w);
  const maxY = Math.max(0, window.innerHeight - h);
  posX.value = Math.max(0, Math.min(maxX, posX.value));
  posY.value = Math.max(0, Math.min(maxY, posY.value));
}

function onHeaderPointerDown(e: PointerEvent) {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  dragging.value = true;
  dragOffset.value = { x: e.clientX - posX.value, y: e.clientY - posY.value };
  e.preventDefault();
}

function onHeaderPointerMove(e: PointerEvent) {
  if (!dragging.value) return;
  const w = floatEl.value?.offsetWidth ?? 320;
  const h = floatEl.value?.offsetHeight ?? 80;
  const maxX = Math.max(0, window.innerWidth - w);
  const maxY = Math.max(0, window.innerHeight - h);
  posX.value = Math.max(0, Math.min(maxX, e.clientX - dragOffset.value.x));
  posY.value = Math.max(0, Math.min(maxY, e.clientY - dragOffset.value.y));
  e.preventDefault();
}

function onHeaderPointerUp(e: PointerEvent) {
  if (!dragging.value) return;
  dragging.value = false;
  const el = e.currentTarget as HTMLElement;
  try {
    el.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
}

let resizeClamp: (() => void) | null = null;

onMounted(() => {
  setupMediaSessionHandlers();
  if (typeof window === "undefined") return;
  resizeClamp = () => clampPanelPos();
  window.addEventListener("resize", resizeClamp);
  nextTick(() => clampPanelPos());
});
onBeforeUnmount(() => {
  if (resizeClamp && typeof window !== "undefined") {
    window.removeEventListener("resize", resizeClamp);
  }
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

      <!-- 顶部细进度条：折叠时也可见，类似底部迷你条上的播放进度感 -->
      <div
        class="gp-top-rail"
        :class="{ thin: collapsed }"
        aria-hidden="true"
      >
        <div class="gp-top-rail-fill" :style="{ width: (progress * 100) + '%' }" />
      </div>

      <!-- Header：拖拽；右侧按钮不触发展开拖动 -->
      <div
        class="gp-header"
        @pointerdown="onHeaderPointerDown"
        @pointermove="onHeaderPointerMove"
        @pointerup="onHeaderPointerUp"
        @pointercancel="onHeaderPointerUp"
      >
        <div class="gp-meta" :title="trackLabel + (trackPageLabel ? ' · ' + trackPageLabel : '')">
          <div class="gp-label">{{ trackLabel }}</div>
          <div v-if="trackPageLabel" class="gp-sub">
            <span class="gp-sub-p">{{ trackPageLabel }}</span>
          </div>
        </div>
        <div class="gp-header-tools" @pointerdown.stop>
          <button
            class="gp-play-mini"
            type="button"
            :aria-label="playing ? '暂停' : '播放'"
            :title="playing ? '暂停' : '播放'"
            @click.stop="togglePlay"
          >
            {{ playing ? "⏸" : "▶" }}
          </button>
          <button
            class="gp-hbtn"
            type="button"
            :aria-expanded="!collapsed"
            :aria-label="collapsed ? '展开控制区' : '收起控制区'"
            @click.stop="collapsed = !collapsed"
            :title="collapsed ? '展开' : '收起'"
          >
            <span class="gp-chev" :class="{ up: !collapsed }" />
          </button>
          <button class="gp-hbtn close" type="button" aria-label="关闭播放器" @click.stop="close" title="关闭">×</button>
        </div>
      </div>

      <!-- Body：完整进度、时间、主控区 -->
      <div v-show="!collapsed" class="gp-body">
        <div v-if="caching" class="gp-caching">
          <span class="spinner"></span> 加载音频…
        </div>
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
            <div class="gp-fill" :style="{ width: (progress * 100) + '%' }" />
            <div class="gp-thumb" :class="{ active: seeking }" :style="{ left: (progress * 100) + '%' }" />
          </div>
        </div>
        <div class="gp-time">
          <span>{{ displayCurrent }}</span>
          <span>{{ displayDuration }}</span>
        </div>
        <div class="gp-controls">
          <button
            class="gp-mode"
            type="button"
            :class="{ on: shuffleMode !== 'off' }"
            :title="'播放模式: ' + shuffleModeLabels[shuffleMode]"
            @click="cycleShuffleMode"
          >
            <span class="gp-mode-ico">{{ shuffleModeIcons[shuffleMode] }}</span>
            <span class="gp-mode-txt">{{ shuffleModeLabels[shuffleMode] }}</span>
          </button>
          <div class="gp-transport">
            <button class="gp-tile" type="button" title="上一首" :disabled="!hasPlaylist" @click="playPrev">⏮</button>
            <button class="gp-tile gp-tile--main" type="button" @click="togglePlay" :title="playing ? '暂停' : '播放'">
              {{ playing ? "⏸" : "▶" }}
            </button>
            <button class="gp-tile" type="button" title="下一首" :disabled="!hasPlaylist" @click="playNext">⏭</button>
          </div>
          <div class="gp-vol" title="音量">
            <input
              type="range"
              class="gp-volume"
              min="0"
              max="1"
              step="0.05"
              :value="volume"
              @input="setVolume"
            />
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.gp {
  --gp-surface: color-mix(in srgb, var(--surface) 48%, transparent);
  position: fixed;
  z-index: 10000;
  width: 340px;
  max-width: calc(100vw - 24px);
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, #fff 12%, var(--border));
  background: linear-gradient(
    160deg,
    color-mix(in srgb, var(--primary) 18%, transparent) 0%,
    var(--gp-surface) 38%,
    color-mix(in srgb, var(--bg) 28%, transparent) 100%
  );
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.22),
    0 2px 8px rgba(0, 0, 0, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.12),
    inset 0 0 0 1px rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(32px) saturate(1.45);
  -webkit-backdrop-filter: blur(32px) saturate(1.45);
  overflow: hidden;
  transition: box-shadow 0.2s, transform 0.1s, opacity 0.2s;
  user-select: none;
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .gp {
    background: linear-gradient(
      160deg,
      color-mix(in srgb, var(--primary) 8%, var(--surface)) 0%,
      var(--surface) 100%
    );
  }
}
.gp.dragging {
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.28),
    0 4px 12px rgba(0, 0, 0, 0.15),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  opacity: 0.92;
  cursor: grabbing;
}
.gp.collapsed {
  width: auto;
  min-width: 240px;
  max-width: min(100vw - 16px, 400px);
}

/* 顶沿进度条：半透明槽 + 高亮 */
.gp-top-rail {
  height: 3px;
  background: color-mix(in srgb, var(--text) 10%, transparent);
  position: relative;
  overflow: hidden;
  border-radius: 14px 14px 0 0;
}
.gp-top-rail.thin {
  height: 2px;
}
.gp-top-rail-fill {
  height: 100%;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--primary) 85%, transparent),
    color-mix(in srgb, var(--primary) 40%, #fff)
  );
  box-shadow: 0 0 10px color-mix(in srgb, var(--primary) 45%, transparent);
  border-radius: 0 2px 2px 0;
  pointer-events: none;
}

/* ---- 头：标题 + 分P + 迷你播放 + 工具 ---- */
.gp-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem 0.6rem 0.55rem 0.6rem;
  cursor: grab;
  border-bottom: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: color-mix(in srgb, #fff 5%, transparent);
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}
.gp-header:active { cursor: grabbing; }

.gp-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.12rem;
}
.gp-label {
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.25;
  letter-spacing: 0.01em;
}
.gp-sub {
  display: flex;
  align-items: center;
  line-height: 1.2;
}
.gp-sub-p {
  font-weight: 700;
  font-size: 0.58rem;
  color: var(--primary);
  font-variant-numeric: tabular-nums;
}
.gp-header-tools {
  display: flex;
  align-items: center;
  gap: 0.2rem;
  flex-shrink: 0;
}
.gp-play-mini {
  width: 1.9rem;
  height: 1.9rem;
  border: 1px solid color-mix(in srgb, #fff 20%, var(--primary));
  border-radius: 50%;
  background: color-mix(in srgb, var(--primary) 78%, rgba(0, 0, 0, 0.2));
  color: var(--on-primary, #fff);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  line-height: 1;
  box-shadow: 0 2px 10px color-mix(in srgb, var(--primary) 35%, transparent);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  transition: transform 0.1s, opacity 0.12s, background 0.12s;
}
.gp-play-mini:hover {
  background: color-mix(in srgb, var(--primary) 90%, #000);
  transform: scale(1.05);
}
.gp-play-mini:active { transform: scale(0.96); }

.gp-hbtn {
  width: 1.65rem;
  height: 1.65rem;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, #fff 6%, var(--border));
  background: color-mix(in srgb, #fff 7%, transparent);
  color: var(--muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1.1rem;
  line-height: 1;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  transition: color 0.12s, background 0.12s, border-color 0.12s;
}
.gp-hbtn:hover {
  color: var(--text);
  background: color-mix(in srgb, #fff 12%, transparent);
  border-color: color-mix(in srgb, #fff 10%, var(--border));
}
.gp-hbtn.close:hover {
  color: var(--danger, #ff6b6b);
  background: color-mix(in srgb, var(--danger, #ff6b6b) 14%, transparent);
  border-color: color-mix(in srgb, var(--danger, #ff6b6b) 28%, var(--border));
}
.gp-chev {
  display: block;
  width: 0.4rem;
  height: 0.4rem;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(45deg);
  margin-top: -0.15rem;
  transition: transform 0.2s;
}
.gp-chev.up {
  transform: rotate(225deg);
  margin-top: 0.1rem;
}

/* ---- 展开区 ---- */
.gp-body {
  padding: 0.45rem 0.7rem 0.65rem;
  background: color-mix(in srgb, var(--bg) 12%, transparent);
}
.gp-caching {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.65rem;
  color: var(--muted);
  margin-bottom: 0.4rem;
  padding: 0.2rem 0;
}

.gp-progress {
  height: 22px;
  display: flex;
  align-items: center;
  cursor: pointer;
  position: relative;
  touch-action: none;
  user-select: none;
  margin: 0 -0.15rem;
}
.gp-track {
  width: 100%;
  height: 4px;
  background: color-mix(in srgb, var(--text) 9%, transparent);
  border-radius: 4px;
  position: relative;
  overflow: visible;
  pointer-events: none;
  transition: height 0.12s;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.12);
}
.gp-progress:hover .gp-track {
  height: 6px;
}
.gp-fill {
  height: 100%;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--primary) 90%, #fff),
    color-mix(in srgb, var(--primary) 50%, #fff)
  );
  border-radius: 4px;
  pointer-events: none;
  box-shadow: 0 0 9px color-mix(in srgb, var(--primary) 40%, transparent);
  opacity: 0.95;
}
.gp-thumb {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: color-mix(in srgb, #fff 92%, var(--primary));
  border: 2px solid var(--primary);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  transform: translate(-50%, -50%);
  pointer-events: none;
  transition: transform 0.12s;
}
.gp-thumb.active,
.gp-progress:hover .gp-thumb {
  transform: translate(-50%, -50%) scale(1.25);
}
.gp-time {
  display: flex;
  justify-content: space-between;
  font-size: 0.64rem;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  margin-top: 0.2rem;
  margin-bottom: 0.4rem;
}

/* 主控行：云音乐式中间播放钮偏大 */
.gp-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.gp-mode {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  padding: 0.22rem 0.4rem;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: color-mix(in srgb, #fff 6%, transparent);
  color: var(--muted);
  font-size: 0.6rem;
  font-weight: 600;
  cursor: pointer;
  max-width: 38%;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}
.gp-mode:hover {
  border-color: color-mix(in srgb, var(--primary) 40%, var(--border));
  color: var(--text);
  background: color-mix(in srgb, #fff 8%, transparent);
}
.gp-mode.on {
  border-color: color-mix(in srgb, var(--primary) 50%, var(--border));
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 12%, transparent);
}
.gp-mode-ico { flex-shrink: 0; }
.gp-mode-txt {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.gp-transport {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  flex: 1;
  min-width: 0;
}
.gp-tile {
  width: 1.9rem;
  height: 1.9rem;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: color-mix(in srgb, #fff 7%, transparent);
  color: var(--text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.78rem;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  transition: border-color 0.12s, background 0.12s, transform 0.1s, color 0.12s;
}
.gp-tile:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--primary) 40%, var(--border));
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 8%, transparent);
}
.gp-tile:disabled {
  opacity: 0.28;
  cursor: not-allowed;
}
.gp-tile--main {
  width: 2.45rem;
  height: 2.45rem;
  font-size: 0.9rem;
  background: color-mix(in srgb, var(--primary) 88%, rgba(0, 0, 0, 0.15));
  color: var(--on-primary, #fff);
  border: 1px solid color-mix(in srgb, #fff 22%, var(--primary));
  box-shadow:
    0 3px 14px color-mix(in srgb, var(--primary) 38%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.gp-tile--main:hover {
  color: var(--on-primary, #fff);
  background: color-mix(in srgb, var(--primary) 95%, #000);
  border-color: color-mix(in srgb, #fff 28%, var(--primary));
}
.gp-tile:active:not(:disabled) {
  transform: scale(0.95);
}
.gp-vol {
  display: flex;
  align-items: center;
  min-width: 3.2rem;
  max-width: 4.2rem;
  flex: 0 0 auto;
}
.gp-volume {
  width: 100%;
  height: 5px;
  -webkit-appearance: none;
  appearance: none;
  background: color-mix(in srgb, var(--text) 10%, transparent);
  border-radius: 3px;
  outline: none;
  cursor: pointer;
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.08);
}
.gp-volume::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: color-mix(in srgb, #fff 95%, var(--primary));
  border: 2px solid var(--primary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  cursor: pointer;
  margin-top: -3.5px;
}
.gp-volume::-moz-range-track {
  height: 5px;
  background: color-mix(in srgb, var(--text) 10%, transparent);
  border-radius: 3px;
}
.gp-volume::-moz-range-thumb {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: color-mix(in srgb, #fff 95%, var(--primary));
  border: 2px solid var(--primary);
  cursor: pointer;
}

/* ---- Spinner ---- */
.spinner {
  display: inline-block;
  width: 0.85em;
  height: 0.85em;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: gp-spin 0.6s linear infinite;
}
@keyframes gp-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 600px) {
  .gp {
    width: calc(100vw - 16px);
    max-width: none;
  }
  .gp-mode {
    max-width: none;
    width: 100%;
    justify-content: center;
  }
  .gp-transport {
    order: 1;
    width: 100%;
  }
  .gp-vol {
    order: 2;
    max-width: none;
    width: 100%;
  }
}
</style>
