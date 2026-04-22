<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { pluginPayloads, pluginPayloadVersion } from "../../shared/plugins";
import {
  playTrack,
  currentTrack,
  stopPlayback,
  appendToPlaylist,
  type PlayableTrack,
} from "./audioPlayerStore";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface Song {
  start: number;
  end: number;
  duration: number;
  label: string;
  file?: string;
}

interface DepsStatus {
  ok: boolean;
  ytdlp: boolean;
  ffmpeg: boolean;
  message: string;
}

/* ------------------------------------------------------------------ */
/*  State                                                             */
/* ------------------------------------------------------------------ */

const depsStatus = ref<DepsStatus | null>(null);
const depsLoading = ref(false);

// Input
const videoUrl = ref("");
const videoId = ref("");
const videoPage = ref(1);

// Extract
const extracting = ref(false);
const extractDone = ref(false);
const extractError = ref("");
const audioDuration = ref(0);
const audioFile = ref("");

// Smart extract (one-click: extract + detect + split)
const smartExtracting = ref(false);
const smartDone = ref(false);
const smartError = ref("");
const songs = ref<Song[]>([]);
const mergeBusy = ref(false);
const mergeError = ref("");
/** 要合并的连续分轨，存 music/xx.mp3，合并成功后清空 */
const selectedMergeFiles = ref<string[]>([]);

// Playback (now uses global store)

// Inline editing
const editingIndex = ref<number | null>(null);
const editingName = ref("");
const renaming = ref(false);
const deleting = ref<number | null>(null);

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

