<script setup lang="ts">
import { ref, computed, onMounted } from "vue";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface Track {
  id: number | string;
  name: string;
  artist: string;
  album: string;
  albumCover: string;
  duration: number; // ms
}

interface PlaylistInfo {
  id: number | string;
  name: string;
  description: string;
  coverUrl: string;
  trackCount: number;
  playCount: number;
  tracks: Track[];
  fetchedAt: string;
  source?: "netease" | "qq"; // playlist source platform
}

interface VoteEntry {
  likes: number;
  dislikes: number;
  voters: Record<string, "like" | "dislike">;
}

interface WishlistEntry {
  songId: string;
  count: number;
  songName: string;
  artist: string;
  recommenders: { name: string; at: string }[];
}

/* ------------------------------------------------------------------ */
/*  State                                                             */
/* ------------------------------------------------------------------ */

const API_BASE = "/__fmz_crimes";
const DEFAULT_NETEASE_ID = "575852081";
const DEFAULT_QQ_ID = "9711988130";

// Platform selector: "netease" | "qq"
const platform = ref<"netease" | "qq">(localStorage.getItem("crimes_platform") as any || "netease");

const loading = ref(false);
const error = ref("");
const playlist = ref<PlaylistInfo | null>(null);
const votes = ref<Record<string, VoteEntry>>({});
const wishlist = ref<Record<string, WishlistEntry>>({});
// Local set of song IDs this client has recommended (persisted in localStorage)
// Migrate old plain IDs to platform-prefixed format
const _rawRecommended: string[] = JSON.parse(localStorage.getItem("crimes_recommended") || "[]");
const _migratedRecommended = _rawRecommended.map((id) => {
  if (id.includes(":")) return id; // already qualified
  if (/^\d+$/.test(id)) return `netease:${id}`;
  return `qq:${id}`;
});
if (_migratedRecommended.some((v, i) => v !== _rawRecommended[i])) {
  localStorage.setItem("crimes_recommended", JSON.stringify(_migratedRecommended));
}
const localRecommended = ref<Set<string>>(new Set(_migratedRecommended));
const searchQuery = ref("");
const playlistIdInput = ref("");
const currentVoter = ref(localStorage.getItem("crimes_voter") || "");
const voterDialogOpen = ref(false);
const voterInput = ref("");
const descExpanded = ref(false);
// Track which wishlist row's recommenders dropdown is expanded
const expandedWishSongId = ref<string | null>(null);

function toggleRecommenders(songId: string) {
  expandedWishSongId.value = expandedWishSongId.value === songId ? null : songId;
}

// Sub-tab: "playlist" | "wishlist"
const subTab = ref<"playlist" | "wishlist">("playlist");



/* ------------------------------------------------------------------ */
/*  Computed                                                          */
/* ------------------------------------------------------------------ */

// Sort mode for playlist: "default" | "likes" | "recommend" | "alpha"
const playlistSort = ref<"default" | "likes" | "recommend" | "alpha">("default");
// Sort mode for wishlist: "recommend" | "likes" | "alpha"
const wishlistSort = ref<"recommend" | "likes" | "alpha">("recommend");

const filteredTracks = computed(() => {
  if (!playlist.value) return [];
  let tracks = playlist.value.tracks;
  const q = searchQuery.value.trim().toLowerCase();
  if (q) {
    tracks = tracks.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.album.toLowerCase().includes(q),
    );
  }
  // Apply sort
  if (playlistSort.value === "likes") {
    tracks = [...tracks].sort((a, b) => {
      const la = votes.value[qualifiedId(a)]?.likes || 0;
      const lb = votes.value[qualifiedId(b)]?.likes || 0;
      return lb - la;
    });
  } else if (playlistSort.value === "recommend") {
    tracks = [...tracks].sort((a, b) => {
      const ra = wishlist.value[qualifiedId(a)]?.count || 0;
      const rb = wishlist.value[qualifiedId(b)]?.count || 0;
      return rb - ra;
    });
  } else if (playlistSort.value === "alpha") {
    tracks = [...tracks].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }
  return tracks;
});

const wishlistSongIds = computed(() => localRecommended.value);

/** Sorted wishlist entries for display */
const wishlistEntries = computed(() => {
  let entries = Object.entries(wishlist.value)
    .map(([songId, entry]) => ({ songId, ...entry }));
  if (wishlistSort.value === "recommend") {
    entries.sort((a, b) => b.count - a.count);
  } else if (wishlistSort.value === "likes") {
    entries.sort((a, b) => {
      const la = votes.value[a.songId]?.likes || 0;
      const lb = votes.value[b.songId]?.likes || 0;
      return lb - la;
    });
  } else if (wishlistSort.value === "alpha") {
    entries.sort((a, b) => a.songName.localeCompare(b.songName, "zh-CN"));
  }
  return entries;
});

const wishlistCount = computed(() => wishlistEntries.value.length);

/**
 * Generate a globally unique song ID with platform prefix.
 * e.g. "netease:575852081" or "qq:12345"
 */
function qualifiedId(trackOrId: Track | number | string): string {
  if (typeof trackOrId === "object" && trackOrId !== null) {
    const src = playlist.value?.source || "netease";
    return `${src}:${trackOrId.id}`;
  }
  // Already qualified (contains ":")
  const s = String(trackOrId);
  if (s.includes(":")) return s;
  // Fallback: assume current platform
  const src = playlist.value?.source || "netease";
  return `${src}:${s}`;
}

