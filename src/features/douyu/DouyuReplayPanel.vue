<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, reactive } from "vue";
import { requestPluginOpen } from "../../shared/plugins";

const F_AUDIO = __FEATURE_AUDIO__;
const F_AUDIO_PLUGIN = __FEATURE_AUDIO_PLUGIN__;

/** 目标作者个人空间（斗鱼 video 站） */
const DOUYU_UP_ID = "01wNyQQWx7q2";
const DOUYU_AUTHOR_URL = `https://v.douyu.com/author-replay/${DOUYU_UP_ID}`;

interface WgVideoItem {
  hash_id: string;
  title: string;
  video_pic: string;
  view_num: string;
  author: string;
  video_str_duration: string;
  start_time: number;
}

interface WgShowGroup {
  time: string;
  date_format: string;
  time_format: string;
  video_list: WgVideoItem[];
}

interface AuthorListData {
  list: WgShowGroup[];
  count: number;
}

interface FlatVideo {
  hash_id: string;
  title: string;
  cover: string;
  view_num: string;
  duration_str: string;
  author: string;
  show_label: string;
  start_time: number;
  /** 浏览器新标签打开（完整站） */
  page_url: string;
}

const items = ref<FlatVideo[]>([]);
const loading = ref(false);
const error = ref("");
const playingHash = ref<string | null>(null);

const AUDIO_API = "/__fmz_audio";

async function fetchAuthorPage(page: number): Promise<AuthorListData> {
  const u = new URL("/__douyu_api/wgapi/vod/center/authorShowVideoList", window.location.origin);
  u.searchParams.set("up_id", DOUYU_UP_ID);
  u.searchParams.set("page", String(page));
  u.searchParams.set("limit", "20");
  const resp = await fetch(u.toString());
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.error !== 0) throw new Error(json.msg || "斗鱼接口返回错误");
  return json.data as AuthorListData;
}

function flatten(data: AuthorListData): FlatVideo[] {
  const out: FlatVideo[] = [];
  for (const g of data.list || []) {
    const show_label = [g.date_format, g.time].filter(Boolean).join(" · ");
    for (const v of g.video_list || []) {
      const pic = v.video_pic?.startsWith("//") ? "https:" + v.video_pic : v.video_pic;
      out.push({
        hash_id: v.hash_id,
        title: v.title,
        cover: pic,
        view_num: String(v.view_num ?? ""),
        duration_str: v.video_str_duration || "—",
        author: v.author || "",
        show_label,
        start_time: v.start_time || 0,
        page_url: `https://v.douyu.com/show/${v.hash_id}`,
      });
    }
  }
  return out;
}

async function loadAll() {
  closeDouyuPlayPopup();
  loading.value = true;
  error.value = "";
  playingHash.value = null;
  try {
    const first = await fetchAuthorPage(1);
    const totalShows = Math.max(0, Number(first.count) || 0);
    const pageSize = 20;
    const pages = Math.max(1, Math.ceil(totalShows / pageSize) || 1);
    const merged = flatten(first);
    for (let p = 2; p <= pages; p++) {
      const data = await fetchAuthorPage(p);
      merged.push(...flatten(data));
    }
    merged.sort((a, b) => b.start_time - a.start_time);
    items.value = merged;
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "加载失败";
    items.value = [];
  } finally {
    loading.value = false;
  }
}

function openVideo(url: string) {
  window.open(url, "_blank");
}

/** 与实际小窗播放、音频提取填入的 URL、yt-dlp 抓取保持一致（移动站点播页） */
function douyuPlaybackUrl(hash: string): string {
  return `https://vmobile.douyu.com/show/${encodeURIComponent(hash)}`;
}

/** 斗鱼点播禁止/破坏页内 iframe 的情况较多，改用独立弹出小窗，避免顶替当前站点标签页 */
let douyuPopup: Window | null = null;
let douyuPopupPoll: ReturnType<typeof setInterval> | null = null;

function stopDouyuPopupPoll() {
  if (douyuPopupPoll != null) {
    clearInterval(douyuPopupPoll);
    douyuPopupPoll = null;
  }
}

function closeDouyuPlayPopup() {
  stopDouyuPopupPoll();
  try {
    douyuPopup?.close();
  } catch {
    /* ignore cross-origin close errors */
  }
  douyuPopup = null;
}

/**
 * 以当前 opener 浏览器窗口与工作区相交区域为基准居中，缩放至整窗落在可用屏幕区域内（避免半截在屏幕外）。
 */