function formatDurationLong(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

function parseBvid(url: string): string | null {
  const m = url.match(/BV[\w]+/i);
  return m ? m[0] : null;
}

function parsePageFromUrl(url: string): number {
  const m = url.match(/[?&]p=(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

const canExtract = computed(() => {
  const url = videoUrl.value.trim();
  return url.length > 0 && (url.includes("bilibili.com") || url.includes("b23.tv") || url.startsWith("BV"));
});

const mergeSelectCount = computed(() => selectedMergeFiles.value.length);

function isMergeOutputFile(f: string | undefined): boolean {
  if (!f) return true;
  const b = f.replace(/^music\//, "");
  return b === "merged_full_span.mp3" || b === "merged_selection.mp3";
}

function mergeFileChecked(f: string | undefined): boolean {
  return !!(f && !isMergeOutputFile(f) && selectedMergeFiles.value.includes(f));
}

function toggleMergeFile(f: string | undefined) {
  if (!f || isMergeOutputFile(f)) return;
  const i = selectedMergeFiles.value.indexOf(f);
  if (i >= 0) {
    selectedMergeFiles.value = selectedMergeFiles.value.filter((x) => x !== f);
  } else {
    selectedMergeFiles.value = [...selectedMergeFiles.value, f];
  }
}

const isReady = computed(() => depsStatus.value?.ok === true);

/* ------------------------------------------------------------------ */
/*  API calls                                                         */
/* ------------------------------------------------------------------ */

async function checkDeps() {
  depsLoading.value = true;
  try {
    const resp = await fetch(`${API_BASE}/check`);
    depsStatus.value = await resp.json();
  } catch {
    depsStatus.value = {
      ok: false, ytdlp: false, ffmpeg: false,
      message: "无法连接到音频提取服务",
    };
  } finally {
    depsLoading.value = false;
  }
}

async function doExtract() {
  let url = videoUrl.value.trim();
  if (!url) return;
  if (url.startsWith("BV") && !url.includes("http")) {
    url = `https://www.bilibili.com/video/${url}`;
  }
  const bvid = parseBvid(url);
  const vid = bvid || Date.now().toString(36);
  const page = parsePageFromUrl(url);

  extracting.value = true;
  extractError.value = "";
  extractDone.value = false;
  smartDone.value = false;
  songs.value = [];

  try {
    const resp = await fetch(`${API_BASE}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, videoId: vid, page }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "提取失败");
    videoId.value = data.videoId;
    videoPage.value = data.page || page;
    audioFile.value = data.audioFile;
    audioDuration.value = data.duration || 0;
    extractDone.value = true;
  } catch (e: any) {
    extractError.value = e.message || "提取失败";
  } finally {
    extracting.value = false;
  }
}

async function doSmartExtract() {
  let url = videoUrl.value.trim();
  if (!url) return;
  if (url.startsWith("BV") && !url.includes("http")) {
    url = `https://www.bilibili.com/video/${url}`;
  }
  const bvid = parseBvid(url);
  const vid = bvid || videoId.value || Date.now().toString(36);
  const page = videoPage.value || parsePageFromUrl(url);

  smartExtracting.value = true;
  smartError.value = "";
  smartDone.value = false;

  try {
    const resp = await fetch(`${API_BASE}/smart-extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, videoId: vid, page }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "提取失败");

    videoId.value = data.videoId;
    videoPage.value = data.page || page;
    audioFile.value = data.audioFile || "";
    audioDuration.value = data.duration || 0;
    extractDone.value = true;

    if (data.segments?.length > 0) {
      songs.value = data.segments.map((s: any, i: number) => ({
        start: s.start, end: s.end, duration: s.duration,
        label: s.label || `[${formatTime(s.start)}-${formatTime(s.end)}] ${String(i + 1).padStart(2, '0')}`, file: s.file,
      }));
      smartDone.value = true;
    } else {
      smartError.value = "未检测到歌曲片段";
    }
  } catch (e: any) {
    smartError.value = e.message || "提取失败";
  } finally {
    smartExtracting.value = false;
  }
}

function buildSongUrl(song: Song): string {
  const pageDir = videoPage.value > 1 ? `p${videoPage.value}/` : "";
  return `${API_BASE}/download/${videoId.value}/${pageDir}${encodeURIComponent(song.file!)}`;
}

function playSong(song: Song) {
  if (!song.file) return;
  const url = buildSongUrl(song);
  const track: PlayableTrack = {
    url,
    label: song.label,
    bvid: videoId.value,
    page: videoPage.value,
    duration: song.duration,
  };
  // Also register all songs from this BV into the global playlist
  registerSongsToPlaylist();
  playTrack(track);
}

function playSource() {
  if (!videoId.value || !audioFile.value) return;
  const pageDir = videoPage.value > 1 ? `p${videoPage.value}/` : "";
  const url = `${API_BASE}/download/${videoId.value}/${pageDir}${encodeURIComponent(audioFile.value)}`;
  const track: PlayableTrack = {
    url,
    label: "完整音频",
    bvid: videoId.value,
    page: videoPage.value,
    duration: audioDuration.value,
  };
  playTrack(track);
}

/** Register all extracted songs into the global playlist for shuffle/next */
function registerSongsToPlaylist() {
  const tracks: PlayableTrack[] = songs.value
    .filter((s) => s.file)
    .map((s) => ({
      url: buildSongUrl(s),
      label: s.label,
      bvid: videoId.value,
      page: videoPage.value,
      duration: s.duration,
    }));
  if (tracks.length > 0) appendToPlaylist(tracks);
}

function downloadSong(song: Song) {
  if (!song.file) return;
  const url = buildSongUrl(song);
  const a = document.createElement("a");
  a.href = url;
  a.download = song.file;
  a.click();
}

/* ---- Rename song (label only, file stays unchanged) ---- */
function startRename(index: number) {
  const song = songs.value[index];
  if (!song) return;
  editingIndex.value = index;
  editingName.value = song.label;
}

function cancelRename() {
  editingIndex.value = null;
  editingName.value = "";
}

async function confirmRename(index: number) {
  const song = songs.value[index];
  if (!song?.file || !editingName.value.trim()) {
    cancelRename();
    return;
  }

  const newLabel = editingName.value.trim();
  // If label didn't change, just cancel
  if (newLabel === song.label) {
    cancelRename();
    return;
  }

  renaming.value = true;
  try {
    const resp = await fetch(`${API_BASE}/rename-song`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: videoId.value,
        fileName: song.file,
        newLabel,
        page: videoPage.value,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "重命名失败");

    // Update local state — file stays the same, only label changes
    song.label = data.label;
  } catch (e: any) {
    alert(`重命名失败: ${e.message}`);
  } finally {
    renaming.value = false;
    cancelRename();
  }
}

/* ---- Delete song ---- */
async function deleteSong(index: number) {
  const song = songs.value[index];
  if (!song?.file) return;

  deleting.value = index;
  try {
    const resp = await fetch(`${API_BASE}/delete-song`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
      videoId: videoId.value,
        fileName: song.file,
        page: videoPage.value,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "删除失败");

    // If currently playing this song, stop
    if (currentTrack.value?.url?.includes(encodeURIComponent(song.file))) {
      stopPlayback();
    }
    // Remove from list
    songs.value.splice(index, 1);
  } catch (e: any) {
    alert(`删除失败: ${e.message}`);
  } finally {
    deleting.value = null;
  }
}

function resetAll() {
  videoUrl.value = "";
  videoId.value = "";
  videoPage.value = 1;
  extractDone.value = false;
  extractError.value = "";
  smartDone.value = false;
  smartError.value = "";
  smartExtracting.value = false;
  songs.value = [];
  audioDuration.value = 0;
  audioFile.value = "";
  mergeBusy.value = false;
  mergeError.value = "";
  selectedMergeFiles.value = [];
  loadingLocal.value = false;
}

/** 与 loadExistingData 中相同的列表结构，供合并等操作后同步服务端 */
async function refreshSongsFromStatus() {
  if (!videoId.value) return;
  mergeError.value = "";
  try {
    const resp = await fetch(`${API_BASE}/status/${encodeURIComponent(videoId.value)}?p=${videoPage.value}`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data.ok || !data.hasMusic || !data.musicFiles?.length) return;
    const rows = data.musicFiles.slice();
    const isMerged = (n: string) => n === "merged_full_span.mp3" || n === "merged_selection.mp3";
    rows.sort((a: { name: string }, b: { name: string }) => (isMerged(a.name) ? 1 : 0) - (isMerged(b.name) ? 1 : 0));
    songs.value = rows.map((mf: any, i: number) => ({
      start: mf.start ?? 0,
      end: mf.end ?? 0,
      duration: mf.duration ?? 0,
      label: mf.label || `[${formatTime(mf.start ?? 0)}-${formatTime(mf.end ?? 0)}] ${String(i + 1).padStart(2, "0")}`,
      file: `music/${mf.name}`,
    }));
    smartDone.value = true;
  } catch {
    /* ignore */
  }
  selectedMergeFiles.value = [];
}

async function doMergeSelected() {
  if (!videoId.value) return;
  if (selectedMergeFiles.value.length < 2) {
    mergeError.value = "请至少勾选 2 个分轨，且这些分轨在时间上须连续（如 01、02、03）";
    return;
  }
  for (const f of selectedMergeFiles.value) {
    const u = currentTrack.value?.url;
    if (u && (u.includes(f) || u.includes(encodeURIComponent(f)))) {
      stopPlayback();
      break;
    }
  }
  mergeError.value = "";
  mergeBusy.value = true;
  try {
    const resp = await fetch(`${API_BASE}/merge-selected`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: videoId.value,
        page: videoPage.value,
        fileNames: selectedMergeFiles.value,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      throw new Error((data as { error?: string }).error || "合并失败");
    }
    selectedMergeFiles.value = [];
    await refreshSongsFromStatus();
  } catch (e: unknown) {
    mergeError.value = e instanceof Error ? e.message : "合并失败";
  } finally {
    mergeBusy.value = false;
  }
}

async function doMergeFullSpan() {
  if (!videoId.value) return;
  mergeError.value = "";
  mergeBusy.value = true;
  try {
    const resp = await fetch(`${API_BASE}/merge-full-span`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId: videoId.value, page: videoPage.value }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      throw new Error((data as { error?: string }).error || "合并失败");
    }
    await refreshSongsFromStatus();
  } catch (e: unknown) {
    mergeError.value = e instanceof Error ? e.message : "合并失败";
  } finally {
    mergeBusy.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Auto-load existing extraction data when URL is set                 */
/* ------------------------------------------------------------------ */

const loadingLocal = ref(false);

/** 仅手动：按当前链接向服务端查询是否已有本机提取（不会发起下载/重新提取） */
async function loadExistingData() {
  let url = videoUrl.value.trim();
  if (!url) return;
  if (url.startsWith("BV") && !url.includes("http")) {
    url = `https://www.bilibili.com/video/${url}`;
  }
  const bvid = parseBvid(url);
  if (!bvid) return;
  const page = parsePageFromUrl(url);

  loadingLocal.value = true;
  try {
    const resp = await fetch(`${API_BASE}/status/${bvid}?p=${page}`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data.ok || !data.extracted) return;

    videoId.value = bvid;
    videoPage.value = page;
    audioFile.value = data.sourceFile || "";
    audioDuration.value = data.duration || 0;
    extractDone.value = true;

    if (data.hasMusic && data.musicFiles?.length > 0) {
      songs.value = data.musicFiles.map((mf: any, i: number) => ({
        start: mf.start ?? 0,
        end: mf.end ?? 0,
        duration: mf.duration ?? 0,
        label: mf.label || `[${formatTime(mf.start ?? 0)}-${formatTime(mf.end ?? 0)}] ${String(i + 1).padStart(2, '0')}`,
        file: `music/${mf.name}`,
      }));
      smartDone.value = true;
    }
  } catch { /* ignore */ } finally {
    loadingLocal.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                         */
/* ------------------------------------------------------------------ */

/** Process incoming payload (from BilibiliSearchPanel's 🎵 button) */
function handlePayload() {
  const payload = pluginPayloads.value["audio"];
  if (!payload?.url) return;
  const url = String(payload.url);
  // Clear the payload so it doesn't re-trigger
  pluginPayloads.value = { ...pluginPayloads.value, audio: undefined };
  // Reset state and fill in the URL
  resetAll();
  videoUrl.value = url;
  videoPage.value = parsePageFromUrl(url);
  // 不自动按 BV 拉取本机已提取；请点「读取本机已提取」
}

onMounted(() => {
  checkDeps();
  // Check if there's already a pending payload (async component loaded after payload was set)
  handlePayload();
  // Also retry after a tick in case the payload arrives slightly later
  setTimeout(handlePayload, 50);
});

// Watch the payload version counter — a simple number that increments
// every time PluginHost writes a new payload. This is far more reliable
// than watching the payload object itself (avoids Vue reactivity edge-cases).
watch(pluginPayloadVersion, () => handlePayload());
</script>

<template>
  <section class="ap">
    <!-- Deps status (compact) -->
    <div v-if="depsLoading" class="ap-status loading">
      <span class="spinner"></span> 检查依赖...
    </div>
    <div v-else-if="depsStatus && !depsStatus.ok" class="ap-status error">
      <span>⚠️ {{ depsStatus.message }}</span>
      <div class="ap-deps">
        <span :class="depsStatus.ytdlp ? 'ok' : 'miss'">{{ depsStatus.ytdlp ? '✅' : '❌' }} yt-dlp</span>
        <span :class="depsStatus.ffmpeg ? 'ok' : 'miss'">{{ depsStatus.ffmpeg ? '✅' : '❌' }} ffmpeg</span>
      </div>
      <button class="ap-retry" @click="checkDeps">🔄 重新检查</button>
    </div>
    <div v-else-if="depsStatus?.ok" class="ap-status ok">✅ 就绪</div>

    <!-- URL Input + Actions -->
    <div class="ap-input-card">
      <input
        v-model="videoUrl"
        type="text"
        class="ap-url"
        placeholder="粘贴B站视频链接或BV号..."
        :disabled="extracting || smartExtracting"
        @keydown.enter="doExtract"
      />
      <div class="ap-actions">
        <button
          class="ap-btn secondary"
          :disabled="!canExtract || !isReady || extracting || smartExtracting"
          @click="doExtract"
        >
          <span v-if="extracting" class="spinner"></span>
          <span v-else>🎧 仅提取音频</span>
        </button>
        <button
          class="ap-btn primary"
          :disabled="!canExtract || !isReady || extracting || smartExtracting"
          @click="doSmartExtract"
        >
          <span v-if="smartExtracting" class="spinner"></span>
          <span v-else>🎶 提取并分割歌曲</span>
        </button>
        <button
          type="button"
          class="ap-btn secondary"
          :disabled="!canExtract || !isReady || loadingLocal || extracting || smartExtracting"
          title="仅查询本机 data，不下载、不自动提取"
          @click="loadExistingData"
        >
          <span v-if="loadingLocal" class="spinner"></span>
          <span v-else>📂 读取本机已提取</span>
        </button>
      </div>
    </div>

    <!-- Errors -->
    <div v-if="extractError" class="ap-msg error">⚠️ {{ extractError }}</div>
    <div v-if="smartError" class="ap-msg error">⚠️ {{ smartError }}</div>

    <!-- Progress hint -->
    <div v-if="smartExtracting" class="ap-msg hint">
      ⏳ 正在提取音频并分析歌曲片段，请稍候...
    </div>

    <!-- Results -->
    <div v-if="extractDone" class="ap-results">
      <div class="ap-results-header">
        <div class="ap-results-info">
          <span class="ap-vid">{{ videoId }}</span>
          <span v-if="videoPage > 1" class="ap-page">P{{ videoPage }}</span>
          <span v-if="audioDuration > 0" class="ap-dur">{{ formatDurationLong(audioDuration) }}</span>
        </div>
        <div class="ap-results-actions">
          <button class="ap-small-btn" @click="playSource">
            ▶ 完整音频
          </button>
          <button v-if="extractDone && !smartDone" class="ap-small-btn primary" :disabled="smartExtracting" @click="doSmartExtract">
            <span v-if="smartExtracting" class="spinner"></span>
            <span v-else>🎶 分割歌曲</span>
          </button>
          <button class="ap-small-btn muted" @click="resetAll">🔄</button>
        </div>
      </div>

      <div v-if="mergeError" class="ap-msg error" style="margin: 0.5rem 0.75rem 0;">⚠️ {{ mergeError }}</div>

      <!-- Song list -->
      <div v-if="smartDone && songs.length > 0" class="ap-songs">
        <div class="ap-songs-title-row">
          <span class="ap-songs-title">🎶 提取到 {{ songs.length }} 首</span>
          <div class="ap-songs-title-actions">
            <button
              v-if="videoId"
              type="button"
              class="ap-small-btn primary"
              :disabled="mergeBusy || mergeSelectCount < 2"
              title="合并勾选且时间上相邻的分轨，生成 merged_selection.mp3，原分轨会删除"
              @click="doMergeSelected"
            >
              <span v-if="mergeBusy" class="spinner"></span>
              <span v-else>✂️ 合并已选 ({{ mergeSelectCount }}) 并删原轨</span>
            </button>
            <button
              v-if="videoId"
              type="button"
              class="ap-small-btn"
              :disabled="mergeBusy"
              title="全部普通分轨：最早起点—最晚终点一条；不删分轨，生成 merged_full_span.mp3"
              @click="doMergeFullSpan"
            >
              <span v-if="mergeBusy" class="spinner"></span>
              <span v-else>🔗 全轨合并</span>
            </button>
          </div>
        </div>
        <div class="ap-merge-hint">合并已选：请勾选时间上连续的片段（如第 1、2、3 行），不能跳行。</div>
        <div
          v-for="(song, i) in songs"
          :key="song.file || i"
          class="ap-song"
        >
          <label v-if="song.file && !isMergeOutputFile(song.file)" class="ap-merge-cb-wrap" @click.stop>
            <input
              type="checkbox"
              class="ap-merge-cb"
              :checked="mergeFileChecked(song.file)"
              @change="() => toggleMergeFile(song.file)"
            />
          </label>
          <span v-else class="ap-merge-cb-spacer" aria-hidden="true"></span>
          <div class="ap-song-color" :style="{ background: `hsl(${(i * 60 + 200) % 360}, 60%, 55%)` }"></div>
          <div class="ap-song-info">
            <!-- Inline rename mode -->
            <template v-if="editingIndex === i">
              <div class="ap-rename-row">
                <input
                  v-model="editingName"
                  class="ap-rename-input"
                  :disabled="renaming"
                  @keydown.enter="confirmRename(i)"
                  @keydown.escape="cancelRename"
                  ref="renameInput"
                />
                <button class="ap-icon-btn confirm" title="确认" :disabled="renaming" @click="confirmRename(i)">✓</button>
                <button class="ap-icon-btn cancel" title="取消" :disabled="renaming" @click="cancelRename">✕</button>
              </div>
            </template>
            <template v-else>
              <span class="ap-song-label">{{ song.label }}</span>
            </template>
            <span class="ap-song-time">{{ formatTime(song.start) }} — {{ formatTime(song.end) }} · {{ formatDurationLong(song.duration) }}</span>
          </div>
          <div class="ap-song-btns">
            <button
              v-if="song.file"
              class="ap-icon-btn"
          :title="currentTrack?.url?.includes(song.file!) ? '停止' : '播放'"
              @click="playSong(song)"
            >
              {{ currentTrack?.url?.includes(song.file!) ? '⏹' : '▶' }}
            </button>
            <button v-if="song.file" class="ap-icon-btn" title="下载" @click="downloadSong(song)">💾</button>
            <button
              v-if="song.file && editingIndex !== i"
              class="ap-icon-btn rename"
              title="重命名"
              @click="startRename(i)"
            >✏️</button>
            <button
              v-if="song.file"
              class="ap-icon-btn delete"
              :title="deleting === i ? '删除中...' : '删除'"
              :disabled="deleting === i"
              @click="deleteSong(i)"
            >
              <span v-if="deleting === i" class="spinner"></span>
              <span v-else>🗑️</span>
            </button>
          </div>
        </div>
      </div>
    </div>


  </section>
</template>

<style scoped>
.ap {
  padding: 0.75rem 0.85rem 1rem;
}

/* ---- Status ---- */
.ap-status {
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  margin-bottom: 0.75rem;
  font-size: 0.82rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.ap-status.loading { background: var(--surface); color: var(--muted); }
.ap-status.error { background: rgba(255,107,107,0.1); border: 1px solid rgba(255,107,107,0.3); color: var(--text); }
.ap-status.ok { background: rgba(76,175,80,0.1); border: 1px solid rgba(76,175,80,0.3); color: #4caf50; }
.ap-deps { display: flex; gap: 0.75rem; font-size: 0.8rem; }
.ap-deps .ok { color: #4caf50; }
.ap-deps .miss { color: #ff6b6b; }
.ap-retry {
  padding: 0.25rem 0.6rem; border-radius: 5px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text); font-size: 0.78rem; cursor: pointer;
}
.ap-retry:hover { border-color: var(--primary); }

/* ---- Input card ---- */
.ap-input-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.75rem;
  margin-bottom: 0.75rem;
}
.ap-url {
  width: 100%;
  padding: 0.55rem 0.75rem;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 0.88rem;
  outline: none;
  transition: border-color 0.2s;
  margin-bottom: 0.5rem;
  box-sizing: border-box;
}
.ap-url:focus { border-color: var(--primary); }
.ap-url::placeholder { color: var(--muted); font-size: 0.82rem; }
.ap-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.ap-btn {
  flex: 1;
  padding: 0.5rem 0.75rem;
  border-radius: 7px;
  border: none;
  font-weight: 600;
  font-size: 0.82rem;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.1s;
  white-space: nowrap;
}
.ap-btn.primary { background: var(--primary); color: var(--on-primary); }
.ap-btn.secondary { background: var(--bg); color: var(--text); border: 1px solid var(--border); }
.ap-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.ap-btn:hover:not(:disabled) { opacity: 0.85; }
.ap-btn:active:not(:disabled) { transform: scale(0.97); }

/* ---- Messages ---- */
.ap-msg {
  padding: 0.45rem 0.7rem;
  border-radius: 7px;
  font-size: 0.82rem;
  margin-bottom: 0.6rem;
}
.ap-msg.error { background: rgba(255,107,107,0.1); border: 1px solid rgba(255,107,107,0.25); color: #ff6b6b; }
.ap-msg.hint { background: var(--surface); color: var(--muted); font-style: italic; animation: pulse-text 1.5s ease-in-out infinite; }
@keyframes pulse-text { 0%,100% { opacity: 0.6; } 50% { opacity: 1; } }

/* ---- Results ---- */
.ap-results {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.ap-results-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.55rem 0.75rem;
  border-bottom: 1px solid var(--border);
  gap: 0.5rem;
  flex-wrap: wrap;
}
.ap-results-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}
.ap-vid {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text);
  font-family: monospace;
}
.ap-page {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--on-primary);
  background: var(--primary);
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
}
.ap-dur {
  font-size: 0.72rem;
  color: var(--muted);
  background: var(--bg);
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
}
.ap-results-actions {
  display: flex;
  gap: 0.3rem;
  flex-shrink: 0;
}
.ap-small-btn {
  padding: 0.3rem 0.6rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 0.75rem;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.12s;
}
.ap-small-btn:hover { border-color: var(--primary); }
.ap-small-btn.primary { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
.ap-small-btn.primary:hover { opacity: 0.85; }
.ap-small-btn.muted { color: var(--muted); }

/* ---- Song list ---- */
.ap-songs {
  padding: 0.5rem 0.75rem 0.6rem;
}
.ap-songs-title {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 0.4rem;
}
.ap-songs-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.4rem;
}
.ap-songs-title-row > .ap-songs-title {
  margin-bottom: 0;
}
.ap-songs-title-actions {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
  align-items: center;
}
.ap-merge-hint {
  font-size: 0.7rem;
  color: var(--muted);
  margin: -0.15rem 0 0.45rem 0.1rem;
  line-height: 1.3;
}
.ap-merge-cb-wrap {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  cursor: pointer;
  margin: 0 0.1rem 0 0;
}
.ap-merge-cb {
  width: 0.95rem;
  height: 0.95rem;
  accent-color: var(--primary);
  cursor: pointer;
}
.ap-merge-cb-spacer {
  display: inline-block;
  width: 1.15rem;
  flex-shrink: 0;
  margin-right: 0.1rem;
}
.ap-song {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.5rem;
  border-radius: 7px;
  background: var(--bg);
  margin-bottom: 0.3rem;
  transition: border-color 0.12s;
  border: 1px solid transparent;
}
.ap-song:hover { border-color: var(--border); }
.ap-song-color {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}
.ap-song-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.ap-song-label {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ap-song-time {
  font-size: 0.7rem;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.ap-song-btns {
  display: flex;
  gap: 0.25rem;
  flex-shrink: 0;
}
.ap-icon-btn {
  width: 28px;
  height: 28px;
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
.ap-icon-btn:hover { border-color: var(--primary); }
.ap-icon-btn.rename:hover { border-color: #ffa726; color: #ffa726; }
.ap-icon-btn.delete:hover { border-color: #ff6b6b; color: #ff6b6b; }
.ap-icon-btn.confirm {
  border-color: #4caf50; color: #4caf50; font-weight: 700;
}
.ap-icon-btn.confirm:hover { background: rgba(76,175,80,0.1); }
.ap-icon-btn.cancel {
  border-color: #ff6b6b; color: #ff6b6b; font-weight: 700;
}
.ap-icon-btn.cancel:hover { background: rgba(255,107,107,0.1); }

/* ---- Inline rename ---- */
.ap-rename-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  width: 100%;
}
.ap-rename-input {
  flex: 1;
  min-width: 0;
  padding: 0.2rem 0.45rem;
  border-radius: 5px;
  border: 1px solid var(--primary);
  background: var(--bg);
  color: var(--text);
  font-size: 0.8rem;
  outline: none;
  font-family: inherit;
}
.ap-rename-input:focus {
  box-shadow: 0 0 0 2px rgba(var(--primary-rgb, 100, 108, 255), 0.2);
}

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
  .ap { padding: 0.5rem 0.5rem 3.5rem; }
  .ap-actions { flex-direction: column; }
}
</style>