/** Format play count like Netease: 12345 → 1.2万 */
function formatPlayCount(n: number): string {
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + "亿";
  if (n >= 10_000) return (n / 10_000).toFixed(1) + "万";
  return String(n);
}

/* ------------------------------------------------------------------ */
/*  API calls                                                         */
/* ------------------------------------------------------------------ */

/**
 * Extract playlist ID from user input.
 * Supports raw ID or full QQ Music URL.
 */
function extractPlaylistId(input: string): string {
  const trimmed = input.trim();
  // QQ Music URL patterns
  const qqUrlMatch = trimmed.match(/y\.qq\.com\/n\/ryqq(?:_v2)?\/playlist\/(\d+)/);
  if (qqUrlMatch) return qqUrlMatch[1];
  // Strip "qq:" prefix if present
  if (/^qq:/i.test(trimmed)) return trimmed.replace(/^qq:/i, "").trim();
  return trimmed;
}

function getDefaultId(): string {
  return platform.value === "qq" ? DEFAULT_QQ_ID : DEFAULT_NETEASE_ID;
}

function switchPlatform(p: "netease" | "qq") {
  platform.value = p;
  localStorage.setItem("crimes_platform", p);
  // Update input placeholder with default ID
  playlistIdInput.value = "";
  // Auto-load default playlist for the new platform
  loadPlaylist();
}

async function loadPlaylist(id?: string) {
  const rawInput = id || playlistIdInput.value.trim() || getDefaultId();
  if (!rawInput) {
    error.value = "请输入歌单 ID";
    return;
  }

  const pid = extractPlaylistId(rawInput);
  if (!pid) {
    error.value = "无法识别歌单 ID";
    return;
  }

  loading.value = true;
  error.value = "";
  try {
    const endpoint = platform.value === "qq" ? `${API_BASE}/qq-playlist/${pid}` : `${API_BASE}/playlist/${pid}`;
    const resp = await fetch(endpoint);
    if (!resp.ok) throw new Error(`加载失败 (${resp.status})`);
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "加载失败");
    // Mark the source on the playlist
    data.playlist.source = platform.value;
    playlist.value = data.playlist;
    playlistIdInput.value = pid;
    localStorage.setItem("crimes_playlist_id", pid);
  } catch (e: any) {
    error.value = e.message || "加载歌单失败";
  } finally {
    loading.value = false;
  }
}

async function loadVotes() {
  try {
    const resp = await fetch(`${API_BASE}/votes`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.ok) votes.value = data.votes;
  } catch { /* ignore */ }
}

async function loadWishlist() {
  try {
    const resp = await fetch(`${API_BASE}/wishlist`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (data.ok) wishlist.value = data.wishlist || {};
  } catch { /* ignore */ }
}

async function vote(songId: string, action: "like" | "dislike" | "cancel") {
  if (!currentVoter.value) {
    voterDialogOpen.value = true;
    return;
  }
  try {
    const resp = await fetch(`${API_BASE}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ songId, voter: currentVoter.value, action }),
    });
    const data = await resp.json();
    if (data.ok) {
      votes.value = { ...votes.value, [songId]: data.song };
    }
  } catch { /* ignore */ }
}

async function addToWishlist(track: Track) {
  if (!currentVoter.value) {
    voterDialogOpen.value = true;
    return;
  }
  const qid = qualifiedId(track);
  try {
    const resp = await fetch(`${API_BASE}/wishlist/recommend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        songId: qid,
        songName: track.name,
        artist: track.artist,
        recommender: currentVoter.value,
      }),
    });
    const data = await resp.json();
    if (data.ok) {
      // Update server data
      wishlist.value = { ...wishlist.value, [data.song.songId]: data.song };
      // Mark locally as recommended
      localRecommended.value = new Set([...localRecommended.value, qid]);
      localStorage.setItem("crimes_recommended", JSON.stringify([...localRecommended.value]));
    }
  } catch { /* ignore */ }
}

function isLocalRecommended(songId: string): boolean {
  return localRecommended.value.has(songId);
}



/* ------------------------------------------------------------------ */
/*  Voter identity                                                    */
/* ------------------------------------------------------------------ */