function computeDouyuPopupPlacement(prefW: number, prefH: number): { width: number; height: number; left: number; top: number } {
  const pad = 10;
  const sx =
    typeof window.screenX === "number"
      ? window.screenX
      : typeof (window as Window & { screenLeft?: number }).screenLeft === "number"
        ? (window as Window & { screenLeft: number }).screenLeft
        : 0;
  const sy =
    typeof window.screenY === "number"
      ? window.screenY
      : typeof (window as Window & { screenTop?: number }).screenTop === "number"
        ? (window as Window & { screenTop: number }).screenTop
        : 0;

  let outerW = typeof window.outerWidth === "number" ? window.outerWidth : window.innerWidth;
  let outerH = typeof window.outerHeight === "number" ? window.outerHeight : window.innerHeight;
  outerW = Math.max(outerW, window.innerWidth);
  outerH = Math.max(outerH, window.innerHeight);

  const aL = typeof screen.availLeft === "number" ? screen.availLeft : 0;
  const aT = typeof screen.availTop === "number" ? screen.availTop : 0;
  const aW = typeof screen.availWidth === "number" ? screen.availWidth : window.innerWidth;
  const aH = typeof screen.availHeight === "number" ? screen.availHeight : window.innerHeight;
  const aR = aL + aW;
  const aB = aT + aH;

  let boxLeft = Math.max(aL + pad / 2, sx + pad);
  let boxTop = Math.max(aT + pad / 2, sy + pad);
  let boxRight = Math.min(aR - pad / 2, sx + outerW - pad);
  let boxBottom = Math.min(aB - pad / 2, sy + outerH - pad);

  let boxW = boxRight - boxLeft;
  let boxH = boxBottom - boxTop;
  /* 移动端 / 全屏等：outer 与 avail 不交时改用整个工作区 */
  if (!Number.isFinite(boxW) || !Number.isFinite(boxH) || boxW < 200 || boxH < 140) {
    boxLeft = aL + pad;
    boxTop = aT + pad;
    boxW = aW - pad * 2;
    boxH = aH - pad * 2;
    boxRight = boxLeft + boxW;
    boxBottom = boxTop + boxH;
  }

  const innerMaxW = Math.max(220, boxW - pad * 2);
  const innerMaxH = Math.max(150, boxH - pad * 2);
  const scale = Math.min(1, innerMaxW / prefW, innerMaxH / prefH);
  let w = Math.round(prefW * scale);
  let h = Math.round(prefH * scale);

  let left = boxLeft + (boxW - w) / 2;
  let top = boxTop + (boxH - h) / 2;
  left = Math.min(Math.max(aL + pad, left), aR - w - pad);
  top = Math.min(Math.max(aT + pad, top), aB - h - pad);

  return { width: w, height: h, left: Math.round(left), top: Math.round(top) };
}

function openDouyuPlayPopup(hash: string): boolean {
  const url = douyuPlaybackUrl(hash);
  const pref = { width: 920, height: 540 };
  const { width: pw, height: ph, left, top } = computeDouyuPopupPlacement(pref.width, pref.height);
  const feats = [
    `popup=yes`,
    `width=${pw}`,
    `height=${ph}`,
    `left=${left}`,
    `top=${top}`,
    `resizable=yes`,
    `scrollbars=yes`,
    `menubar=no`,
    `toolbar=no`,
    `status=no`,
  ].join(",");

  const win = window.open(url, `douyu_v_${hash}`, feats);
  if (!win) return false;
  queueMicrotask(() => {
    try {
      win.moveTo?.(left, top);
      win.resizeTo?.(pw, ph);
    } catch {
      /* 部分浏览器限制 move/resize — 已通过 features 尽量对齐 */
    }
  });
  douyuPopup = win;
  stopDouyuPopupPoll();
  douyuPopupPoll = window.setInterval(() => {
    try {
      if (!douyuPopup || douyuPopup.closed) {
        stopDouyuPopupPoll();
        douyuPopup = null;
        playingHash.value = null;
      }
    } catch {
      stopDouyuPopupPoll();
      douyuPopup = null;
      playingHash.value = null;
    }
  }, 480);
  return true;
}

function togglePlay(hash: string) {
  if (playingHash.value === hash) {
    playingHash.value = null;
    closeDouyuPlayPopup();
    return;
  }
  closeDouyuPlayPopup();
  playingHash.value = hash;
  if (!openDouyuPlayPopup(hash)) {
    playingHash.value = null;
    window.alert(
      "无法打开播放小窗（浏览器拦截了弹出窗口）。请在地址栏将本站弹出窗口设为「允许」，或直接点击标题在原站标签页播放。",
    );
  }
}

