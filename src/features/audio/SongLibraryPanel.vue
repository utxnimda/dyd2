<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
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

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const API_BASE = "/__fmz_audio";

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
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

/* ------------------------------------------------------------------ */
/*  API                                                               */
/* ------------------------------------------------------------------ */

async function loadLibrary() {
  loading.value = true;
  error.value = "";
  try {
    const resp = await fetch(`${API_BASE}/library`);
    if (!resp.ok) throw new Error("Failed to load library");
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "Failed");
    videos.value = data.videos || [];
    // Sync the global playlist with the full library
    syncPlaylist();
  } catch (e: any) {
    error.value = e.message || "加载失败";
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Playback                                                          */
/* ------------------------------------------------------------------ */

function playSong(fs: FlatSong) {
  const url = songDownloadUrl(fs);
  const track: PlayableTrack = {
    url,
    label: `${fs.song.label} (${fs.bvid}${fs.page > 1 ? " P" + fs.page : ""})`,
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

/** Sync the global playlist with the full library */
function syncPlaylist() {
  const tracks: PlayableTrack[] = flatSongs.value.map((fs) => ({
    url: songDownloadUrl(fs),
    label: `${fs.song.label} (${fs.bvid}${fs.page > 1 ? " P" + fs.page : ""})`,
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
      <div class="sl-title">
        <span class="sl-icon">🎶</span>
        <span>歌曲库</span>
        <span v-if="!loading && totalSongs > 0" class="sl-count">{{ totalSongs }} 首</span>
      </div>
      <div class="sl-toolbar">
        <input
          v-model="searchQuery"
          type="text"
          class="sl-search"
          placeholder="搜索 BV号 / 歌曲名..."
        />
        <button class="sl-refresh" @click="loadLibrary" :disabled="loading" title="刷新">
          <span v-if="loading" class="spinner"></span>
          <span v-else>🔄</span>
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading && videos.length === 0" class="sl-msg loading">
      <span class="spinner"></span> 加载歌曲库...
    </div>

    <!-- Error -->
    <div v-if="error" class="sl-msg error">⚠️ {{ error }}</div>

    <!-- Empty -->
    <div v-if="!loading && !error && videos.length === 0" class="sl-msg empty">
      还没有提取过歌曲，去「宝宝魅力时刻」点击 🎵 提取吧！
    </div>

    <!-- Flat song list -->
    <div v-if="filteredSongs.length > 0" class="sl-list">
      <div
        v-for="(fs, i) in filteredSongs"
        :key="fs.bvid + '-' + fs.page + '-' + fs.song.file"
        class="sl-row"
        :class="{ playing: isSongPlaying(fs) }"
      >
        <!-- Index -->
        <div class="sl-idx">{{ i + 1 }}</div>

        <!-- Main content -->
        <div class="sl-body">
          <!-- Song name -->
          <div class="sl-name">{{ fs.song.label }}</div>
          <!-- Meta line: BV + page + time range + index -->
          <div class="sl-meta">
            <a class="sl-bvid" :href="fs.url" target="_blank" rel="noopener">{{ fs.bvid }}</a>
            <span v-if="fs.page > 1" class="sl-page">P{{ fs.page }}</span>
            <span v-if="fs.song.index > 0" class="sl-index">#{{ fs.song.index }}</span>
            <template v-if="fs.song.start !== 0 || fs.song.end !== 0">
              <span class="sl-sep">·</span>
              <span class="sl-time">{{ formatTime(fs.song.start) }} — {{ formatTime(fs.song.end) }}</span>
              <span class="sl-dur">{{ formatDuration(fs.song.duration) }}</span>
            </template>
            <template v-else-if="fs.song.duration > 0">
              <span class="sl-sep">·</span>
              <span class="sl-dur">{{ formatDuration(fs.song.duration) }}</span>
            </template>
          </div>
        </div>

        <!-- Actions -->
        <div class="sl-actions">
          <button
            class="sl-btn"
            :title="isSongPlaying(fs) ? '停止' : '播放'"
            @click="playSong(fs)"
          >
            {{ isSongPlaying(fs) ? '⏹' : '▶' }}
          </button>
          <button class="sl-btn" title="下载" @click="downloadSong(fs)">💾</button>
        </div>
      </div>
    </div>

    <!-- No results for search -->
    <div v-if="!loading && searchQuery && filteredSongs.length === 0 && videos.length > 0" class="sl-msg empty">
      未找到匹配「{{ searchQuery }}」的歌曲
    </div>


  </section>
</template>

<style scoped>
.sl {
  padding: 1rem 1.25rem 1rem;
}

/* ---- Header ---- */
.sl-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.sl-title {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text);
}
.sl-icon { font-size: 1.3rem; }
.sl-count {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--muted);
  background: var(--surface);
  padding: 0.15rem 0.5rem;
  border-radius: 10px;
}
.sl-toolbar {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.sl-search {
  padding: 0.4rem 0.7rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 0.82rem;
  outline: none;
  width: 200px;
  transition: border-color 0.15s;
}
.sl-search:focus { border-color: var(--primary); }
.sl-search::placeholder { color: var(--muted); }
.sl-refresh {
  width: 32px; height: 32px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
}
.sl-refresh:hover { border-color: var(--primary); }
.sl-refresh:disabled { opacity: 0.5; cursor: not-allowed; }

/* ---- Messages ---- */
.sl-msg {
  padding: 1.5rem;
  text-align: center;
  font-size: 0.88rem;
  color: var(--muted);
  border-radius: 10px;
}
.sl-msg.loading { display: flex; align-items: center; justify-content: center; gap: 0.5rem; }
.sl-msg.error { background: rgba(255,107,107,0.1); color: #ff6b6b; }
.sl-msg.empty { background: var(--surface); }

/* ---- Flat song list ---- */
.sl-list {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.sl-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.65rem;
  border-radius: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  transition: border-color 0.12s, background 0.12s;
}
.sl-row:hover { border-color: var(--primary); background: var(--bg); }
.sl-row.playing { background: rgba(var(--primary-rgb, 100, 108, 255), 0.08); border-color: var(--primary); }

.sl-idx {
  width: 24px;
  text-align: center;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--muted);
  flex-shrink: 0;
}

.sl-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.sl-name {
  font-size: 0.84rem;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sl-meta {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.7rem;
  color: var(--muted);
  flex-wrap: wrap;
}
.sl-bvid {
  font-family: monospace;
  font-weight: 600;
  color: var(--primary);
  text-decoration: none;
  font-size: 0.7rem;
}
.sl-bvid:hover { text-decoration: underline; }
.sl-page {
  font-size: 0.62rem;
  font-weight: 600;
  color: var(--on-primary);
  background: var(--primary);
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
}
.sl-index {
  font-size: 0.62rem;
  font-weight: 600;
  color: var(--muted);
  background: var(--bg);
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  border: 1px solid var(--border);
}
.sl-sep { opacity: 0.4; }
.sl-time {
  font-variant-numeric: tabular-nums;
}
.sl-dur {
  opacity: 0.6;
}

.sl-actions {
  display: flex;
  gap: 0.2rem;
  flex-shrink: 0;
}
.sl-btn {
  width: 28px; height: 28px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.78rem;
  transition: border-color 0.12s;
}
.sl-btn:hover { border-color: var(--primary); }

/* ---- Spinner ---- */
.spinner {
  display: inline-block;
  width: 1em; height: 1em;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ---- Mobile ---- */
@media (max-width: 600px) {
  .sl { padding: 0.75rem 0.75rem 4rem; }
  .sl-header { flex-direction: column; align-items: stretch; }
  .sl-search { width: 100%; }
}
</style>
