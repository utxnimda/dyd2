<script setup lang="ts">
import { ref, onMounted, computed, watch } from "vue";
import {
  playTrack,
  currentTrack,
  setPlaylist,
  type PlayableTrack,
} from "./audioPlayerStore";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface SongItem {
  file: string;
  label: string;
  start: number;
  end: number;
  duration: number;
  index: number;
  page: number;
  originalName: string;
  renamedAt: string | null;
}

interface VideoEntry {
  bvid: string;
  page: number;
  url: string;
  extractedAt: string | null;
  songs: SongItem[];
}

/** Flattened song — one per row, carries its parent video info */
interface FlatSong {
  bvid: string;
  page: number;
  url: string;
  extractedAt: string | null;
  song: SongItem;
}

/* ------------------------------------------------------------------ */
/*  State                                                             */
/* ------------------------------------------------------------------ */

const loading = ref(false);
const error = ref("");
const videos = ref<VideoEntry[]>([]);

// Search / filter
const searchQuery = ref("");
const isSearching = computed(() => searchQuery.value.trim().length > 0);

/** 无搜索时的手风琴：同一时间只展开一个 BV；null = 全部收起 */
const expandedBvid = ref<string | null>(null);

/** 有搜索时：默认全部展开；仅记录「被用户收起」的分组（true = 收起） */
const bvFoldWhileSearch = ref<Record<string, boolean>>({});

function isBvCollapsed(bvid: string): boolean {
  if (isSearching.value) return !!bvFoldWhileSearch.value[bvid];
  return expandedBvid.value !== bvid;
}

function toggleBvFold(bvid: string) {
  if (isSearching.value) {
    bvFoldWhileSearch.value = {
      ...bvFoldWhileSearch.value,
      [bvid]: !isBvCollapsed(bvid),
    };
    return;
  }
  expandedBvid.value = expandedBvid.value === bvid ? null : bvid;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const API_BASE = "/__fmz_audio";

/** 「忽闻宝声」列表依赖本机 audio-extractor（Vite 反代 → 8789）；未启动时会出现连接失败 */
const AUDIO_SERVICE_HINT =
  "请先在本机启动音频后端：在项目根目录另开终端执行 npm run audio-server（需与 npm run dev 同时运行）；或直接执行 npm run dev:all 一次启动前端与后端。";

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function songDownloadUrl(fs: FlatSong): string {
  const pageDir = fs.page > 1 ? `p${fs.page}/` : "";
  return `${API_BASE}/download/${fs.bvid}/${pageDir}music/${encodeURIComponent(fs.song.file)}`;
}

/** Total song count */
const totalSongs = computed(() => videos.value.reduce((n, v) => n + v.songs.length, 0));

/** Flatten all videos into a single song list */
const flatSongs = computed<FlatSong[]>(() => {
  const list: FlatSong[] = [];
  for (const v of videos.value) {
    for (const song of v.songs) {
      list.push({ bvid: v.bvid, page: v.page, url: v.url, extractedAt: v.extractedAt, song });
    }
  }
  return list;
});

/** Filtered flat songs based on search query */
const filteredSongs = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return flatSongs.value;
  return flatSongs.value.filter((fs) =>
    fs.bvid.toLowerCase().includes(q) ||
    fs.song.label.toLowerCase().includes(q) ||
    fs.song.file.toLowerCase().includes(q),
  );
});

/** 按 BV 号分组展示；组内 P 升序、分轨 index 升序 */
const songsGroupedByBvid = computed(() => {
  const map = new Map<string, FlatSong[]>();
  for (const fs of filteredSongs.value) {
    if (!map.has(fs.bvid)) map.set(fs.bvid, []);
    map.get(fs.bvid)!.push(fs);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bvid, items]) => ({
      bvid,
      count: items.length,
      items: items.sort((a, b) => {
        if (a.page !== b.page) return a.page - b.page;
        return (a.song.index || 0) - (b.song.index || 0);
      }),
    }));
});

