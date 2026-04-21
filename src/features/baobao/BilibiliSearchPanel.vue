
<script setup lang="ts">
import { ref, computed, onMounted } from "vue";

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

function togglePlay(bvid: string) {
  playingBvid.value = playingBvid.value === bvid ? null : bvid;
}

const hasResults = computed(() => videos.value.length > 0);
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
        <!-- Thumbnail -->
        <div class="thumb-wrap" @click="togglePlay(v.bvid)">
          <img
            v-if="playingBvid !== v.bvid"
            :src="v.pic"
            :alt="v.title"
            class="thumb"
            loading="lazy"
            referrerpolicy="no-referrer"
          />
          <iframe
            v-else
            :src="`https://player.bilibili.com/player.html?bvid=${v.bvid}&autoplay=1&high_quality=1`"
            class="player-iframe"
            allowfullscreen
            frameborder="0"
            scrolling="no"
          ></iframe>
          <span v-if="playingBvid !== v.bvid" class="play-icon">▶</span>
          <span v-if="playingBvid !== v.bvid" class="duration-badge">{{ formatDuration(v.duration) }}</span>
        </div>
        <!-- Info -->
        <div class="card-info">
          <h3 class="card-title" :title="v.title" @click="openVideo(v.bvid)">{{ v.title }}</h3>
          <div class="card-meta">
            <span class="author">👤 {{ v.author }}</span>
            <span class="stat">▶ {{ formatCount(v.play) }}</span>
            <span class="stat">💬 {{ formatCount(v.danmaku) }}</span>
          </div>
          <div class="card-date">{{ formatDate(v.pubdate) }}</div>
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

/* ---- Video grid ---- */
.video-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
}

.video-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  transition: transform 0.15s, box-shadow 0.15s;
}
.video-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}

/* ---- Thumbnail ---- */
.thumb-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
  cursor: pointer;
  overflow: hidden;
}
.thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.2s;
}
.thumb-wrap:hover .thumb {
  transform: scale(1.05);
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
  font-size: 2.5rem;
  color: rgba(255, 255, 255, 0.85);
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
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
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  font-size: 0.75rem;
  padding: 2px 6px;
  border-radius: 4px;
  pointer-events: none;
}

/* ---- Card info ---- */
.card-info {
  padding: 0.6rem 0.75rem 0.75rem;
}
.card-title {
  margin: 0 0 0.35rem;
  font-size: 0.9rem;
  font-weight: 600;
  line-height: 1.35;
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
.card-meta {
  display: flex;
  gap: 0.6rem;
  font-size: 0.78rem;
  color: var(--muted);
  flex-wrap: wrap;
}
.card-date {
  font-size: 0.72rem;
  color: var(--muted);
  margin-top: 0.25rem;
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

/* ---- Mobile responsive ---- */
@media (max-width: 600px) {
  .bili-panel {
    padding: 0.75rem;
  }
  .video-grid {
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 0.6rem;
  }
  .card-title {
    font-size: 0.82rem;
  }
  .card-meta {
    font-size: 0.72rem;
  }
}
</style>
