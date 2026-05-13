<script setup lang="ts">
import { ref, computed, onMounted } from "vue";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface Track {
  id: number;
  name: string;
  artist: string;
  album: string;
  albumCover: string;
  duration: number; // ms
}

interface PlaylistInfo {
  id: number;
  name: string;
  description: string;
  coverUrl: string;
  trackCount: number;
  playCount: number;
  tracks: Track[];
  fetchedAt: string;
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
const DEFAULT_PLAYLIST_ID = "575852081";

const loading = ref(false);
const error = ref("");
const playlist = ref<PlaylistInfo | null>(null);
const votes = ref<Record<string, VoteEntry>>({});
const wishlist = ref<Record<string, WishlistEntry>>({});
// Local set of song IDs this client has recommended (persisted in localStorage)
const localRecommended = ref<Set<string>>(new Set(
  JSON.parse(localStorage.getItem("crimes_recommended") || "[]"),
));
const searchQuery = ref("");
const playlistIdInput = ref("");
const currentVoter = ref(localStorage.getItem("crimes_voter") || "");
const voterDialogOpen = ref(false);
const voterInput = ref("");
const descExpanded = ref(false);

// Sub-tab: "playlist" | "wishlist"
const subTab = ref<"playlist" | "wishlist">("playlist");

// Currently playing song
const playingUrl = ref<string | null>(null);
const playingId = ref<number | null>(null);
const audioEl = ref<HTMLAudioElement | null>(null);
const isAudioPaused = ref(true);

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
      const la = votes.value[String(a.id)]?.likes || 0;
      const lb = votes.value[String(b.id)]?.likes || 0;
      return lb - la;
    });
  } else if (playlistSort.value === "recommend") {
    tracks = [...tracks].sort((a, b) => {
      const ra = wishlist.value[String(a.id)]?.count || 0;
      const rb = wishlist.value[String(b.id)]?.count || 0;
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

/** Format play count like Netease: 12345 → 1.2万 */
function formatPlayCount(n: number): string {
  if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + "亿";
  if (n >= 10_000) return (n / 10_000).toFixed(1) + "万";
  return String(n);
}

/* ------------------------------------------------------------------ */
/*  API calls                                                         */
/* ------------------------------------------------------------------ */

async function loadPlaylist(id?: string) {
  const pid = id || playlistIdInput.value.trim() || DEFAULT_PLAYLIST_ID;
  if (!pid) {
    error.value = "请输入歌单 ID";
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    const resp = await fetch(`${API_BASE}/playlist/${pid}`);
    if (!resp.ok) throw new Error(`加载失败 (${resp.status})`);
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "加载失败");
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

async function vote(songId: number, action: "like" | "dislike" | "cancel") {
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
      votes.value = { ...votes.value, [String(songId)]: data.song };
    }
  } catch { /* ignore */ }
}

async function addToWishlist(track: Track) {
  if (!currentVoter.value) {
    voterDialogOpen.value = true;
    return;
  }
  try {
    const resp = await fetch(`${API_BASE}/wishlist/recommend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        songId: track.id,
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
      localRecommended.value = new Set([...localRecommended.value, String(track.id)]);
      localStorage.setItem("crimes_recommended", JSON.stringify([...localRecommended.value]));
    }
  } catch { /* ignore */ }
}

function isLocalRecommended(songId: number): boolean {
  return localRecommended.value.has(String(songId));
}

/* ------------------------------------------------------------------ */
/*  Playback                                                          */
/* ------------------------------------------------------------------ */

async function playSong(track: Track) {
  if (playingId.value === track.id) {
    if (audioEl.value) {
      if (audioEl.value.paused) audioEl.value.play();
      else audioEl.value.pause();
    }
    return;
  }

  // Use backend audio proxy to bypass CORS
  const proxyUrl = `${API_BASE}/audio-proxy/${track.id}`;
  playingUrl.value = proxyUrl;
  playingId.value = track.id;
  isAudioPaused.value = false;
  error.value = "";

  // Wait for next tick so <audio> src updates, then play
  setTimeout(() => {
    if (audioEl.value) {
      audioEl.value.load();
      audioEl.value.play().catch(() => {
        error.value = "播放失败（可能需要 VIP 或歌曲不可用）";
        stopPlaying();
      });
    }
  }, 50);
}

function stopPlaying() {
  audioEl.value?.pause();
  playingUrl.value = null;
  playingId.value = null;
  isAudioPaused.value = true;
}

function onAudioPause() { isAudioPaused.value = true; }
function onAudioPlay() { isAudioPaused.value = false; }

/** Play all from the first track */
function playAll() {
  const tracks = filteredTracks.value;
  if (tracks.length > 0) playSong(tracks[0]);
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

function getVote(songId: number): VoteEntry | null {
  return votes.value[String(songId)] || null;
}

function myVote(songId: number): "like" | "dislike" | null {
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
  const savedId = localStorage.getItem("crimes_playlist_id") || DEFAULT_PLAYLIST_ID;
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
        <img :src="playlist.coverUrl + '?param=200y200'" alt="cover" />
        <span class="nc-cover-badge">歌单</span>
      </div>
      <div class="nc-banner-info">
        <h1 class="nc-banner-title">{{ playlist.name }}</h1>
        <div class="nc-banner-meta">
          <span class="nc-meta-count">🎵 {{ playlist.trackCount }} 首</span>
          <span class="nc-meta-play">▶ {{ formatPlayCount(playlist.playCount) }}次播放</span>
          <a
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
          <button class="nc-btn nc-btn--play" @click="playAll">
            <span class="nc-btn-ico">▶</span> 播放全部
          </button>
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
      <p>输入网易云歌单 ID，开始探索</p>
      <div class="nc-id-bar">
        <input
          v-model="playlistIdInput"
          type="text"
          :placeholder="`歌单 ID（默认 ${DEFAULT_PLAYLIST_ID}）`"
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
          <input
            v-model="playlistIdInput"
            type="text"
            placeholder="歌单 ID"
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
        <span class="nc-th nc-th-title">音乐标题</span>
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
        :class="{
          'nc-row--even': idx % 2 === 0,
          'nc-row--playing': playingId === track.id,
        }"
      >
        <!-- Index / playing indicator -->
        <span class="nc-cell nc-cell-idx">
          <template v-if="playingId === track.id">
            <span class="nc-playing-ico" :class="{ paused: isAudioPaused }">♫</span>
          </template>
          <template v-else>{{ padIndex(idx + 1) }}</template>
        </span>

        <!-- Title + cover -->
        <span class="nc-cell nc-cell-title" @click="playSong(track)">
          <img :src="track.albumCover + '?param=34y34'" class="nc-row-cover" alt="" />
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
            :class="{ liked: myVote(track.id) === 'like' }"
            @click.stop="vote(track.id, myVote(track.id) === 'like' ? 'cancel' : 'like')"
            title="点赞"
          >
            <svg class="nc-ico" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg><sup>{{ getVote(track.id)?.likes || 0 }}</sup>
          </button>
          <button
            class="nc-act-btn nc-act-btn--fixed"
            :class="{ wished: isLocalRecommended(track.id) }"
            @click.stop="addToWishlist(track)"
            :disabled="isLocalRecommended(track.id)"
            title="推荐到愿望单"
          >
            <svg class="nc-ico" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg><sup>{{ wishlist[String(track.id)]?.count || 0 }}</sup>
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
      <div v-else class="nc-table-wrap">
        <!-- Sort bar -->
        <div class="nc-sort-bar">
          <span class="nc-sort-label">排序：</span>
          <button :class="{ on: wishlistSort === 'recommend' }" @click="wishlistSort = 'recommend'">推荐</button>
          <button :class="{ on: wishlistSort === 'likes' }" @click="wishlistSort = 'likes'">点赞</button>
          <button :class="{ on: wishlistSort === 'alpha' }" @click="wishlistSort = 'alpha'">字母</button>
        </div>
        <!-- Table header (same layout as playlist) -->
        <div class="nc-table-header">
          <span class="nc-th nc-th-idx"></span>
          <span class="nc-th nc-th-title">音乐标题</span>
          <span class="nc-th nc-th-artist">歌手</span>
          <span class="nc-th nc-th-album">推荐人</span>
          <span class="nc-th nc-th-actions">操作</span>
          <span class="nc-th nc-th-dur">推荐数</span>
        </div>
        <div
          v-for="(item, idx) in wishlistEntries"
          :key="item.songId"
          class="nc-row"
          :class="{ 'nc-row--even': idx % 2 === 0 }"
        >
          <span class="nc-cell nc-cell-idx">{{ padIndex(idx + 1) }}</span>
          <span class="nc-cell nc-cell-title">
            <span class="nc-song-name">{{ item.songName }}</span>
          </span>
          <span class="nc-cell nc-cell-artist">{{ item.artist }}</span>
          <span class="nc-cell nc-cell-album nc-recommenders">
            <span
              v-for="(r, ri) in item.recommenders.slice(-5).reverse()"
              :key="ri"
              class="nc-recommender-tag"
              :title="r.at"
            >{{ r.name }}</span>
            <span v-if="item.recommenders.length > 5" class="nc-recommender-more">
              +{{ item.recommenders.length - 5 }}
            </span>
          </span>
          <span class="nc-cell nc-cell-actions">
            <button
              class="nc-act-btn nc-act-btn--fixed"
              :class="{ liked: myVote(Number(item.songId)) === 'like' }"
              @click.stop="vote(Number(item.songId), myVote(Number(item.songId)) === 'like' ? 'cancel' : 'like')"
              title="点赞"
            >
              <svg class="nc-ico" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg><sup>{{ getVote(Number(item.songId))?.likes || 0 }}</sup>
            </button>
          </span>
          <span class="nc-cell nc-cell-dur nc-recommend-count">{{ item.count }}</span>
        </div>
      </div>
    </div>

    <!-- Hidden audio -->
    <audio
      v-if="playingUrl"
      ref="audioEl"
      :src="playingUrl"
      @ended="stopPlaying"
      @error="stopPlaying"
      @pause="onAudioPause"
      @play="onAudioPlay"
    />

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
/*  Netease-inspired dark theme                                       */
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
  background: linear-gradient(135deg, #1a1f2e 0%, #141822 100%);
  border: 1px solid rgba(255,255,255,0.06);
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
  background: #ec4141;
  color: #fff;
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
  color: #fff;
}

.nc-banner-meta {
  display: flex;
  gap: 1rem;
  font-size: 0.8rem;
  color: #999;
  margin-bottom: 0.5rem;
  flex-wrap: wrap;
}

.nc-meta-link {
  color: #5eb0e8;
  text-decoration: none;
}
.nc-meta-link:hover { text-decoration: underline; }

.nc-banner-desc {
  font-size: 0.8rem;
  color: #888;
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
  color: #5eb0e8;
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
  background: #ec4141;
  color: #fff;
}
.nc-btn--play:hover { background: #d63636; }
.nc-btn--play:disabled { opacity: 0.5; cursor: not-allowed; }

.nc-btn-ico {
  font-size: 0.7rem;
}

.nc-btn--wish {
  background: rgba(255,255,255,0.08);
  color: #ccc;
  border: 1px solid rgba(255,255,255,0.12);
}
.nc-btn--wish:hover { background: rgba(255,255,255,0.14); }

.nc-btn--ghost {
  background: transparent;
  color: #999;
  border: 1px solid #444;
}
.nc-btn--ghost:hover { border-color: #888; color: #ccc; }

.nc-badge {
  font-size: 0.7rem;
  background: #ec4141;
  color: #fff;
  padding: 1px 6px;
  border-radius: 10px;
  margin-left: 2px;
}

.nc-voter-chip {
  padding: 0.4rem 0.8rem;
  border-radius: 20px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  color: #aaa;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s;
}
.nc-voter-chip:hover { background: rgba(255,255,255,0.12); color: #fff; }

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
  color: #fff;
  font-size: 1.4rem;
}

.nc-empty-state p {
  color: #888;
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
  border: 1px solid #333;
  border-radius: 20px;
  background: #1a1f26;
  color: #e8eef7;
  font-size: 0.9rem;
}
.nc-id-input:focus { outline: none; border-color: #ec4141; }

/* ---- Loading / Error ---- */
.nc-loading {
  text-align: center;
  padding: 3rem;
  color: #888;
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
  background: rgba(231,76,60,0.08);
  border: 1px solid rgba(231,76,60,0.2);
  border-radius: 6px;
  color: #e74c3c;
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
  border-bottom: 1px solid rgba(255,255,255,0.06);
  margin-bottom: 0;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.nc-sub-tabs {
  display: flex;
  gap: 0;
}

.nc-sub-tabs button {
  padding: 0.45rem 1rem;
  border: none;
  background: transparent;
  color: #888;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 600;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
}

.nc-sub-tabs button.on {
  color: #ec4141;
  border-bottom-color: #ec4141;
}

.nc-tab-count {
  font-size: 0.7rem;
  color: #888;
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
  border: 1px solid #333;
  border-radius: 16px;
  background: rgba(255,255,255,0.04);
  color: #ccc;
  font-size: 0.8rem;
  width: 160px;
  transition: width 0.2s;
}
.nc-search-input:focus { outline: none; border-color: #555; width: 200px; }

.nc-switch-playlist {
  display: flex;
  gap: 0;
}

.nc-switch-input {
  padding: 0.35rem 0.6rem;
  border: 1px solid #333;
  border-radius: 16px 0 0 16px;
  background: rgba(255,255,255,0.04);
  color: #ccc;
  font-size: 0.8rem;
  width: 90px;
}
.nc-switch-input:focus { outline: none; border-color: #555; }

.nc-switch-btn {
  padding: 0.35rem 0.6rem;
  border: 1px solid #333;
  border-left: none;
  border-radius: 0 16px 16px 0;
  background: rgba(255,255,255,0.06);
  color: #aaa;
  cursor: pointer;
  font-size: 0.85rem;
}
.nc-switch-btn:hover { background: rgba(255,255,255,0.12); color: #fff; }

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
  color: #666;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  user-select: none;
}

.nc-th-idx   { width: 40px; text-align: center; flex-shrink: 0; }
.nc-th-title { flex: 2; min-width: 0; padding-left: calc(34px + 0.6rem); }
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
  background: rgba(255,255,255,0.015);
}

.nc-row:hover {
  background: rgba(255,255,255,0.05);
}

.nc-row--playing {
  background: rgba(236,65,65,0.08) !important;
}

.nc-row--playing .nc-song-name {
  color: #ec4141;
}

/* Cells */
.nc-cell-idx {
  width: 40px;
  text-align: center;
  flex-shrink: 0;
  font-size: 0.8rem;
  color: #555;
}

.nc-playing-ico {
  color: #ec4141;
  font-size: 0.9rem;
  animation: nc-pulse 1s ease-in-out infinite;
}
.nc-playing-ico.paused { animation: none; opacity: 0.5; }

@keyframes nc-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.nc-cell-title {
  flex: 2;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  cursor: pointer;
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
  color: #e0e0e0;
  transition: color 0.15s;
}

.nc-cell-title:hover .nc-song-name {
  color: #fff;
}

.nc-cell-artist {
  flex: 1;
  min-width: 0;
  font-size: 0.8rem;
  color: #777;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nc-cell-album {
  flex: 1;
  min-width: 0;
  font-size: 0.8rem;
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  color: #666;
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

.nc-act-btn:hover { background: rgba(255,255,255,0.08); color: #ccc; }

.nc-act-btn sup {
  font-size: 0.6rem;
  position: relative;
  top: -0.4em;
  margin-left: 1px;
}

.nc-act-btn.liked { color: #ec4141; }
.nc-act-btn.liked .nc-ico { fill: #ec4141; }
.nc-act-btn.disliked { color: #e74c3c; }
.nc-act-btn.wished { color: #faad14; }
.nc-act-btn.wished .nc-ico { fill: #faad14; }
.nc-act-btn:disabled { cursor: default; }

.nc-act-btn--rm {
  font-size: 0.75rem;
  color: #e74c3c;
  border: 1px solid rgba(231,76,60,0.2);
  border-radius: 10px;
  padding: 0.15rem 0.5rem;
}
.nc-act-btn--rm:hover { background: rgba(231,76,60,0.12); }

.nc-cell-dur {
  width: 56px;
  text-align: right;
  flex-shrink: 0;
  font-size: 0.8rem;
  color: #555;
  font-variant-numeric: tabular-nums;
}

/* ---- Sort bar ---- */
.nc-sort-bar {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}

.nc-sort-label {
  font-size: 0.75rem;
  color: #666;
  margin-right: 0.25rem;
}

.nc-sort-bar button {
  padding: 0.2rem 0.6rem;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px;
  background: transparent;
  color: #888;
  font-size: 0.72rem;
  cursor: pointer;
  transition: all 0.12s;
}

.nc-sort-bar button:hover {
  background: rgba(255,255,255,0.06);
  color: #ccc;
}

.nc-sort-bar button.on {
  background: rgba(236,65,65,0.12);
  border-color: rgba(236,65,65,0.3);
  color: #ec4141;
  font-weight: 600;
}

/* ---- Wishlist empty ---- */
.nc-wish-empty {
  text-align: center;
  padding: 3rem;
  color: #666;
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
  background: #1a1f26;
  border: 1px solid #333;
  border-radius: 12px;
  padding: 1.5rem;
  width: 320px;
  max-width: 90vw;
}

.nc-dialog h3 {
  margin: 0 0 0.5rem;
  color: #fff;
}

.nc-dialog p {
  margin: 0 0 1rem;
  font-size: 0.85rem;
  color: #888;
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

/* ---- Wishlist recommenders ---- */
.nc-recommend-count {
  color: #ec4141;
  font-weight: 700;
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
}

.nc-cell-album.nc-recommenders {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: center;
  justify-content: flex-start;
  overflow: visible;
  white-space: normal;
}

.nc-recommenders {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: center;
  justify-content: flex-start;
}

.nc-recommender-tag {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  border-radius: 10px;
  background: rgba(94, 176, 232, 0.12);
  color: #5eb0e8;
  font-size: 0.7rem;
  white-space: nowrap;
}

.nc-recommender-more {
  font-size: 0.7rem;
  color: #666;
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
  .nc-th-album, .nc-cell-album { display: none; }
  .nc-th-actions, .nc-cell-actions { width: 90px; }
  .nc-search-input { width: 120px; }
}
</style>