watch(songsGroupedByBvid, (groups) => {
  const cur = expandedBvid.value;
  if (cur != null && !groups.some((g) => g.bvid === cur)) {
    expandedBvid.value = null;
  }
  const ids = new Set(groups.map((g) => g.bvid));
  const fold = bvFoldWhileSearch.value;
  if (Object.keys(fold).length === 0) return;
  const next = { ...fold };
  let changed = false;
  for (const k of Object.keys(next)) {
    if (!ids.has(k)) {
      delete next[k];
      changed = true;
    }
  }
  if (changed) bvFoldWhileSearch.value = next;
});

watch(
  () => searchQuery.value.trim(),
  (q, prev) => {
    const prevQ = prev ?? "";
    if (q.length > 0 && prevQ.length === 0) {
      bvFoldWhileSearch.value = {};
    }
    if (q.length === 0 && prevQ.length > 0) {
      bvFoldWhileSearch.value = {};
      expandedBvid.value = null;
    }
  },
);

/* ------------------------------------------------------------------ */
/*  API                                                               */
/* ------------------------------------------------------------------ */

async function loadLibrary() {
  loading.value = true;
  error.value = "";
  try {
    const resp = await fetch(`${API_BASE}/library`);
    if (!resp.ok) {
      throw new ConnectError(resp.status);
    }
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "曲库读取失败");
    videos.value = data.videos || [];
  } catch (e: unknown) {
    if (e instanceof ConnectError) {
      error.value =
        `无法加载曲库（HTTP ${e.httpStatus ?? "?"}）。${AUDIO_SERVICE_HINT}`;
    } else if (looksLikeOfflineError(e)) {
      error.value = `无法连接到本地音频服务。${AUDIO_SERVICE_HINT}`;
    } else {
      error.value = e instanceof Error ? e.message : "加载失败";
    }
  } finally {
    loading.value = false;
  }
}

class ConnectError extends Error {
  readonly httpStatus: number;
  constructor(httpStatus: number) {
    super("HTTP error");
    this.name = "ConnectError";
    this.httpStatus = httpStatus;
  }
}

function looksLikeOfflineError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  if (!(e instanceof Error)) return false;
  const m = e.message.toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("networkerror") ||
    m.includes("load failed") ||
    m.includes("network request failed")
  );
}

/* ------------------------------------------------------------------ */
/*  Playback                                                          */
/* ------------------------------------------------------------------ */

function playSong(fs: FlatSong) {
  /** 仅在点歌时同步整库顺序到播放列表，避免每次加载/刷新列表就重刷队列 */
  syncPlaylist();
  const url = songDownloadUrl(fs);
  const track: PlayableTrack = {
    url,
    label: `${fs.song.label} (P${fs.page})`,
    bvid: fs.bvid,
    page: fs.page,
    duration: fs.song.duration,
  };
  playTrack(track);
}

function downloadSong(fs: FlatSong) {
  const url = songDownloadUrl(fs);
  const a = document.createElement("a");
  a.href = url;
  a.download = fs.song.file;
  a.click();
}

function isSongPlaying(fs: FlatSong): boolean {
  return currentTrack.value?.url === songDownloadUrl(fs);
}