function extractAudio(hash: string) {
  if (!F_AUDIO_PLUGIN) return;
  requestPluginOpen("audio", { url: douyuPlaybackUrl(hash) });
}

function formatCountDisplay(s: string): string {
  const n = parseInt(s.replace(/\D/g, ""), 10);
  if (!Number.isFinite(n)) return s;
  if (n >= 10000) return (n / 10000).toFixed(1) + "万";
  return String(n);
}

/* ----- 音频状态（与「拾观宝片」页一致，按 hash_id 作为目录名） ----- */

interface AudioStatus {
  extracted: boolean;
  hasMusic: boolean;
  sourceFile: string | null;
  musicFiles: { name: string; size: number }[];
}

const audioStatuses = reactive<Record<string, AudioStatus>>({});
const expandedAudio = ref<string | null>(null);
const audioStatusLoading = reactive<Record<string, boolean>>({});

async function fetchAudioStatus(videoId: string) {
  try {
    const resp = await fetch(`${AUDIO_API}/status/${encodeURIComponent(videoId)}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.ok) {
        audioStatuses[videoId] = {
          extracted: data.extracted,
          hasMusic: data.hasMusic,
          sourceFile: data.sourceFile || null,
          musicFiles: data.musicFiles || [],
        };
        return;
      }
    }
    audioStatuses[videoId] = {
      extracted: false,
      hasMusic: false,
      sourceFile: null,
      musicFiles: [],
    };
  } catch {
    audioStatuses[videoId] = {
      extracted: false,
      hasMusic: false,
      sourceFile: null,
      musicFiles: [],
    };
  }
}

async function toggleAudioDropdown(videoId: string) {
  if (expandedAudio.value === videoId) {
    expandedAudio.value = null;
    return;
  }
  expandedAudio.value = videoId;
  audioStatusLoading[videoId] = true;
  try {
    await fetchAudioStatus(videoId);
  } finally {
    audioStatusLoading[videoId] = false;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

function playAudioFile(videoId: string, relPath: string) {
  const tail = relPath.split("/").map((s) => encodeURIComponent(s)).join("/");
  const url = `${AUDIO_API}/download/${encodeURIComponent(videoId)}/${tail}`;
  window.open(url, "_blank");
}

const hasItems = computed(() => items.value.length > 0);

onMounted(() => {
  void loadAll();
});

onUnmounted(() => {
  closeDouyuPlayPopup();
});

defineExpose({ reload: loadAll });
</script>

<template>
  <section class="douyu-panel">
    <div class="dy-toolbar">
      <a class="dy-author-link" :href="DOUYU_AUTHOR_URL" target="_blank" rel="noopener">斗鱼个人空间</a>
      <span class="dy-hint"
        >拉取作者 {{ DOUYU_UP_ID }} 全部回放 · 封面播放为<strong>居中弹出小窗</strong>（斗鱼限制页内 iframe）</span
      >
      <button type="button" class="dy-refresh" :disabled="loading" title="重新加载列表" @click="loadAll">
        {{ loading ? "…" : "↻ 刷新" }}
      </button>
    </div>

    <div v-if="loading && !hasItems" class="dy-msg">加载斗鱼回放列表中…</div>
    <div v-if="error" class="dy-msg dy-err">⚠️ {{ error }}</div>
    <div v-if="!loading && !error && !hasItems" class="dy-msg">暂无回放数据</div>

    <div v-if="hasItems" class="dy-results">
      <article v-for="v in items" :key="v.hash_id" class="dy-row">
        <div class="dy-thumb-wrap" @click="togglePlay(v.hash_id)">
          <img
            :src="v.cover"
            :alt="v.title"
            class="dy-thumb"
            :class="{ 'is-popup-open': playingHash === v.hash_id }"
            loading="lazy"
            referrerpolicy="no-referrer"
          />
          <div v-if="playingHash === v.hash_id" class="dy-popup-hint">
            <span class="dy-popup-line">小窗播放中</span>
            <span class="dy-popup-sub">再点此区域关闭</span>
          </div>
          <span v-if="playingHash !== v.hash_id" class="dy-play-ico">▶</span>
          <span v-if="playingHash !== v.hash_id" class="dy-dur">{{ v.duration_str }}</span>
          <button
            v-if="F_AUDIO && F_AUDIO_PLUGIN"
            type="button"
            class="dy-extract-btn"
            :class="{ shown: playingHash === v.hash_id }"
            title="提取音频：填入与本页小窗相同的 vmobile 回放地址（与 yt-dlp 一致）"
            @click.stop="extractAudio(v.hash_id)"
          >
            🎵
          </button>
        </div>
        <div class="dy-body">
          <h3 class="dy-title" :title="v.title" @click="openVideo(v.page_url)">{{ v.title }}</h3>
          <p class="dy-sub">{{ v.show_label }}</p>

          <div v-if="F_AUDIO" class="dy-audio-row">
            <span v-if="audioStatuses[v.hash_id]?.extracted" class="dy-badge ok">🎵 已提取</span>
            <span v-if="audioStatuses[v.hash_id]?.hasMusic" class="dy-badge music">
              🎶 {{ audioStatuses[v.hash_id].musicFiles.length }} 首
            </span>
            <button
              type="button"
              class="dy-audio-tgl"
              :class="{ open: expandedAudio === v.hash_id }"
              title="本机音频状态（点击查询）"
              @click.stop="toggleAudioDropdown(v.hash_id)"
            >
              {{ audioStatusLoading[v.hash_id] ? "⏳" : "🎵" }} ▾
            </button>
          </div>
          <div v-if="F_AUDIO && expandedAudio === v.hash_id" class="dy-audio-drop">
            <div v-if="audioStatusLoading[v.hash_id]" class="dy-audio-empty">查询中…</div>
            <template v-else-if="!audioStatuses[v.hash_id]?.extracted">
              <div class="dy-audio-empty">尚未提取该回放音频</div>
            </template>
            <template v-else>
              <div v-if="audioStatuses[v.hash_id]?.sourceFile" class="dy-audio-line">
                <span class="ico">📄</span>
                <span class="name">{{ audioStatuses[v.hash_id].sourceFile }}</span>
                <button
                  type="button"
                  class="dy-mini-play"
                  @click.stop="playAudioFile(v.hash_id, audioStatuses[v.hash_id].sourceFile!)"
                >
                  ▶
                </button>
              </div>
              <template v-if="audioStatuses[v.hash_id]?.musicFiles?.length">
                <div class="dy-audio-div">🎶 歌曲</div>
                <div
                  v-for="mf in audioStatuses[v.hash_id].musicFiles"
                  :key="mf.name"
                  class="dy-audio-line"
                >
                  <span class="ico">🎵</span>
                  <span class="name">{{ mf.name }}</span>
                  <span class="sz">{{ formatFileSize(mf.size) }}</span>
                  <button
                    type="button"
                    class="dy-mini-play"
                    @click.stop="playAudioFile(v.hash_id, 'music/' + mf.name)"
                  >
                    ▶
                  </button>
                </div>
              </template>
              <div v-else class="dy-audio-empty">暂无分轨</div>
            </template>
          </div>

          <div class="dy-meta">
            <span class="up">{{ v.author }}</span>
            <span class="sep">·</span>
            <span class="stat">▶ {{ formatCountDisplay(v.view_num) }}</span>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.douyu-panel {
  padding: 1rem 1.25rem;
  max-width: 1200px;
  margin: 0 auto;
}
.dy-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.65rem 1rem;
  margin-bottom: 1rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--border);
}
.dy-author-link {
  font-weight: 600;
  color: var(--primary);
  text-decoration: none;
}
.dy-author-link:hover {
  text-decoration: underline;
}
.dy-hint {
  font-size: 0.82rem;
  color: var(--muted);
  flex: 1;
  min-width: 200px;
}
.dy-refresh {
  padding: 0.35rem 0.75rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  font-size: 0.85rem;
}
.dy-refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dy-msg {
  text-align: center;
  color: var(--muted);
  padding: 2rem 1rem;
}
.dy-err {
  color: var(--danger);
}
.dy-results {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.dy-row {
  display: flex;
  gap: 1rem;
  align-items: flex-start;
  padding: 1rem 1.1rem;
  border-bottom: 1px solid var(--border);
}
.dy-row:last-child {
  border-bottom: none;
}
.dy-thumb-wrap {
  position: relative;
  flex-shrink: 0;
  width: 206px;
  max-width: 38vw;
  aspect-ratio: 16 / 10;
  background: #111;
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
}
.dy-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 0.25s, filter 0.2s;
}
.dy-thumb.is-popup-open {
  filter: brightness(0.55);
  transform: none;
}
.dy-thumb-wrap:hover .dy-thumb:not(.is-popup-open) {
  transform: scale(1.04);
}
.dy-popup-hint {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.2rem;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  text-align: center;
  padding: 0.4rem;
  pointer-events: none;
}
.dy-popup-line {
  font-weight: 700;
  font-size: 0.84rem;
}
.dy-popup-sub {
  font-size: 0.7rem;
  opacity: 0.92;
}
.dy-play-ico {
  position: absolute;
  inset: 0;
  margin: auto;
  width: fit-content;
  height: fit-content;
  font-size: 2rem;
  color: rgba(255, 255, 255, 0.92);
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.55);
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.18s;
}
.dy-thumb-wrap:hover .dy-play-ico {
  opacity: 1;
}
.dy-dur {
  position: absolute;
  bottom: 6px;
  right: 6px;
  padding: 1px 5px;
  font-size: 0.72rem;
  border-radius: 3px;
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  pointer-events: none;
}
.dy-extract-btn {
  position: absolute;
  bottom: 6px;
  left: 6px;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 6px;
  appearance: none;
  -webkit-appearance: none;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  cursor: pointer;
  font-size: 0.85rem;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.18s;
  z-index: 2;
}
.dy-thumb-wrap:hover .dy-extract-btn,
.dy-extract-btn.shown {
  opacity: 1;
}
.dy-extract-btn:hover {
  filter: brightness(1.2);
}
.dy-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.dy-title {
  margin: 0;
  font-size: 1.02rem;
  font-weight: 500;
  line-height: 1.45;
  color: var(--text);
  cursor: pointer;
}
.dy-title:hover {
  color: var(--primary);
}
.dy-sub {
  margin: 0;
  font-size: 0.82rem;
  color: var(--muted);
}
.dy-meta {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.35rem;
  font-size: 0.78rem;
  color: var(--muted);
}
.sep {
  opacity: 0.45;
}
.dy-audio-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
  margin-top: 0.25rem;
}
.dy-badge {
  font-size: 0.68rem;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-weight: 500;
}
.dy-badge.ok {
  background: rgba(76, 175, 80, 0.15);
  color: #4caf50;
  border: 1px solid rgba(76, 175, 80, 0.3);
}
.dy-badge.music {
  background: rgba(100, 181, 246, 0.15);
  color: #64b5f6;
  border: 1px solid rgba(100, 181, 246, 0.3);
}
.dy-audio-tgl {
  width: auto;
  min-width: 52px;
  height: 26px;
  padding: 0 0.4rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  appearance: none;
  -webkit-appearance: none;
  background: var(--surface);
  color: var(--text);
  font-size: 0.7rem;
  cursor: pointer;
  line-height: 1;
}
.dy-audio-tgl.open {
  color: var(--primary);
  border-color: var(--primary);
}
.dy-audio-tgl:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.dy-audio-drop {
  margin-top: 0.3rem;
  padding: 0.35rem;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  max-height: 168px;
  overflow-y: auto;
}
.dy-audio-empty {
  font-size: 0.72rem;
  color: var(--muted);
  text-align: center;
  padding: 0.3rem;
}
.dy-audio-div {
  font-size: 0.68rem;
  color: var(--muted);
  font-weight: 600;
  padding: 0.25rem 0.2rem 0;
  border-top: 1px solid var(--border);
  margin-top: 0.2rem;
}
.dy-audio-line {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem;
  border-radius: 4px;
  font-size: 0.72rem;
}
.dy-audio-line:hover {
  background: var(--surface);
}
.dy-audio-line .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}
.dy-audio-line .sz {
  color: var(--muted);
  font-size: 0.68rem;
}
.dy-mini-play {
  width: 26px;
  height: 26px;
  padding: 0;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  appearance: none;
  -webkit-appearance: none;
  background: var(--surface);
  color: var(--text);
  font-size: 0.65rem;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dy-mini-play:hover {
  color: var(--primary);
  border-color: var(--primary);
}
@media (max-width: 600px) {
  .douyu-panel {
    padding: 0.75rem 0.65rem;
  }
  .dy-row {
    flex-direction: row;
    flex-wrap: nowrap;
    align-items: flex-start;
    padding: 0.65rem 0.45rem;
    gap: 0.55rem;
  }
  .dy-thumb-wrap {
    width: clamp(124px, 36vw, 168px);
    max-width: 42vw;
    flex-shrink: 0;
  }
  .dy-body {
    --fmz-video-text-zoom: clamp(0.68, calc((100vw - 138px) / 278), 1);
    zoom: var(--fmz-video-text-zoom);
    align-self: flex-start;
  }
  @supports not (zoom: 1) {
    .dy-body {
      zoom: revert;
      width: calc(100% / var(--fmz-video-text-zoom));
      transform: scale(var(--fmz-video-text-zoom));
      transform-origin: left top;
    }
  }
  .dy-extract-btn {
    opacity: 1;
  }
}
</style>
