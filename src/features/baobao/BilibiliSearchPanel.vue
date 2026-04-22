
<script setup lang="ts">
import { ref, computed, onMounted, reactive } from "vue";
import { requestPluginOpen } from "../../shared/plugins";

const F_AUDIO = __FEATURE_AUDIO__;
const F_AUDIO_PLUGIN = __FEATURE_AUDIO_PLUGIN__;

interface BiliVideo {
  aid: number;
  bvid: string;
  title: string;
  description: string;
  pic: string;
  author: string;
  mid: number;
  play: number;
  danmaku: number;
  duration: string;
  pubdate: number;
  tag: string;
}

const DEFAULT_KEYWORD = "电饭宝";
const keyword = ref(DEFAULT_KEYWORD);
const useCustom = ref(false);

/** Sub-tab: "all" shows everything, "replay" auto-filters replay/录播 videos */
type SubTab = "all" | "replay";
const subTab = ref<SubTab>("all");
const SUB_TAB_OPTIONS: { value: SubTab; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "replay", label: "录播" },
];

/** Sort order for bilibili search: totalrank=综合, pubdate=最新, click=播放量 */
type SortOrder = "totalrank" | "pubdate" | "click";
const sortOrder = ref<SortOrder>("totalrank");
const SORT_OPTIONS: { value: SortOrder; label: string }[] = [
  { value: "totalrank", label: "综合" },
  { value: "pubdate", label: "最新" },
  { value: "click", label: "播放量" },
];
const videos = ref<BiliVideo[]>([]);
const loading = ref(false);
const searched = ref(false);
const errorMsg = ref("");
const page = ref(1);
const totalPages = ref(0);
const pageSize = 20;

/** Currently playing video bvid (inline player) */
const playingBvid = ref<string | null>(null);
/** Currently selected page index (1-based) for multi-part videos */
const playingPage = ref(1);

/* ------------------------------------------------------------------ */
/*  Multi-part (分P) video support                                     */
/* ------------------------------------------------------------------ */

interface BiliPage {
  page: number;   // 1-based page index
  part: string;   // page title
  duration: number; // seconds
  firstFrame?: string; // first frame thumbnail URL for this page
}

/** Cached pages per bvid */
const videoPages = reactive<Record<string, BiliPage[]>>({});
/** Loading state for fetching pages */
const loadingPages = ref<string | null>(null);