/** 行尾时长 mm:ss，与云音乐列表一致 */
function formatRowDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—:—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Sync the global playlist：按 BV → 分P → 分轨 index，与展示分组一致，顺序播放即按 BV 聚合 */
function syncPlaylist() {
  const sorted = [...flatSongs.value].sort((a, b) => {
    if (a.bvid !== b.bvid) return a.bvid.localeCompare(b.bvid);
    if (a.page !== b.page) return a.page - b.page;
    return (a.song.index || 0) - (b.song.index || 0);
  });
  const tracks: PlayableTrack[] = sorted.map((fs) => ({
    url: songDownloadUrl(fs),
    label: `${fs.song.label} (P${fs.page})`,
    bvid: fs.bvid,
    page: fs.page,
    duration: fs.song.duration,
  }));
  setPlaylist(tracks);
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                         */
/* ------------------------------------------------------------------ */

onMounted(() => {
  loadLibrary();
});

defineExpose({ reload: loadLibrary });
</script>

<template>
  <section class="sl">
    <!-- Header -->
    <div class="sl-header">
      <p v-if="!loading && totalSongs > 0" class="sl-subtitle">忽闻宝声 · 共 {{ totalSongs }} 首</p>
      <p v-else-if="!loading" class="sl-subtitle">本地提取的音频与分轨</p>
      <div class="sl-toolbar">
        <div class="sl-search-wrap">
          <button
            class="sl-refresh"
            type="button"
            aria-label="刷新列表"
            @click="loadLibrary"
            :disabled="loading"
            title="刷新列表"
          >
            <span v-if="loading" class="spinner"></span>
            <span v-else aria-hidden="true">↻</span>
          </button>
          <input
            v-model="searchQuery"
            type="search"
            class="sl-search"
            placeholder="搜索 BV、歌名、文件名"
            enterkeyhint="search"
          />
          <span class="sl-search-ico" aria-hidden="true">🔍</span>
        </div>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading && videos.length === 0" class="sl-msg loading">
      <span class="spinner"></span> 加载中…
    </div>

    <!-- Error -->
    <div v-if="error" class="sl-msg error">⚠️ {{ error }}</div>

    <!-- Empty -->
    <div v-if="!loading && !error && videos.length === 0" class="sl-msg empty">
      还没有提取过歌曲，去「拾观宝片」或「遥忆宝章」点击 🎵 提取吧！
    </div>

    <!-- 按 BV 分组 -->
    <!-- 单列纵向列表：未搜索时为手风琴；有搜索关键字时默认全部展开，可多组同时开着 -->
    <div
      v-if="songsGroupedByBvid.length > 0"
      class="sl-list"
    >
      <div
        v-for="group in songsGroupedByBvid"
        :key="group.bvid"
        class="sl-bv-group"
        :class="{ 'sl-bv-group--open': !isBvCollapsed(group.bvid) }"
      >
        <div
          class="sl-bv-head"
          role="button"
          tabindex="0"
          :aria-expanded="!isBvCollapsed(group.bvid)"
          :title="
            isSearching
              ? isBvCollapsed(group.bvid)
                ? '展开'
                : '收起'
              : isBvCollapsed(group.bvid)
                ? '展开此 BV（将收起其他分组）'
                : '收起'
          "
          @click="toggleBvFold(group.bvid)"
          @keydown.enter.prevent="toggleBvFold(group.bvid)"
          @keydown.space.prevent="toggleBvFold(group.bvid)"
        >
          <span
            class="sl-bv-chevron"
            :class="{ 'is-folded': isBvCollapsed(group.bvid) }"
            aria-hidden="true"
          />
          <a class="sl-bv-title" :href="group.items[0]?.url" target="_blank" rel="noopener" @click.stop>{{
            group.bvid
          }}</a>
          <span class="sl-bv-badge">{{ group.count }} 首</span>
        </div>
        <div v-show="!isBvCollapsed(group.bvid)" class="sl-bv-body">
        <div
        v-for="fs in group.items"
        :key="fs.bvid + '-' + fs.page + '-' + fs.song.file"
        class="sl-row"
        :class="{ playing: isSongPlaying(fs) }"
      >
        <div class="sl-body">
          <div class="sl-title-row">
            <span class="sl-name" :title="fs.song.label">{{ fs.song.label }}</span>
            <span class="sl-row-dur">{{ formatRowDuration(fs.song.duration) }}</span>
          </div>
          <div class="sl-meta">
            <span class="sl-page">P{{ fs.page }}</span>
            <span v-if="fs.song.index > 0" class="sl-index">#{{ fs.song.index }}</span>
            <template v-if="fs.song.start !== 0 || fs.song.end !== 0">
              <span class="sl-sep">·</span>
              <span class="sl-time">{{ formatTime(fs.song.start) }} — {{ formatTime(fs.song.end) }}</span>
            </template>
          </div>
        </div>
        <div class="sl-actions">
          <button
            class="sl-btn sl-btn--play"
            :class="{ on: isSongPlaying(fs) }"
            :title="isSongPlaying(fs) ? '停止' : '播放'"
            @click="playSong(fs)"
          >
            {{ isSongPlaying(fs) ? "⏹" : "▶" }}
          </button>
          <button class="sl-btn sl-btn--icon" title="下载到本地" @click="downloadSong(fs)">⬇</button>
        </div>
      </div>
        </div>
      </div>
    </div>

    <!-- No results for search -->
    <div v-if="!loading && searchQuery && songsGroupedByBvid.length === 0 && videos.length > 0" class="sl-msg empty">
      未找到匹配「{{ searchQuery }}」的歌曲
    </div>


  </section>
</template>

<style scoped>
.sl {
  padding: 1rem 1.25rem 1.25rem;
  max-width: min(680px, 100%);
  margin: 0 auto;
}

/* ---- 顶区：类网易云「歌单」头图 + 标题 ---- */
.sl-header {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 1.15rem;
}
.sl-subtitle {
  margin: 0;
  font-size: 0.78rem;
  color: var(--muted);
  font-weight: 500;
}
.sl-toolbar {
  display: flex;
  align-items: center;
  width: 100%;
  box-sizing: border-box;
  /* 与 .sl-list 左右内边距一致，外框与下方卡片列表对齐 */
  padding: 0 0.15rem;
}
.sl-search-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: stretch;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: color-mix(in srgb, var(--surface) 45%, transparent);
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.05);
  overflow: hidden;
  min-height: 2.5rem;
  transition: border-color 0.18s, box-shadow 0.18s, background 0.18s;
}
.sl-search-wrap:focus-within {
  background: color-mix(in srgb, var(--surface) 55%, transparent);
  border-color: color-mix(in srgb, var(--primary) 50%, var(--border));
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--primary) 20%, transparent),
    inset 0 1px 1px rgba(0, 0, 0, 0.04);
}
.sl-search-ico {
  position: absolute;
  right: 0.85rem;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.75rem;
  opacity: 0.45;
  pointer-events: none;
}
.sl-search {
  flex: 1;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem 2.35rem 0.5rem 0.65rem;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--text);
  font-size: 0.84rem;
  outline: none;
  appearance: none;
  -webkit-appearance: none;
}
.sl-search::-webkit-search-decoration,
.sl-search::-webkit-search-cancel-button {
  appearance: none;
  -webkit-appearance: none;
}
.sl-search:focus {
  box-shadow: none;
}
.sl-search::placeholder { color: var(--muted); }
.sl-refresh {
  flex-shrink: 0;
  width: 2.65rem;
  min-height: 100%;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 0;
  border-right: 1px solid color-mix(in srgb, var(--text) 8%, transparent);
  background: transparent;
  color: var(--text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1.05rem;
  line-height: 1;
  transition: border-color 0.15s, background 0.15s, color 0.12s;
}
.sl-refresh:hover:not(:disabled) {
  background: color-mix(in srgb, var(--primary) 12%, transparent);
  color: var(--primary);
}
.sl-refresh:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--primary) 55%, transparent);
  outline-offset: -2px;
}
.sl-refresh:active:not(:disabled) { transform: scale(0.94); }
.sl-refresh:disabled { opacity: 0.45; cursor: not-allowed; }