function confirmVoter() {
  const name = voterInput.value.trim();
  if (!name) return;
  currentVoter.value = name;
  localStorage.setItem("crimes_voter", name);
  voterDialogOpen.value = false;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getVote(songId: string): VoteEntry | null {
  return votes.value[songId] || null;
}

function myVote(songId: string): "like" | "dislike" | null {
  const entry = getVote(songId);
  if (!entry || !currentVoter.value) return null;
  return entry.voters[currentVoter.value] || null;
}

function padIndex(i: number): string {
  return String(i).padStart(2, "0");
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                         */
/* ------------------------------------------------------------------ */

onMounted(() => {
  const savedId = localStorage.getItem("crimes_playlist_id") || getDefaultId();
  playlistIdInput.value = savedId;
  loadPlaylist(savedId);
  loadVotes();
  loadWishlist();
});

function reload() {
  if (playlistIdInput.value) loadPlaylist();
  loadVotes();
  loadWishlist();
}

defineExpose({ reload });
</script>

<template>
  <section class="nc">
    <!-- ============ Banner / Playlist Header (Netease style) ============ -->
    <div v-if="playlist" class="nc-banner">
      <div class="nc-banner-cover">
        <img :src="playlist.coverUrl + (playlist.source === 'qq' ? '' : '?param=200y200')" alt="cover" />
        <span class="nc-cover-badge">歌单</span>
      </div>
      <div class="nc-banner-info">
        <h1 class="nc-banner-title">{{ playlist.name }}</h1>
        <div class="nc-banner-meta">
          <span class="nc-meta-count">🎵 {{ playlist.trackCount }} 首</span>
          <span class="nc-meta-play">▶ {{ formatPlayCount(playlist.playCount) }}次播放</span>
          <a
            v-if="playlist.source === 'qq'"
            class="nc-meta-link"
            :href="`https://y.qq.com/n/ryqq/playlist/${playlist.id}`"
            target="_blank"
            rel="noopener"
          >↗ QQ音乐打开</a>
          <a
            v-else
            class="nc-meta-link"
            :href="`https://music.163.com/#/playlist?id=${playlist.id}`"
            target="_blank"
            rel="noopener"
          >↗ 网易云打开</a>
        </div>
        <div v-if="playlist.description" class="nc-banner-desc" :class="{ expanded: descExpanded }">
          <p>{{ playlist.description }}</p>
          <button class="nc-desc-toggle" @click="descExpanded = !descExpanded">
            {{ descExpanded ? '收起' : '展开' }}
          </button>
        </div>
        <div class="nc-banner-actions">
          <button
            class="nc-btn nc-btn--wish"
            @click="subTab = subTab === 'wishlist' ? 'playlist' : 'wishlist'"
          >
            ⭐ 愿望单 <span v-if="wishlistCount" class="nc-badge">{{ wishlistCount }}</span>
          </button>
          <div class="nc-voter-chip" @click="voterDialogOpen = true">
            👤 {{ currentVoter || '设置昵称' }}
          </div>
        </div>
      </div>
    </div>

    <!-- ============ Playlist ID input (when no playlist loaded) ============ -->
    <div v-if="!playlist && !loading" class="nc-empty-state">
      <div class="nc-empty-icon">🎵</div>
      <h2>细数宝罪</h2>
      <p>选择平台并输入歌单 ID，开始探索</p>
      <div class="nc-id-bar">
        <select v-model="platform" class="nc-platform-select" @change="playlistIdInput = ''">
          <option value="netease">🎵 网易云音乐</option>
          <option value="qq">🎶 QQ音乐</option>
        </select>
        <input
          v-model="playlistIdInput"
          type="text"
          :placeholder="`歌单 ID（默认 ${getDefaultId()}）`"
          class="nc-id-input"
          @keydown.enter="loadPlaylist()"
        />
        <button class="nc-btn nc-btn--play" @click="loadPlaylist()" :disabled="loading">
          获取歌单
        </button>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading && !playlist" class="nc-loading">
      <span class="nc-spinner"></span> 加载歌单中…
    </div>

    <!-- Error -->
    <div v-if="error" class="nc-error">
      ⚠️ {{ error }}
      <button class="nc-error-close" @click="error = ''">✕</button>
    </div>

    <!-- ============ Toolbar (search + switch playlist) ============ -->
    <div v-if="playlist" class="nc-toolbar">
      <nav class="nc-sub-tabs">
        <button :class="{ on: subTab === 'playlist' }" @click="subTab = 'playlist'">
          歌曲列表
        </button>
        <button :class="{ on: subTab === 'wishlist' }" @click="subTab = 'wishlist'">
          愿望单<span v-if="wishlistCount" class="nc-tab-count">{{ wishlistCount }}</span>
        </button>
      </nav>
      <div class="nc-toolbar-right">
        <div class="nc-search-box">
          <span class="nc-search-ico">🔍</span>
          <input
            v-model="searchQuery"
            type="search"
            placeholder="搜索歌单音乐"
            class="nc-search-input"
          />
        </div>
        <div class="nc-switch-playlist">
          <select v-model="platform" class="nc-platform-sel" @change="switchPlatform(platform)">
            <option value="netease">🎵 网易云</option>
            <option value="qq">🎶 QQ</option>
          </select>
          <input
            v-model="playlistIdInput"
            type="text"
            :placeholder="platform === 'qq' ? 'QQ歌单ID' : '歌单ID'"
            class="nc-switch-input"
            @keydown.enter="loadPlaylist()"
          />
          <button class="nc-switch-btn" @click="loadPlaylist()" :disabled="loading" title="切换歌单">
            ↻
          </button>
        </div>
      </div>
    </div>

    <!-- ============ Track Table (Netease style) ============ -->
    <div v-if="subTab === 'playlist' && playlist && filteredTracks.length > 0" class="nc-table-wrap">
      <!-- Sort bar -->
      <div class="nc-sort-bar">
        <span class="nc-sort-label">排序：</span>
        <button :class="{ on: playlistSort === 'default' }" @click="playlistSort = 'default'">默认</button>
        <button :class="{ on: playlistSort === 'likes' }" @click="playlistSort = 'likes'">点赞</button>
        <button :class="{ on: playlistSort === 'recommend' }" @click="playlistSort = 'recommend'">推荐</button>
        <button :class="{ on: playlistSort === 'alpha' }" @click="playlistSort = 'alpha'">字母</button>
      </div>
      <!-- Table header -->
      <div class="nc-table-header">
        <span class="nc-th nc-th-idx"></span>
        <span class="nc-th nc-th-title" :class="{ 'nc-th-title--no-cover': playlist?.source === 'qq' }">音乐标题</span>
        <span class="nc-th nc-th-artist">歌手</span>
        <span class="nc-th nc-th-album">专辑</span>
        <span class="nc-th nc-th-actions">操作</span>
        <span class="nc-th nc-th-dur">时长</span>
      </div>
      <!-- Rows -->
      <div
        v-for="(track, idx) in filteredTracks"
        :key="track.id"
        class="nc-row"
        :class="{ 'nc-row--even': idx % 2 === 0 }"
      >
        <!-- Index -->
        <span class="nc-cell nc-cell-idx">{{ padIndex(idx + 1) }}</span>

        <!-- Title + cover -->
        <span class="nc-cell nc-cell-title" :class="{ 'nc-cell-title--no-cover': playlist?.source === 'qq' }">
          <img v-if="playlist?.source !== 'qq'" :src="track.albumCover + '?param=34y34'" class="nc-row-cover" alt="" />
          <span class="nc-song-name" :title="track.name">{{ track.name }}</span>
        </span>

        <!-- Artist -->
        <span class="nc-cell nc-cell-artist" :title="track.artist">{{ track.artist }}</span>

        <!-- Album -->
        <span class="nc-cell nc-cell-album" :title="track.album">{{ track.album }}</span>

        <!-- Actions -->
        <span class="nc-cell nc-cell-actions">
          <button
            class="nc-act-btn nc-act-btn--fixed"
            :class="{ liked: myVote(qualifiedId(track)) === 'like' }"
            @click.stop="vote(qualifiedId(track), myVote(qualifiedId(track)) === 'like' ? 'cancel' : 'like')"
            title="点赞"
          >
            <svg class="nc-ico" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg><sup>{{ getVote(qualifiedId(track))?.likes || 0 }}</sup>
          </button>
          <button
            class="nc-act-btn nc-act-btn--fixed"
            :class="{ wished: isLocalRecommended(qualifiedId(track)) }"
            @click.stop="addToWishlist(track)"
            :disabled="isLocalRecommended(qualifiedId(track))"
            title="推荐到愿望单"
          >
            <svg class="nc-ico" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg><sup>{{ wishlist[qualifiedId(track)]?.count || 0 }}</sup>
          </button>
        </span>

        <!-- Duration -->
        <span class="nc-cell nc-cell-dur">{{ formatDuration(track.duration) }}</span>
      </div>
    </div>

    <!-- ============ Wishlist Tab ============ -->
    <div v-if="subTab === 'wishlist'" class="nc-wishlist-section">
      <div v-if="wishlistEntries.length === 0" class="nc-wish-empty">
        愿望单为空，去歌单中点 ☆ 推荐歌曲吧
      </div>
      <div v-else class="nc-table-wrap nc-wish-table">
        <!-- Sort bar -->
        <div class="nc-sort-bar">
          <span class="nc-sort-label">排序：</span>
          <button :class="{ on: wishlistSort === 'recommend' }" @click="wishlistSort = 'recommend'">推荐</button>
          <button :class="{ on: wishlistSort === 'likes' }" @click="wishlistSort = 'likes'">点赞</button>
          <button :class="{ on: wishlistSort === 'alpha' }" @click="wishlistSort = 'alpha'">字母</button>
        </div>
        <!-- Table header -->
        <div class="nc-table-header">
          <span class="nc-th nc-th-idx"></span>
          <span class="nc-th nc-th-title nc-th-title--no-cover">音乐标题</span>
          <span class="nc-th nc-th-artist">歌手</span>
          <span class="nc-th nc-th-actions">操作</span>
          <span class="nc-th nc-th-dur">推荐数</span>
        </div>
        <template v-for="(item, idx) in wishlistEntries" :key="item.songId">
          <div
            class="nc-row"
            :class="{ 'nc-row--even': idx % 2 === 0, 'nc-row--expanded': expandedWishSongId === item.songId }"
          >
            <span class="nc-cell nc-cell-idx">{{ padIndex(idx + 1) }}</span>
            <span class="nc-cell nc-cell-title nc-cell-title--no-cover">
              <span class="nc-song-name">{{ item.songName }}</span>
            </span>
            <span class="nc-cell nc-cell-artist">{{ item.artist }}</span>
            <span class="nc-cell nc-cell-actions">
              <button
                class="nc-act-btn nc-act-btn--fixed"
                :class="{ liked: myVote(item.songId) === 'like' }"
                @click.stop="vote(item.songId, myVote(item.songId) === 'like' ? 'cancel' : 'like')"
                title="点赞"
              >
                <svg class="nc-ico" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg><sup>{{ getVote(item.songId)?.likes || 0 }}</sup>
              </button>
            </span>
            <span
              class="nc-cell nc-cell-dur nc-recommend-count nc-recommend-clickable"
              @click="toggleRecommenders(item.songId)"
              title="点击查看推荐人"
            >
              {{ item.count }}
              <svg class="nc-expand-arrow" :class="{ open: expandedWishSongId === item.songId }" viewBox="0 0 12 12"><path d="M3 5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </span>
          </div>
          <!-- Recommenders dropdown panel -->
          <div v-if="expandedWishSongId === item.songId" class="nc-recs-dropdown">
            <div class="nc-recs-dropdown-title">推荐人（{{ Math.min(item.recommenders.length, 100) }}/{{ item.recommenders.length }}）</div>
            <div class="nc-recs-dropdown-list">
              <span
                v-for="(r, ri) in item.recommenders.slice(-100).reverse()"
                :key="ri"
                class="nc-recommender-tag"
                :title="r.at"
              >{{ r.name }}</span>
            </div>
          </div>
        </template>
      </div>
    </div>



    <!-- Voter dialog -->
    <div v-if="voterDialogOpen" class="nc-overlay" @click.self="voterDialogOpen = false">
      <div class="nc-dialog">
        <h3>设置昵称</h3>
        <p>用于投票和推荐歌曲时标记身份</p>
        <input
          v-model="voterInput"
          type="text"
          class="nc-id-input"
          placeholder="输入昵称"
          @keydown.enter="confirmVoter"
          autofocus
        />
        <div class="nc-dialog-foot">
          <button class="nc-btn nc-btn--ghost" @click="voterDialogOpen = false">取消</button>
          <button class="nc-btn nc-btn--play" @click="confirmVoter">确认</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ================================================================== */
/*  Theme-aware styles using CSS variables                            */
/* ================================================================== */
.nc {
  max-width: 980px;
  margin: 0 auto;
  padding: 1.25rem;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", sans-serif;
  color: var(--text, #e8eef7);
}

/* ---- Banner ---- */
.nc-banner {
  display: flex;
  gap: 1.5rem;
  padding: 1.5rem;
  border-radius: 12px;
  background: var(--surface, #1a2332);
  border: 1px solid var(--border, #2d3a4d);
  margin-bottom: 0;
}

.nc-banner-cover {
  position: relative;
  flex-shrink: 0;
}

.nc-banner-cover img {
  width: 180px;
  height: 180px;
  border-radius: 10px;
  object-fit: cover;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}

.nc-cover-badge {
  position: absolute;
  top: 8px;
  right: -6px;
  background: var(--primary, #5c9eff);
  color: var(--on-primary, #0a1628);
  font-size: 0.65rem;
  padding: 2px 8px;
  border-radius: 2px;
  font-weight: 700;
  letter-spacing: 1px;
}

.nc-banner-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
}

.nc-banner-title {
  font-size: 1.5rem;
  font-weight: 700;
  margin: 0 0 0.5rem;
  line-height: 1.3;
  color: var(--text, #e8eef7);
}

.nc-banner-meta {
  display: flex;
  gap: 1rem;
  font-size: 0.8rem;
  color: var(--muted, #8b9cb3);
  margin-bottom: 0.5rem;
  flex-wrap: wrap;
}

.nc-meta-link {
  color: var(--primary, #5c9eff);
  text-decoration: none;
}
.nc-meta-link:hover { text-decoration: underline; }

.nc-banner-desc {
  font-size: 0.8rem;
  color: var(--muted, #8b9cb3);
  line-height: 1.5;
  margin-bottom: 0.75rem;
  position: relative;
}

.nc-banner-desc p {
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.nc-banner-desc.expanded p {
  -webkit-line-clamp: unset;
}

.nc-desc-toggle {
  background: none;
  border: none;
  color: var(--primary, #5c9eff);
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0;
  margin-top: 2px;
}

.nc-banner-actions {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  flex-wrap: wrap;
  margin-top: auto;
}

/* ---- Buttons ---- */
.nc-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.5rem 1.2rem;
  border: none;
  border-radius: 20px;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 600;
  transition: all 0.15s;
  white-space: nowrap;
}

.nc-btn--play {
  background: var(--primary, #5c9eff);
  color: var(--on-primary, #0a1628);
}
.nc-btn--play:hover { opacity: 0.85; }
.nc-btn--play:disabled { opacity: 0.5; cursor: not-allowed; }

.nc-btn-ico {
  font-size: 0.7rem;
}

.nc-btn--wish {
  background: color-mix(in srgb, var(--surface, #1a2332) 80%, var(--text, #e8eef7) 20%);
  color: var(--text, #e8eef7);
  border: 1px solid var(--border, #2d3a4d);
}
.nc-btn--wish:hover { opacity: 0.85; }

.nc-btn--ghost {
  background: transparent;
  color: var(--muted, #8b9cb3);
  border: 1px solid var(--border, #2d3a4d);
}
.nc-btn--ghost:hover { border-color: var(--primary, #5c9eff); color: var(--text, #e8eef7); }

.nc-badge {
  font-size: 0.7rem;
  background: var(--primary, #5c9eff);
  color: var(--on-primary, #0a1628);
  padding: 1px 6px;
  border-radius: 10px;
  margin-left: 2px;
}

.nc-voter-chip {
  padding: 0.4rem 0.8rem;
  border-radius: 20px;
  background: var(--surface, #1a2332);
  border: 1px solid var(--border, #2d3a4d);
  color: var(--muted, #8b9cb3);
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s;
}
.nc-voter-chip:hover { border-color: var(--primary, #5c9eff); color: var(--text, #e8eef7); }

/* ---- Empty state ---- */
.nc-empty-state {
  text-align: center;
  padding: 4rem 1rem;
}

.nc-empty-icon {
  font-size: 3rem;
  margin-bottom: 0.5rem;
}

.nc-empty-state h2 {
  margin: 0 0 0.5rem;
  color: var(--text, #e8eef7);
  font-size: 1.4rem;
}

.nc-empty-state p {
  color: var(--muted, #8b9cb3);
  margin: 0 0 1.5rem;
  font-size: 0.9rem;
}

.nc-id-bar {
  display: flex;
  gap: 0.5rem;
  max-width: 400px;
  margin: 0 auto;
}

.nc-id-input {
  flex: 1;
  padding: 0.55rem 0.85rem;
  border: 1px solid var(--border, #2d3a4d);
  border-radius: 20px;
  background: var(--bg, #0f1419);
  color: var(--text, #e8eef7);
  font-size: 0.9rem;
}
.nc-id-input:focus { outline: none; border-color: var(--primary, #5c9eff); }

/* Platform selector (empty state) */
.nc-platform-select {
  padding: 0.55rem 0.85rem;
  border: 1px solid var(--border, #2d3a4d);
  border-radius: 20px;
  background: var(--surface, #1a2332);
  color: var(--text, #e8eef7);
  font-size: 0.85rem;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%238b9cb3'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.7rem center;
  padding-right: 2rem;
}
.nc-platform-select:focus { outline: none; border-color: var(--primary, #5c9eff); }

/* Platform selector (toolbar, compact) */
.nc-platform-sel {
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border, #2d3a4d);
  border-radius: 16px 0 0 16px;
  background: var(--surface, #1a2332);
  color: var(--text, #e8eef7);
  font-size: 0.72rem;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%238b9cb3'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.35rem center;
  padding-right: 1.2rem;
  border-right: none;
  white-space: nowrap;
}
.nc-platform-sel:focus { outline: none; border-color: var(--primary, #5c9eff); }

/* ---- Loading / Error ---- */
.nc-loading {
  text-align: center;
  padding: 3rem;
  color: var(--muted, #8b9cb3);
}

.nc-spinner {
  display: inline-block;
  width: 1em;
  height: 1em;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: nc-spin 0.6s linear infinite;
  margin-right: 0.4rem;
}

@keyframes nc-spin { to { transform: rotate(360deg); } }

.nc-error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.6rem 1rem;
  margin: 0.75rem 0;
  background: color-mix(in srgb, var(--danger, #ff6b6b) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger, #ff6b6b) 20%, transparent);
  border-radius: 6px;
  color: var(--danger, #ff6b6b);
  font-size: 0.85rem;
}

.nc-error-close {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 1rem;
}

/* ---- Toolbar ---- */
.nc-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--border, #2d3a4d);
  margin-bottom: 0;
  gap: 0.5rem;
  flex-wrap: nowrap;
}

.nc-sub-tabs {
  display: flex;
  gap: 0;
}

.nc-sub-tabs button {
  padding: 0.45rem 0.75rem;
  border: none;
  background: transparent;
  color: var(--muted, #8b9cb3);
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 600;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
  white-space: nowrap;
}

.nc-sub-tabs button.on {
  color: var(--primary, #5c9eff);
  border-bottom-color: var(--primary, #5c9eff);
}

.nc-tab-count {
  font-size: 0.7rem;
  color: var(--muted, #8b9cb3);
  margin-left: 3px;
}

.nc-toolbar-right {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.nc-search-box {
  position: relative;
}

.nc-search-ico {
  position: absolute;
  left: 0.6rem;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.75rem;
  pointer-events: none;
}

.nc-search-input {
  padding: 0.35rem 0.6rem 0.35rem 1.8rem;
  border: 1px solid var(--border, #2d3a4d);
  border-radius: 16px;
  background: var(--bg, #0f1419);
  color: var(--text, #e8eef7);
  font-size: 0.8rem;
  width: 180px;
  min-width: 0;
  transition: width 0.2s;
}
.nc-search-input:focus { outline: none; border-color: var(--primary, #5c9eff); width: 220px; }

.nc-switch-playlist {
  display: flex;
  gap: 0;
}

.nc-switch-input {
  padding: 0.35rem 0.6rem;
  border: 1px solid var(--border, #2d3a4d);
  border-radius: 0;
  background: var(--bg, #0f1419);
  color: var(--text, #e8eef7);
  font-size: 0.8rem;
  width: 100px;
  min-width: 0;
  border-left: none;
}
.nc-switch-input:focus { outline: none; border-color: var(--primary, #5c9eff); }

.nc-switch-btn {
  padding: 0.35rem 0.6rem;
  border: 1px solid var(--border, #2d3a4d);
  border-left: none;
  border-radius: 0 16px 16px 0;
  background: var(--surface, #1a2332);
  color: var(--muted, #8b9cb3);
  cursor: pointer;
  font-size: 0.85rem;
}
.nc-switch-btn:hover { color: var(--text, #e8eef7); }

/* ---- Table ---- */
.nc-table-wrap {
  border-radius: 0 0 8px 8px;
  overflow: hidden;
}

.nc-table-header {
  display: flex;
  align-items: center;
  padding: 0.5rem 0.75rem;
  font-size: 0.75rem;
  color: var(--muted, #8b9cb3);
  border-bottom: 1px solid var(--border, #2d3a4d);
  user-select: none;
}

.nc-th-idx   { width: 40px; text-align: center; flex-shrink: 0; }
.nc-th-title { flex: 2; min-width: 0; padding-left: calc(34px + 0.6rem); }
.nc-th-title--no-cover { padding-left: 0.4rem; }
.nc-th-artist { flex: 1; min-width: 0; }
.nc-th-album { flex: 1; min-width: 0; }
.nc-th-actions { width: 100px; text-align: center; flex-shrink: 0; }
.nc-th-dur   { width: 56px; text-align: right; flex-shrink: 0; }

/* Row */
.nc-row {
  display: flex;
  align-items: center;
  padding: 0.45rem 0.75rem;
  transition: background 0.1s;
  border-radius: 0;
}

.nc-row--even {
  background: color-mix(in srgb, var(--surface, #1a2332) 50%, var(--bg, #0f1419) 50%);
}

.nc-row:hover {
  background: var(--surface, #1a2332);
}

/* Cells */
.nc-cell-idx {
  width: 40px;
  text-align: center;
  flex-shrink: 0;
  font-size: 0.8rem;
  color: var(--muted, #8b9cb3);
}

.nc-cell-title {
  flex: 2;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.nc-row-cover {
  width: 34px;
  height: 34px;
  border-radius: 4px;
  object-fit: cover;
  flex-shrink: 0;
}

.nc-song-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.88rem;
  color: var(--text, #e8eef7);
  transition: color 0.15s;
}

.nc-cell-title:hover .nc-song-name {
  color: var(--primary, #5c9eff);
}

.nc-cell-artist {
  flex: 1;
  min-width: 0;
  font-size: 0.8rem;
  color: var(--muted, #8b9cb3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nc-cell-album {
  flex: 1;
  min-width: 0;
  font-size: 0.8rem;
  color: var(--muted, #8b9cb3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nc-cell-title--no-cover {
  padding-left: 0.4rem;
}

.nc-cell-actions {
  width: 100px;
  display: flex;
  justify-content: center;
  gap: 0.15rem;
  flex-shrink: 0;
  box-sizing: border-box;
}

.nc-act-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.15rem 0.35rem;
  font-size: 0.85rem;
  border-radius: 4px;
  color: var(--muted, #8b9cb3);
  transition: all 0.12s;
  position: relative;
}

.nc-act-btn--fixed {
  min-width: 2.8rem;
  text-align: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 1px;
}

/* SVG icon inside action buttons */
.nc-ico {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  vertical-align: middle;
  transition: fill 0.15s, stroke 0.15s;
}

.nc-act-btn.liked .nc-ico,
.nc-act-btn.wished .nc-ico {
  stroke: none;
}

.nc-act-btn:hover { background: var(--surface, #1a2332); color: var(--text, #e8eef7); }

.nc-act-btn sup {
  font-size: 0.6rem;
  position: relative;
  top: -0.4em;
  margin-left: 1px;
}

.nc-act-btn.liked { color: var(--danger, #ff6b6b); }
.nc-act-btn.liked .nc-ico { fill: var(--danger, #ff6b6b); }
.nc-act-btn.disliked { color: var(--danger, #ff6b6b); }
.nc-act-btn.wished { color: var(--accent, #3dd68c); }
.nc-act-btn.wished .nc-ico { fill: var(--accent, #3dd68c); }
.nc-act-btn:disabled { cursor: default; }

.nc-act-btn--rm {
  font-size: 0.75rem;
  color: var(--danger, #ff6b6b);
  border: 1px solid color-mix(in srgb, var(--danger, #ff6b6b) 20%, transparent);
  border-radius: 10px;
  padding: 0.15rem 0.5rem;
}
.nc-act-btn--rm:hover { background: color-mix(in srgb, var(--danger, #ff6b6b) 12%, transparent); }

.nc-cell-dur {
  width: 56px;
  text-align: right;
  flex-shrink: 0;
  font-size: 0.8rem;
  color: var(--muted, #8b9cb3);
  font-variant-numeric: tabular-nums;
}

/* ---- Sort bar ---- */
.nc-sort-bar {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--border, #2d3a4d);
}

.nc-sort-label {
  font-size: 0.75rem;
  color: var(--muted, #8b9cb3);
  margin-right: 0.25rem;
}

.nc-sort-bar button {
  padding: 0.2rem 0.6rem;
  border: 1px solid var(--border, #2d3a4d);
  border-radius: 12px;
  background: transparent;
  color: var(--muted, #8b9cb3);
  font-size: 0.72rem;
  cursor: pointer;
  transition: all 0.12s;
}

.nc-sort-bar button:hover {
  background: var(--surface, #1a2332);
  color: var(--text, #e8eef7);
}

.nc-sort-bar button.on {
  background: color-mix(in srgb, var(--primary, #5c9eff) 15%, transparent);
  border-color: color-mix(in srgb, var(--primary, #5c9eff) 40%, transparent);
  color: var(--primary, #5c9eff);
  font-weight: 600;
}

/* ---- Wishlist empty ---- */
.nc-wish-empty {
  text-align: center;
  padding: 3rem;
  color: var(--muted, #8b9cb3);
  font-size: 0.9rem;
}

/* ---- Dialog ---- */
.nc-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.nc-dialog {
  background: var(--bg, #0f1419);
  border: 1px solid var(--border, #2d3a4d);
  border-radius: 12px;
  padding: 1.5rem;
  width: 320px;
  max-width: 90vw;
}

.nc-dialog h3 {
  margin: 0 0 0.5rem;
  color: var(--text, #e8eef7);
}

.nc-dialog p {
  margin: 0 0 1rem;
  font-size: 0.85rem;
  color: var(--muted, #8b9cb3);
}

.nc-dialog .nc-id-input {
  width: 100%;
  margin-bottom: 1rem;
  box-sizing: border-box;
  border-radius: 6px;
}

.nc-dialog-foot {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}

/* ---- Wishlist recommenders dropdown ---- */
.nc-recommend-count {
  color: var(--primary, #5c9eff);
  font-weight: 700;
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
}

.nc-recommend-clickable {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  user-select: none;
  transition: color 0.12s;
}

.nc-recommend-clickable:hover {
  color: var(--accent, #3dd68c);
}

.nc-expand-arrow {
  width: 10px;
  height: 10px;
  transition: transform 0.2s;
  flex-shrink: 0;
}

.nc-expand-arrow.open {
  transform: rotate(180deg);
}

.nc-row--expanded {
  background: color-mix(in srgb, var(--primary, #5c9eff) 6%, var(--bg, #0f1419) 94%) !important;
}

.nc-recs-dropdown {
  padding: 0.6rem 0.75rem 0.6rem calc(40px + 0.75rem);
  background: color-mix(in srgb, var(--surface, #1a2332) 60%, var(--bg, #0f1419) 40%);
  border-bottom: 1px solid var(--border, #2d3a4d);
  animation: nc-slide-down 0.15s ease-out;
}

@keyframes nc-slide-down {
  from { opacity: 0; max-height: 0; }
  to { opacity: 1; max-height: 300px; }
}

.nc-recs-dropdown-title {
  font-size: 0.72rem;
  color: var(--muted, #8b9cb3);
  margin-bottom: 0.4rem;
}

.nc-recs-dropdown-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  max-height: 200px;
  overflow-y: auto;
}

.nc-recommender-tag {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border-radius: 10px;
  background: color-mix(in srgb, var(--primary, #5c9eff) 12%, transparent);
  color: var(--primary, #5c9eff);
  font-size: 0.72rem;
  white-space: nowrap;
}

/* ---- Responsive ---- */
@media (max-width: 700px) {
  .nc-banner {
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .nc-banner-cover img { width: 140px; height: 140px; }
  .nc-banner-actions { justify-content: center; }

  /* Toolbar: keep tabs + search on one line */
  .nc-toolbar {
    flex-wrap: nowrap;
    gap: 0.3rem;
    overflow-x: auto;
  }
  .nc-sub-tabs { flex-shrink: 0; }
  .nc-sub-tabs button { padding: 0.35rem 0.5rem; font-size: 0.75rem; }
  .nc-toolbar-right { flex-shrink: 1; min-width: 0; }
  .nc-search-input { width: 100px; font-size: 0.72rem; padding-left: 1.5rem; }
  .nc-search-input:focus { width: 120px; }
  .nc-search-ico { font-size: 0.65rem; left: 0.4rem; }
  .nc-switch-input { width: 90px; font-size: 0.72rem; }
  .nc-switch-btn { font-size: 0.75rem; padding: 0.3rem 0.4rem; }
  .nc-platform-sel { font-size: 0.65rem; padding: 0.25rem 0.3rem; }

  /* Playlist: hide album column on mobile */
  .nc-th-album, .nc-cell-album { display: none; }
  .nc-th-actions, .nc-cell-actions { width: 60px; }
  .nc-act-btn--fixed { min-width: 2.2rem; }

  /* Playlist title: smaller cover offset on mobile */
  .nc-th-title { padding-left: calc(28px + 0.4rem); }
  .nc-row-cover { width: 28px; height: 28px; }
  .nc-cell-title { gap: 0.4rem; }
  .nc-song-name { font-size: 0.8rem; }
  .nc-cell-artist { font-size: 0.72rem; }
  .nc-cell-dur { width: 44px; font-size: 0.72rem; }
  .nc-cell-idx { width: 28px; font-size: 0.72rem; }
  .nc-th-idx { width: 28px; }
  .nc-th-dur { width: 44px; }

  /* Wishlist: no cover offset */
  .nc-wish-table .nc-th-title--no-cover,
  .nc-wish-table .nc-cell-title--no-cover { padding-left: 0; }

  /* Sort bar compact */
  .nc-sort-bar { padding: 0.35rem 0.5rem; }
  .nc-sort-bar button { font-size: 0.65rem; padding: 0.15rem 0.45rem; }
  .nc-sort-label { font-size: 0.65rem; }

  /* Dropdown adjust */
  .nc-recs-dropdown { padding-left: calc(28px + 0.5rem); }
}
</style>