/** Format seconds to MM:SS */
function formatSeconds(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Fetch video pages info from bilibili API */
async function fetchVideoPages(bvid: string): Promise<BiliPage[]> {
  if (videoPages[bvid]) return videoPages[bvid];
  try {
    loadingPages.value = bvid;
    const buvid3 = await ensureBuvid3();
    const headers: Record<string, string> = {};
    if (buvid3) headers["x-bili-buvid3"] = buvid3;
    const resp = await fetch(`/__bili_api/x/web-interface/view?bvid=${bvid}`, { headers });
    if (!resp.ok) return [];
    const json = await resp.json();
    if (json.code !== 0) return [];
    const pages: BiliPage[] = (json.data?.pages || []).map((p: any) => ({
      page: p.page,
      part: p.part || `P${p.page}`,
      duration: p.duration || 0,
      firstFrame: p.first_frame || "",
    }));
    videoPages[bvid] = pages;
    return pages;
  } catch {
    return [];
  } finally {
    loadingPages.value = null;
  }
}

/** Cached buvid3 fingerprint token required by bilibili API to avoid 412 */
let cachedBuvid3 = "";
async function ensureBuvid3(): Promise<string> {
  if (cachedBuvid3) return cachedBuvid3;
  try {
    const resp = await fetch("/__bili_api/x/frontend/finger/spi");
    if (resp.ok) {
      const json = await resp.json();
      cachedBuvid3 = json?.data?.b_3 || "";
    }
  } catch { /* ignore */ }
  return cachedBuvid3;
}

/** Auto-search on mount with default keyword */
onMounted(() => {
  search(1);
});

/** Fetch pages for all videos in current list */
async function fetchAllVideoPages() {
  const promises = videos.value.map((v) => fetchVideoPages(v.bvid));
  await Promise.allSettled(promises);
}

/** Strip HTML highlight tags from bilibili search results */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/** Format play count */
function formatCount(n: number): string {
  if (n >= 10000) return (n / 10000).toFixed(1) + "万";
  return String(n);
}

/** Format duration "MM:SS" from total seconds string like "12:34" or seconds number */
function formatDuration(dur: string): string {
  return dur;
}

/** Format publish date */
function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Build the actual search keyword based on sub-tab */
function buildSearchKeyword(): string {
  const base = keyword.value.trim();
  if (!base) return "";
  if (subTab.value === "replay") {
    // Append "录播" if not already present
    return base.includes("录播") ? base : `${base} 录播`;
  }
  return base;
}

async function search(p = 1) {
  const kw = buildSearchKeyword();
  if (!kw) return;
  loading.value = true;
  errorMsg.value = "";
  searched.value = true;
  playingBvid.value = null;
  try {
    // Ensure buvid3 fingerprint is available (required to avoid 412)
    const buvid3 = await ensureBuvid3();
    const params = new URLSearchParams({
      search_type: "video",
      keyword: kw,
      page: String(p),
      page_size: String(pageSize),
      order: sortOrder.value,
    });
    const headers: Record<string, string> = {};
    if (buvid3) headers["x-bili-buvid3"] = buvid3;
    const resp = await fetch(`/__bili_api/x/web-interface/search/type?${params}`, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (json.code !== 0) {
      throw new Error(json.message || `API error code ${json.code}`);
    }
    const data = json.data;
    const list: BiliVideo[] = (data.result || []).map((item: any) => ({
      aid: item.aid,
      bvid: item.bvid,
      title: stripHtml(item.title || ""),
      description: item.description || "",
      pic: item.pic?.startsWith("//") ? "https:" + item.pic : item.pic,
      author: item.author || "",
      mid: item.mid,
      play: item.play ?? 0,
      danmaku: item.danmaku ?? 0,
      duration: item.duration || "",
      pubdate: item.pubdate ?? 0,
      tag: item.tag || "",
    }));
    videos.value = list;
    page.value = p;
    totalPages.value = Math.ceil((data.numResults || data.numPages * pageSize || 0) / pageSize);
    // Pre-fetch pages info for all videos
    fetchAllVideoPages();
  } catch (e: any) {
    errorMsg.value = e.message || "搜索失败";
    videos.value = [];
  } finally {
    loading.value = false;
  }
}

function onSearch() {
  search(1);
}

function toggleCustom() {
  useCustom.value = !useCustom.value;
  if (!useCustom.value) {
    // Switch back to default keyword and re-search
    keyword.value = DEFAULT_KEYWORD;
    search(1);
  }
}

function changeSort(order: SortOrder) {
  if (sortOrder.value === order) return;
  sortOrder.value = order;
  // Re-search from page 1 with new sort order
  if (searched.value) search(1);
}

function changeSubTab(tab: SubTab) {
  if (subTab.value === tab) return;
  subTab.value = tab;
  // Re-search from page 1 with new filter
  search(1);
}

function prevPage() {
  if (page.value > 1) search(page.value - 1);
}

function nextPage() {
  if (page.value < totalPages.value) search(page.value + 1);
}

function openVideo(bvid: string) {
  window.open(`https://www.bilibili.com/video/${bvid}`, "_blank");
}

/** Track selected page per video (so each card remembers its selection) */
const selectedPages = reactive<Record<string, number>>({});

async function togglePlay(bvid: string) {
  if (playingBvid.value === bvid) {
    // Stop playing
    playingBvid.value = null;
    playingPage.value = 1;
    return;
  }
  // Fetch pages info if not already cached
  await fetchVideoPages(bvid);
  playingBvid.value = bvid;
  playingPage.value = selectedPages[bvid] || 1;
}

/** Switch to a specific page of a video */
function selectPage(bvid: string, p: number) {
  selectedPages[bvid] = p;
  // If this video is currently playing, also update the player
  if (playingBvid.value === bvid) {
    playingPage.value = p;
  }
}

/** Get the thumbnail for a video, considering selected page */
function getThumb(v: BiliVideo): string {
  const pages = videoPages[v.bvid];
  const selPage = selectedPages[v.bvid] || 1;
  if (pages && pages.length > 1 && selPage > 1) {
    const pg = pages.find((p) => p.page === selPage);
    if (pg?.firstFrame) return pg.firstFrame;
  }
  return v.pic;
}

/** Open the audio extractor plugin with this video's URL pre-filled (including page) */
function extractAudio(bvid: string) {
  if (!F_AUDIO_PLUGIN) return;
  const selPage = selectedPages[bvid] || 1;
  let url = `https://www.bilibili.com/video/${bvid}`;
  if (selPage > 1) url += `?p=${selPage}`;
  requestPluginOpen("audio", { url });
}

const hasResults = computed(() => videos.value.length > 0);

/* ------------------------------------------------------------------ */
/*  Audio extraction status per video                                  */
/* ------------------------------------------------------------------ */

interface AudioStatus {
  extracted: boolean;
  hasMusic: boolean;
  sourceFile: string | null;
  musicFiles: { name: string; size: number }[];
}

const audioStatuses = reactive<Record<string, AudioStatus>>({});
const expandedAudio = ref<string | null>(null);
/** 用户点开「音频」下拉时才会按 BV 查询，不再对整页自动拉取 */
const audioStatusLoading = reactive<Record<string, boolean>>({});

const AUDIO_API = "/__fmz_audio";

async function fetchAudioStatus(bvid: string) {
  try {
    const resp = await fetch(`${AUDIO_API}/status/${bvid}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.ok) {
        audioStatuses[bvid] = {
          extracted: data.extracted,
          hasMusic: data.hasMusic,
          sourceFile: data.sourceFile || null,
          musicFiles: data.musicFiles || [],
        };
        return;
      }
    }
    audioStatuses[bvid] = {
      extracted: false,
      hasMusic: false,
      sourceFile: null,
      musicFiles: [],
    };
  } catch {
    audioStatuses[bvid] = {
      extracted: false,
      hasMusic: false,
      sourceFile: null,
      musicFiles: [],
    };
  }
}

async function toggleAudioDropdown(bvid: string) {
  if (expandedAudio.value === bvid) {
    expandedAudio.value = null;
    return;
  }
  expandedAudio.value = bvid;
  audioStatusLoading[bvid] = true;
  try {
    await fetchAudioStatus(bvid);
  } finally {
    audioStatusLoading[bvid] = false;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

function playAudioFile(bvid: string, filename: string) {
  const url = `${AUDIO_API}/download/${bvid}/${encodeURIComponent(filename)}`;
  window.open(url, "_blank");
}

</script>

<template>
  <section class="bili-panel">
    <!-- Search bar -->
    <div class="search-bar">
      <button
        type="button"
        class="toggle-btn"
        :class="{ active: useCustom }"
        title="切换自定义搜索"
        @click="toggleCustom"
      >
        {{ useCustom ? '🔙 默认' : '✏️ 自定义' }}
      </button>
      <input
        v-if="useCustom"
        v-model="keyword"
        type="text"
        class="search-input"
        placeholder="输入自定义关键字..."
        @keydown.enter="onSearch"
      />
      <span v-else class="keyword-display">🔍 {{ keyword }}</span>
      <button
        v-if="useCustom"
        class="search-btn"
        :disabled="loading || !keyword.trim()"
        @click="onSearch"
      >
        <span v-if="loading" class="spinner"></span>
        <span v-else>搜索</span>
      </button>
    </div>

    <!-- Sub-tabs & Sort bar -->
    <div v-if="searched" class="filter-row">
      <div class="sub-tabs">
        <button
          v-for="opt in SUB_TAB_OPTIONS"
          :key="opt.value"
          type="button"
          class="sub-tab-btn"
          :class="{ active: subTab === opt.value }"
          @click="changeSubTab(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
      <div class="sort-bar">
        <span class="sort-label">排序：</span>
        <button
          v-for="opt in SORT_OPTIONS"
          :key="opt.value"
          type="button"
          class="sort-btn"
          :class="{ active: sortOrder === opt.value }"
          @click="changeSort(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <!-- Error message -->
    <div v-if="errorMsg" class="error-msg">⚠️ {{ errorMsg }}</div>

    <!-- Empty state -->
    <div v-if="searched && !loading && !hasResults && !errorMsg" class="empty-state">
      没有找到相关视频，换个关键字试试吧 🎬
    </div>

    <!-- Video grid -->
    <div v-if="hasResults" class="video-grid">
      <div v-for="v in videos" :key="v.bvid" class="video-card">
        <!-- Thumbnail / Player -->
        <div class="thumb-wrap" @click="togglePlay(v.bvid)">
          <img
            v-if="playingBvid !== v.bvid"
            :src="getThumb(v)"
            :alt="v.title"
            class="thumb"
            loading="lazy"
            referrerpolicy="no-referrer"
          />
          <iframe
            v-else
            :src="`https://player.bilibili.com/player.html?bvid=${v.bvid}&p=${playingPage}&autoplay=1&high_quality=1`"
            class="player-iframe"
            allowfullscreen
            frameborder="0"
            scrolling="no"
          ></iframe>
          <!-- Loading indicator while fetching pages -->
          <span v-if="loadingPages === v.bvid" class="play-icon loading-pages">⏳</span>
          <span v-else-if="playingBvid !== v.bvid" class="play-icon">▶</span>
          <span v-if="playingBvid !== v.bvid" class="duration-badge">
            {{ formatDuration(v.duration) }}
            <span v-if="videoPages[v.bvid]?.length > 1" class="pages-hint">{{ videoPages[v.bvid].length }}P</span>
          </span>
          <!-- Audio extract button overlay — always visible on hover -->
          <button
            v-if="F_AUDIO && F_AUDIO_PLUGIN"
            type="button"
            class="extract-overlay-btn"
            :class="{ 'always-show': playingBvid === v.bvid }"
            title="提取音频"
            @click.stop="extractAudio(v.bvid)"
          >
            🎵
          </button>
        </div>
        <!-- Multi-part page dropdown (always visible if multi-page) -->
        <div v-if="videoPages[v.bvid]?.length > 1" class="page-dropdown-wrap">
          <select
            class="page-dropdown"
            :value="selectedPages[v.bvid] || 1"
            @change="selectPage(v.bvid, Number(($event.target as HTMLSelectElement).value))"
          >
            <option
              v-for="pg in videoPages[v.bvid]"
              :key="pg.page"
              :value="pg.page"
            >
              P{{ pg.page }} · {{ pg.part }} ({{ formatSeconds(pg.duration) }})
            </option>
          </select>
          <span class="page-dropdown-count">{{ videoPages[v.bvid].length }}P</span>
        </div>
        <!-- Info -->
        <div class="card-info">
          <h3 class="card-title" :title="v.title" @click="openVideo(v.bvid)">{{ v.title }}</h3>
          <!-- 音频：仅点击展开时按 BV 查询本机状态，不自动批量拉取 -->
          <div v-if="F_AUDIO" class="audio-status-row">
            <span v-if="audioStatuses[v.bvid]?.extracted" class="audio-badge extracted" title="已提取音频">🎵 已提取</span>
            <span v-if="audioStatuses[v.bvid]?.hasMusic" class="audio-badge music" title="已分割歌曲">
              🎶 {{ audioStatuses[v.bvid].musicFiles.length }} 首歌曲
            </span>
            <button
              type="button"
              class="audio-dropdown-btn"
              :class="{ open: expandedAudio === v.bvid }"
              title="查看本机是否已提取（点击后才会查询）"
              @click.stop="toggleAudioDropdown(v.bvid)"
            >
              {{ audioStatusLoading[v.bvid] ? "⏳" : "🎵" }} ▾
            </button>
          </div>
          <div v-if="F_AUDIO && expandedAudio === v.bvid" class="audio-dropdown">
            <div v-if="audioStatusLoading[v.bvid]" class="audio-file-empty">查询本机状态中…</div>
            <template v-else-if="!audioStatuses[v.bvid]?.extracted">
              <div class="audio-file-empty">本机尚未提取该视频音频</div>
            </template>
            <template v-else>
              <div v-if="audioStatuses[v.bvid]?.sourceFile" class="audio-file-item">
                <span class="audio-file-icon">📄</span>
                <span class="audio-file-name">{{ audioStatuses[v.bvid].sourceFile }}</span>
                <button class="audio-play-btn" title="播放" @click.stop="playAudioFile(v.bvid, audioStatuses[v.bvid].sourceFile!)">▶</button>
              </div>
              <template v-if="audioStatuses[v.bvid]?.musicFiles?.length">
                <div class="audio-file-divider">🎶 歌曲</div>
                <div v-for="mf in audioStatuses[v.bvid].musicFiles" :key="mf.name" class="audio-file-item">
                  <span class="audio-file-icon">🎵</span>
                  <span class="audio-file-name">{{ mf.name }}</span>
                  <span class="audio-file-size">{{ formatFileSize(mf.size) }}</span>
                  <button class="audio-play-btn" title="播放" @click.stop="playAudioFile(v.bvid, 'music/' + mf.name)">▶</button>
                </div>
              </template>
              <div v-else class="audio-file-empty">暂无分割歌曲</div>
            </template>
          </div>
          <div class="card-bottom">
            <div class="card-author">
              <span class="author-name">{{ v.author }}</span>
              <span class="card-date">{{ formatDate(v.pubdate) }}</span>
            </div>
            <div class="card-stats">
              <span class="stat"><svg class="stat-icon" viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" fill="currentColor"/></svg>{{ formatCount(v.play) }}</span>
              <span class="stat"><svg class="stat-icon" viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" fill="currentColor"/></svg>{{ formatCount(v.danmaku) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Pagination -->
    <div v-if="hasResults && totalPages > 1" class="pagination">
      <button :disabled="page <= 1" @click="prevPage">◀ 上一页</button>
      <span class="page-info">{{ page }} / {{ totalPages }}</span>
      <button :disabled="page >= totalPages" @click="nextPage">下一页 ▶</button>
    </div>
  </section>
</template>

<style scoped>
.bili-panel {
  padding: 1rem 1.25rem;
  max-width: 1200px;
  margin: 0 auto;
}

/* ---- Search bar ---- */
.search-bar {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1.25rem;
}
.toggle-btn {
  padding: 0.6rem 0.9rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
  font-size: 0.85rem;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.toggle-btn:hover {
  border-color: var(--primary);
  color: var(--text);
}
.toggle-btn.active {
  background: var(--primary);
  color: var(--on-primary);
  border-color: var(--primary);
}
.keyword-display {
  flex: 1;
  padding: 0.6rem 1rem;
  font-size: 1rem;
  color: var(--text);
  font-weight: 600;
}
.search-input {
  flex: 1;
  padding: 0.6rem 1rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 1rem;
  outline: none;
  transition: border-color 0.2s;
}
.search-input:focus {
  border-color: var(--primary);
}
.search-input::placeholder {
  color: var(--muted);
}
.search-btn {
  padding: 0.6rem 1.2rem;
  border-radius: 8px;
  border: none;
  background: var(--primary);
  color: var(--on-primary);
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity 0.2s;
}
.search-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.search-btn:hover:not(:disabled) {
  opacity: 0.85;
}

/* ---- Filter row (sub-tabs + sort) ---- */
.filter-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
  flex-wrap: wrap;
}
.sub-tabs {
  display: flex;
  gap: 0.35rem;
}
.sub-tab-btn {
  padding: 0.35rem 0.9rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.sub-tab-btn:hover {
  border-color: var(--primary);
  color: var(--text);
}
.sub-tab-btn.active {
  background: var(--primary);
  color: var(--on-primary);
  border-color: var(--primary);
}
.sort-bar {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.sort-label {
  font-size: 0.85rem;
  color: var(--muted);
  margin-right: 0.25rem;
}
.sort-btn {
  padding: 0.3rem 0.75rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
  font-size: 0.82rem;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.sort-btn:hover {
  border-color: var(--primary);
  color: var(--text);
}
.sort-btn.active {
  background: var(--primary);
  color: var(--on-primary);
  border-color: var(--primary);
}

/* ---- Spinner ---- */
.spinner {
  display: inline-block;
  width: 1em;
  height: 1em;
  border: 2px solid var(--on-primary);
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ---- Error / Empty ---- */
.error-msg {
  padding: 0.75rem 1rem;
  background: rgba(255, 107, 107, 0.15);
  border: 1px solid var(--danger);
  border-radius: 8px;
  color: var(--danger);
  margin-bottom: 1rem;
}
.empty-state {
  text-align: center;
  color: var(--muted);
  padding: 3rem 1rem;
  font-size: 1.1rem;
}

/* ---- Video grid (bilibili style) ---- */
.video-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 0.85rem 0.75rem;
}

.video-card {
  background: transparent;
  border: none;
  border-radius: 0;
  overflow: visible;
  transition: transform 0.2s ease;
}
.video-card:hover {
  transform: translateY(-2px);
}

/* ---- Thumbnail (bilibili style) ---- */
.thumb-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 10;
  background: #1a1a1a;
  cursor: pointer;
  overflow: hidden;
  border-radius: 8px;
}
.thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.3s ease;
}
.thumb-wrap:hover .thumb {
  transform: scale(1.06);
}
.player-iframe {
  width: 100%;
  height: 100%;
  border: none;
}
.play-icon {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 2.2rem;
  color: rgba(255, 255, 255, 0.9);
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.2s;
}
.thumb-wrap:hover .play-icon {
  opacity: 1;
}
.duration-badge {
  position: absolute;
  bottom: 6px;
  right: 6px;
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  font-size: 0.72rem;
  padding: 1px 5px;
  border-radius: 3px;
  pointer-events: none;
  font-variant-numeric: tabular-nums;
}
/* ---- Audio extract overlay button ---- */
.extract-overlay-btn {
  position: absolute;
  bottom: 6px;
  left: 6px;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: none;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 0.9rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.2s, background 0.15s, transform 0.15s;
  z-index: 2;
  backdrop-filter: blur(4px);
}
.thumb-wrap:hover .extract-overlay-btn,
.extract-overlay-btn.always-show {
  opacity: 1;
}
.extract-overlay-btn:hover {
  background: rgba(0, 161, 214, 0.85);
  transform: scale(1.1);
}

/* ---- Card info (bilibili style) ---- */
.card-info {
  padding: 0.5rem 0.15rem 0.25rem;
}
.card-title {
  margin: 0 0 0.3rem;
  font-size: 0.88rem;
  font-weight: 500;
  line-height: 1.4;
  color: var(--text);
  cursor: pointer;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  transition: color 0.15s;
}
.card-title:hover {
  color: var(--primary);
}
.card-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.15rem;
}
.card-author {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}
.author-name {
  font-size: 0.78rem;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100px;
}
.card-date {
  font-size: 0.72rem;
  color: var(--muted);
  opacity: 0.6;
  white-space: nowrap;
}
.card-stats {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}
.stat {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  font-size: 0.75rem;
  color: var(--muted);
}
.stat-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  opacity: 0.7;
}

/* ---- Pagination ---- */
.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 1rem;
  margin-top: 1.5rem;
  padding-bottom: 1rem;
}
.pagination button {
  padding: 0.45rem 1rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  font-weight: 500;
  transition: background 0.15s, border-color 0.15s;
}
.pagination button:hover:not(:disabled) {
  background: var(--primary);
  color: var(--on-primary);
  border-color: var(--primary);
}
.pagination button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.page-info {
  color: var(--muted);
  font-size: 0.9rem;
}

/* ---- Audio status indicators ---- */
.audio-status-row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.2rem;
  flex-wrap: wrap;
}
.audio-badge {
  font-size: 0.68rem;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  white-space: nowrap;
  font-weight: 500;
}
.audio-badge.extracted {
  background: rgba(76, 175, 80, 0.15);
  color: #4caf50;
  border: 1px solid rgba(76, 175, 80, 0.3);
}
.audio-badge.music {
  background: rgba(100, 181, 246, 0.15);
  color: #64b5f6;
  border: 1px solid rgba(100, 181, 246, 0.3);
}
.audio-dropdown-btn {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 0.7rem;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.15s, color 0.15s;
}
.audio-dropdown-btn.open {
  transform: rotate(180deg);
  color: var(--primary);
}
.audio-dropdown-btn:hover {
  color: var(--primary);
  border-color: var(--primary);
}
.audio-dropdown {
  margin-top: 0.3rem;
  padding: 0.35rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  max-height: 160px;
  overflow-y: auto;
}
.audio-file-item {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.3rem;
  border-radius: 4px;
  font-size: 0.72rem;
  transition: background 0.12s;
}
.audio-file-item:hover {
  background: var(--bg);
}
.audio-file-icon {
  flex-shrink: 0;
  font-size: 0.75rem;
}
.audio-file-name {
  flex: 1;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.audio-file-size {
  color: var(--muted);
  font-size: 0.68rem;
  white-space: nowrap;
}
.audio-play-btn {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 0.65rem;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: color 0.12s, border-color 0.12s;
}
.audio-play-btn:hover {
  color: var(--primary);
  border-color: var(--primary);
}
.audio-file-divider {
  font-size: 0.68rem;
  color: var(--muted);
  padding: 0.2rem 0.3rem;
  font-weight: 600;
  border-top: 1px solid var(--border);
  margin-top: 0.2rem;
}
.audio-file-empty {
  font-size: 0.7rem;
  color: var(--muted);
  padding: 0.3rem;
  text-align: center;
}

/* ---- Multi-part page dropdown ---- */
.page-dropdown-wrap {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.35rem;
}
.page-dropdown {
  flex: 1;
  padding: 0.3rem 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 0.78rem;
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s;
  min-width: 0;
  max-width: 100%;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.5rem center;
  padding-right: 1.5rem;
}
.page-dropdown:focus {
  border-color: var(--primary);
}
.page-dropdown option {
  background: var(--surface);
  color: var(--text);
  padding: 0.3rem;
}
.page-dropdown-count {
  font-size: 0.68rem;
  color: var(--muted);
  background: var(--bg);
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  white-space: nowrap;
  flex-shrink: 0;
}
.pages-hint {
  margin-left: 3px;
  font-size: 0.65rem;
  opacity: 0.8;
  background: rgba(255,255,255,0.15);
  padding: 0 3px;
  border-radius: 2px;
}
.loading-pages {
  opacity: 1 !important;
  animation: pulse 1s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* ---- Mobile responsive ---- */
@media (max-width: 600px) {
  .bili-panel {
    padding: 0.75rem;
  }
  .video-grid {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 0.5rem;
  }
  .card-title {
    font-size: 0.8rem;
  }
  .card-bottom {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
  }
  .author-name {
    max-width: 80px;
  }
  .extract-overlay-btn {
    opacity: 1;
  }
}
</style>