/* ---- Messages ---- */
.sl-msg {
  padding: 1.75rem 1.25rem;
  text-align: center;
  font-size: 0.88rem;
  color: var(--muted);
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, #fff 6%, var(--border));
  background: color-mix(in srgb, var(--surface) 52%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.sl-msg.loading { display: flex; align-items: center; justify-content: center; gap: 0.5rem; }
.sl-msg.error {
  background: color-mix(in srgb, var(--danger, #ff6b6b) 10%, var(--surface));
  color: var(--danger, #ff6b6b);
  border-color: color-mix(in srgb, var(--danger, #ff6b6b) 28%, var(--border));
}

/* 单列纵向：与手风琴逻辑一致（一次只开一个 BV），手机端也少挤占横向 */
.sl-list {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  width: 100%;
  box-sizing: border-box;
  padding: 0.2rem 0.15rem 0.5rem;
}

.sl-bv-group {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  overflow-y: visible;
  padding: 0.5rem 0.55rem 0.6rem;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, #fff 10%, var(--border));
  background: linear-gradient(
    195deg,
    color-mix(in srgb, var(--primary) 12%, transparent) 0%,
    color-mix(in srgb, var(--bg) 32%, transparent) 55%,
    color-mix(in srgb, var(--surface) 40%, transparent) 100%
  );
  box-shadow:
    0 6px 28px rgba(0, 0, 0, 0.12),
    inset 0 1px 0 rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(20px) saturate(1.25);
  -webkit-backdrop-filter: blur(20px) saturate(1.25);
  /* Firefox 竖向 */
  scrollbar-color: color-mix(in srgb, var(--primary) 38%, var(--border))
    color-mix(in srgb, var(--text) 5%, transparent);
}
.sl-bv-group.sl-bv-group--open {
  max-height: 72vh;
  overflow-y: auto;
}
.sl-bv-group::-webkit-scrollbar {
  width: 8px;
}
.sl-bv-group::-webkit-scrollbar-track {
  margin: 8px 0;
  background: color-mix(in srgb, var(--text) 5%, transparent);
  border-radius: 100px;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #fff 4%, var(--border));
}
.sl-bv-group::-webkit-scrollbar-thumb {
  border-radius: 100px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--primary) 48%, var(--surface)),
    color-mix(in srgb, var(--primary) 32%, var(--muted))
  );
  box-shadow: 0 0 0 1px color-mix(in srgb, #fff 10%, var(--primary));
}
.sl-bv-group::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--primary) 65%, var(--surface)),
    color-mix(in srgb, var(--primary) 48%, var(--muted))
  );
}
.sl-bv-group::-webkit-scrollbar-thumb:active {
  background: color-mix(in srgb, var(--primary) 70%, var(--text));
}
.sl-bv-group::-webkit-scrollbar-corner {
  background: transparent;
}
.sl-bv-head {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.2rem 0.15rem 0.4rem 0.1rem;
  margin-bottom: 0.1rem;
  border-bottom: 1px solid color-mix(in srgb, #fff 6%, var(--border));
  flex-shrink: 0;
  cursor: pointer;
  user-select: none;
  border-radius: 8px;
  margin-left: -0.2rem;
  margin-right: -0.2rem;
  padding-left: 0.25rem;
  padding-right: 0.25rem;
  transition: background 0.15s;
}
.sl-bv-head:hover {
  background: color-mix(in srgb, #fff 5%, transparent);
}
.sl-bv-head:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.sl-bv-chevron {
  width: 1.1rem;
  height: 1.1rem;
  border-radius: 50%;
  background: color-mix(in srgb, #fff 6%, transparent);
  border: 1px solid color-mix(in srgb, #fff 5%, var(--border));
  flex-shrink: 0;
  position: relative;
}
.sl-bv-chevron::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0.3rem;
  height: 0.3rem;
  border-right: 1.5px solid var(--muted);
  border-bottom: 1.5px solid var(--muted);
  transform: translate(-50%, -55%) rotate(45deg);
  transition: transform 0.2s;
}
.sl-bv-chevron.is-folded::after {
  transform: translate(-50%, -40%) rotate(-45deg);
}
.sl-bv-body {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.sl-bv-title {
  font-family: ui-monospace, monospace;
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--text);
  text-decoration: none;
  letter-spacing: 0.02em;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sl-bv-title:hover { color: var(--primary); }
.sl-bv-badge {
  font-size: 0.65rem;
  font-weight: 600;
  color: var(--muted);
  background: color-mix(in srgb, #fff 5%, transparent);
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, #fff 6%, var(--border));
  flex-shrink: 0;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

/* ---- 行：标题行 + 操作 ---- */
.sl-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.42rem 0.4rem 0.42rem 0.35rem;
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 40%, transparent);
  border: 1px solid color-mix(in srgb, #fff 4%, transparent);
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
  position: relative;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.sl-row::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 0;
  border-radius: 0 3px 3px 0;
  background: var(--primary);
  transition: height 0.2s;
}
.sl-row:hover {
  background: color-mix(in srgb, var(--primary) 6%, var(--surface) 50%);
  border-color: color-mix(in srgb, var(--primary) 22%, var(--border));
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.08);
}
.sl-row.playing {
  background: color-mix(in srgb, var(--primary) 16%, transparent);
  border-color: color-mix(in srgb, var(--primary) 38%, var(--border));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary) 18%, transparent);
}
.sl-row.playing::before { height: 60%; }

.sl-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.12rem;
}
.sl-title-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  min-width: 0;
}
.sl-name {
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  letter-spacing: 0.01em;
}
.sl-row-dur {
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.sl-meta {
  display: flex;
  align-items: center;
  gap: 0.28rem;
  font-size: 0.66rem;
  color: var(--muted);
  flex-wrap: wrap;
  line-height: 1.35;
}
.sl-page {
  font-size: 0.58rem;
  font-weight: 700;
  color: var(--on-primary);
  background: var(--primary);
  padding: 0.06rem 0.3rem;
  border-radius: 3px;
  flex-shrink: 0;
}
.sl-index {
  font-size: 0.58rem;
  font-weight: 600;
  color: var(--muted);
  background: color-mix(in srgb, var(--bg) 80%, var(--text) 2%);
  padding: 0.05rem 0.25rem;
  border-radius: 3px;
  border: 1px solid var(--border);
}
.sl-sep { opacity: 0.35; }
.sl-time { font-variant-numeric: tabular-nums; }

.sl-actions {
  display: flex;
  gap: 0.2rem;
  flex-shrink: 0;
  align-items: center;
}
.sl-btn {
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: color-mix(in srgb, #fff 6%, transparent);
  color: var(--text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.72rem;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  transition: border-color 0.12s, background 0.12s, transform 0.1s, color 0.12s;
}
.sl-btn:hover {
  border-color: color-mix(in srgb, var(--primary) 40%, var(--border));
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 8%, transparent);
}
.sl-btn--play {
  width: 2.15rem;
  height: 2.15rem;
  font-size: 0.78rem;
  border: 1px solid color-mix(in srgb, var(--primary) 20%, var(--border));
  background: color-mix(in srgb, var(--primary) 12%, transparent);
  color: var(--primary);
}
.sl-btn--play.on {
  background: color-mix(in srgb, var(--primary) 90%, rgba(0, 0, 0, 0.1));
  color: var(--on-primary, #fff);
  border-color: color-mix(in srgb, #fff 20%, var(--primary));
  box-shadow:
    0 2px 10px color-mix(in srgb, var(--primary) 35%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
}
.sl-btn--play:hover {
  color: var(--on-primary, #fff);
  background: color-mix(in srgb, var(--primary) 88%, #000);
  border-color: color-mix(in srgb, #fff 24%, var(--primary));
}
.sl-btn--play.on:hover { opacity: 0.92; }
.sl-btn--icon { font-size: 0.7rem; }
.sl-btn:active { transform: scale(0.95); }

/* ---- Spinner ---- */
.spinner {
  display: inline-block;
  width: 1em;
  height: 1em;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 600px) {
  .sl { padding: 0.75rem 0.75rem 4rem; }
  .sl-bv-group.sl-bv-group--open {
    max-height: min(70vh, 85dvh);
  }
}
</style>
