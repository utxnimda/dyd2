<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { pluginPayloads } from "../../shared/plugins";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface Segment {
  start: number;
  end: number;
  duration: number;
  label: string;
  file?: string; // populated after split
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

// Step 1: Input
const videoUrl = ref("");
const videoId = ref("");

// Step 2: Extract
const extracting = ref(false);
const extractDone = ref(false);
const extractError = ref("");
const audioDuration = ref(0);
const audioFile = ref("");

// Step 3: Detect segments
const detecting = ref(false);
const detectDone = ref(false);
const detectError = ref("");
const segments = ref<Segment[]>([]);
const totalDuration = ref(0);

// Detection params
const silenceThresh = ref(-35);
const silenceDuration = ref(3);
const minSegment = ref(15);

// Step 4: Split
const splitting = ref(false);
const splitDone = ref(false);
const splitError = ref("");

// Playback
const playingUrl = ref<string | null>(null);
const playingLabel = ref("");

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const API_BASE = "/__fmz_audio";

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDurationLong(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}小时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

/** Extract bvid from various Bilibili URL formats */
function parseBvid(url: string): string | null {
  const m = url.match(/BV[\w]+/i);
  return m ? m[0] : null;
}

const canExtract = computed(() => {
  const url = videoUrl.value.trim();
  return url.length > 0 && (url.includes("bilibili.com") || url.includes("b23.tv") || url.startsWith("BV"));
});

const isReady = computed(() => depsStatus.value?.ok === true);

/* ------------------------------------------------------------------ */
/*  API calls                                                         */
/* ------------------------------------------------------------------ */

async function checkDeps() {
  depsLoading.value = true;
  try {
    const resp = await fetch(`${API_BASE}/check`);
    depsStatus.value = await resp.json();
  } catch (e: any) {
    depsStatus.value = {
      ok: false,
      ytdlp: false,
      ffmpeg: false,
      message: "无法连接到音频提取服务，请确保已启动 audio-extractor-server",
    };
  } finally {
    depsLoading.value = false;
  }
}

async function doExtract() {
  let url = videoUrl.value.trim();
  if (!url) return;

  // If user just pasted a bvid, wrap it
  if (url.startsWith("BV") && !url.includes("http")) {
    url = `https://www.bilibili.com/video/${url}`;
  }

  const bvid = parseBvid(url);
  const vid = bvid || Date.now().toString(36);

  extracting.value = true;
  extractError.value = "";
  extractDone.value = false;
  detectDone.value = false;
  splitDone.value = false;
  segments.value = [];

  try {
    const resp = await fetch(`${API_BASE}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, videoId: vid }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "提取失败");

    videoId.value = data.videoId;
    audioFile.value = data.audioFile;
    audioDuration.value = data.duration || 0;
    extractDone.value = true;
  } catch (e: any) {
    extractError.value = e.message || "提取失败";
  } finally {
    extracting.value = false;
  }
}

async function doDetect() {
  if (!videoId.value) return;

  detecting.value = true;
  detectError.value = "";
  detectDone.value = false;
  splitDone.value = false;

  try {
    const resp = await fetch(`${API_BASE}/detect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: videoId.value,
        silenceThresh: silenceThresh.value,
        silenceDuration: silenceDuration.value,
        minSegment: minSegment.value,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "检测失败");

    totalDuration.value = data.totalDuration || 0;
    segments.value = (data.segments || []).map((s: any, i: number) => ({
      ...s,
      label: `片段 ${i + 1}`,
    }));
    detectDone.value = true;
  } catch (e: any) {
    detectError.value = e.message || "检测失败";
  } finally {
    detecting.value = false;
  }
}

async function doSplit() {
  if (!videoId.value || segments.value.length === 0) return;

  splitting.value = true;
  splitError.value = "";
  splitDone.value = false;

  try {
    const resp = await fetch(`${API_BASE}/split`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: videoId.value,
        segments: segments.value.map((s) => ({
          start: s.start,
          end: s.end,
          label: s.label,
        })),
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || "分割失败");

    // Update segments with file info
    for (const result of data.segments) {
      const seg = segments.value.find(
        (s) => Math.abs(s.start - result.start) < 0.5 && Math.abs(s.end - result.end) < 0.5,
      );
      if (seg) seg.file = result.file;
    }
    splitDone.value = true;
  } catch (e: any) {
    splitError.value = e.message || "分割失败";
  } finally {
    splitting.value = false;
  }
}

function playSegment(seg: Segment) {
  if (!seg.file) return;
  const url = `${API_BASE}/download/${videoId.value}/${encodeURIComponent(seg.file)}`;
  if (playingUrl.value === url) {
    playingUrl.value = null;
    playingLabel.value = "";
  } else {
    playingUrl.value = url;
    playingLabel.value = seg.label;
  }
}

function playSource() {
  if (!videoId.value || !audioFile.value) return;
  const url = `${API_BASE}/download/${videoId.value}/${encodeURIComponent(audioFile.value)}`;
  if (playingUrl.value === url) {
    playingUrl.value = null;
    playingLabel.value = "";
  } else {
    playingUrl.value = url;
    playingLabel.value = "完整音频";
  }
}

function downloadSegment(seg: Segment) {
  if (!seg.file) return;
  const url = `${API_BASE}/download/${videoId.value}/${encodeURIComponent(seg.file)}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = seg.file;
  a.click();
}

function removeSegment(index: number) {
  segments.value.splice(index, 1);
}

function updateSegmentLabel(index: number, label: string) {
  segments.value[index].label = label;
}

function resetAll() {
  videoUrl.value = "";
  videoId.value = "";
  extractDone.value = false;
  extractError.value = "";
  detectDone.value = false;
  detectError.value = "";
  splitDone.value = false;
  splitError.value = "";
  segments.value = [];
  playingUrl.value = null;
  playingLabel.value = "";
  audioDuration.value = 0;
  audioFile.value = "";
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                         */
/* ------------------------------------------------------------------ */

onMounted(() => {
  checkDeps();
});

/** Watch for external trigger (e.g. from BilibiliSearchPanel's audio extract button) */
watch(
  () => pluginPayloads.value["audio"],
  (payload) => {
    if (!payload?.url) return;
    const url = String(payload.url);
    // Clear the payload so it doesn't re-trigger
    pluginPayloads.value = { ...pluginPayloads.value, audio: undefined };
    // Reset state and fill in the URL
    resetAll();
    videoUrl.value = url;
    // Auto-start extraction if deps are ready
    if (isReady.value) {
      doExtract();
    }
  },
);
</script>

<template>
  <section class="audio-panel">
    <h2 class="panel-title">🎵 视频音频提取 & 歌曲分割</h2>

    <!-- Dependency check -->
    <div v-if="depsLoading" class="status-bar loading">
      <span class="spinner"></span> 正在检查依赖...
    </div>
    <div v-else-if="depsStatus && !depsStatus.ok" class="status-bar error">
      <div class="status-icon">⚠️</div>
      <div class="status-text">
        <strong>依赖缺失</strong>
        <p>{{ depsStatus.message }}</p>
        <div class="dep-list">
          <span :class="depsStatus.ytdlp ? 'dep-ok' : 'dep-missing'">
            {{ depsStatus.ytdlp ? '✅' : '❌' }} yt-dlp
          </span>
          <span :class="depsStatus.ffmpeg ? 'dep-ok' : 'dep-missing'">
            {{ depsStatus.ffmpeg ? '✅' : '❌' }} ffmpeg
          </span>
        </div>
        <p class="install-hint">
          安装命令：<br />
          <code>winget install yt-dlp.yt-dlp</code><br />
          <code>winget install Gyan.FFmpeg</code>
        </p>
        <button class="retry-btn" @click="checkDeps">🔄 重新检查</button>
      </div>
    </div>
    <div v-else-if="depsStatus && depsStatus.ok" class="status-bar ok">
      ✅ 依赖就绪 — yt-dlp & ffmpeg 已安装
    </div>

    <!-- Step 1: Input URL -->
    <div class="step-card">
      <div class="step-header">
        <span class="step-num">1</span>
        <span class="step-title">输入B站视频链接</span>
      </div>
      <div class="step-body">
        <div class="url-input-row">
          <input
            v-model="videoUrl"
            type="text"
            class="url-input"
            placeholder="粘贴B站视频链接，如 https://www.bilibili.com/video/BVxxxxxx 或直接输入 BV号"
            :disabled="extracting"
            @keydown.enter="doExtract"
          />
          <button
            class="action-btn primary"
            :disabled="!canExtract || !isReady || extracting"
            @click="doExtract"
          >
            <span v-if="extracting" class="spinner"></span>
            <span v-else>🎧 提取音频</span>
          </button>
        </div>
        <div v-if="extractError" class="error-msg">⚠️ {{ extractError }}</div>
        <div v-if="extractDone" class="success-msg">
          ✅ 音频提取完成！
          <span v-if="audioDuration > 0">时长：{{ formatDurationLong(audioDuration) }}</span>
          <button class="small-btn" @click="playSource">
            {{ playingLabel === '完整音频' ? '⏹ 停止' : '▶ 试听完整音频' }}
          </button>
          <button class="small-btn reset" @click="resetAll">🔄 重新开始</button>
        </div>
      </div>
    </div>

    <!-- Step 2: Detect segments -->
    <div v-if="extractDone" class="step-card">
      <div class="step-header">
        <span class="step-num">2</span>
        <span class="step-title">检测歌曲片段</span>
      </div>
      <div class="step-body">
        <p class="step-desc">
          通过静音检测自动识别音频中的歌曲片段。可调整参数获得更好的分割效果。
        </p>
        <div class="params-row">
          <label class="param">
            <span>静音阈值 (dB)</span>
            <input v-model.number="silenceThresh" type="number" min="-60" max="0" step="5" />
          </label>
          <label class="param">
            <span>最短静音 (秒)</span>
            <input v-model.number="silenceDuration" type="number" min="0.5" max="30" step="0.5" />
          </label>
          <label class="param">
            <span>最短片段 (秒)</span>
            <input v-model.number="minSegment" type="number" min="5" max="300" step="5" />
          </label>
        </div>
        <button
          class="action-btn primary"
          :disabled="detecting"
          @click="doDetect"
        >
          <span v-if="detecting" class="spinner"></span>
          <span v-else>🔍 开始检测</span>
        </button>
        <div v-if="detectError" class="error-msg">⚠️ {{ detectError }}</div>
      </div>
    </div>

    <!-- Step 3: Review & edit segments -->
    <div v-if="detectDone && segments.length > 0" class="step-card">
      <div class="step-header">
        <span class="step-num">3</span>
        <span class="step-title">
          编辑片段
          <span class="badge">{{ segments.length }} 个片段</span>
        </span>
      </div>
      <div class="step-body">
        <p class="step-desc">
          检测到 {{ segments.length }} 个片段，总时长 {{ formatDurationLong(totalDuration) }}。
          你可以修改名称、调整时间或删除不需要的片段。
        </p>

        <!-- Timeline visualization -->
        <div class="timeline">
          <div class="timeline-bar">
            <div
              v-for="(seg, i) in segments"
              :key="i"
              class="timeline-seg"
              :style="{
                left: totalDuration > 0 ? (seg.start / totalDuration * 100) + '%' : '0%',
                width: totalDuration > 0 ? (seg.duration / totalDuration * 100) + '%' : '0%',
              }"
              :title="`${seg.label}: ${formatTime(seg.start)} - ${formatTime(seg.end)}`"
            >
              <span class="timeline-label">{{ i + 1 }}</span>
            </div>
          </div>
          <div class="timeline-ticks">
            <span>0:00</span>
            <span>{{ formatTime(totalDuration / 2) }}</span>
            <span>{{ formatTime(totalDuration) }}</span>
          </div>
        </div>

        <!-- Segment list -->
        <div class="segment-list">
          <div v-for="(seg, i) in segments" :key="i" class="segment-item">
            <div class="seg-color" :style="{ background: `hsl(${(i * 47) % 360}, 65%, 55%)` }"></div>
            <input
              class="seg-label-input"
              :value="seg.label"
              @input="updateSegmentLabel(i, ($event.target as HTMLInputElement).value)"
            />
            <span class="seg-time">
              {{ formatTime(seg.start) }} — {{ formatTime(seg.end) }}
              <small>({{ formatDurationLong(seg.duration) }})</small>
            </span>
            <div class="seg-actions">
              <button
                v-if="seg.file"
                class="icon-btn play"
                :title="playingUrl?.includes(seg.file!) ? '停止' : '播放'"
                @click="playSegment(seg)"
              >
                {{ playingUrl?.includes(seg.file!) ? '⏹' : '▶' }}
              </button>
              <button
                v-if="seg.file"
                class="icon-btn download"
                title="下载"
                @click="downloadSegment(seg)"
              >
                💾
              </button>
              <button class="icon-btn delete" title="删除" @click="removeSegment(i)">✕</button>
            </div>
          </div>
        </div>

        <button
          class="action-btn primary"
          :disabled="splitting || segments.length === 0"
          @click="doSplit"
        >
          <span v-if="splitting" class="spinner"></span>
          <span v-else>✂️ 分割并导出</span>
        </button>
        <div v-if="splitError" class="error-msg">⚠️ {{ splitError }}</div>
        <div v-if="splitDone" class="success-msg">
          ✅ 分割完成！点击每个片段的 ▶ 试听或 💾 下载。
        </div>
      </div>
    </div>

    <div v-if="detectDone && segments.length === 0" class="empty-state">
      未检测到符合条件的片段，请尝试调整参数后重新检测 🎶
    </div>

    <!-- Audio player (sticky bottom) -->
    <div v-if="playingUrl" class="audio-player-bar">
      <span class="player-label">🎵 {{ playingLabel }}</span>
      <audio
        :src="playingUrl"
        autoplay
        controls
        class="player-audio"
        @ended="playingUrl = null; playingLabel = ''"
      ></audio>
      <button class="icon-btn close" @click="playingUrl = null; playingLabel = ''">✕</button>
    </div>
  </section>
</template>

<style scoped>
.audio-panel {
  padding: 0.85rem 1rem 4.5rem;
  max-width: 100%;
  margin: 0 auto;
}

.panel-title {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text);
  margin: 0 0 0.75rem;
}

/* ---- Status bar ---- */
.status-bar {
  padding: 0.75rem 1rem;
  border-radius: 10px;
  margin-bottom: 1rem;
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}
.status-bar.loading {
  background: var(--surface);
  color: var(--muted);
  align-items: center;
}
.status-bar.error {
  background: rgba(255, 107, 107, 0.1);
  border: 1px solid rgba(255, 107, 107, 0.3);
  color: var(--text);
}
.status-bar.ok {
  background: rgba(76, 175, 80, 0.1);
  border: 1px solid rgba(76, 175, 80, 0.3);
  color: var(--text);
}
.status-icon {
  font-size: 1.5rem;
  flex-shrink: 0;
}
.status-text p {
  margin: 0.3rem 0;
  font-size: 0.88rem;
  color: var(--muted);
}
.dep-list {
  display: flex;
  gap: 1rem;
  margin: 0.5rem 0;
}
.dep-ok { color: #4caf50; }
.dep-missing { color: #ff6b6b; }
.install-hint {
  font-size: 0.82rem !important;
}
.install-hint code {
  display: inline-block;
  background: var(--surface);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.82rem;
  margin: 0.15rem 0;
}
.retry-btn {
  margin-top: 0.5rem;
  padding: 0.4rem 0.8rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  font-size: 0.85rem;
}
.retry-btn:hover {
  border-color: var(--primary);
}

/* ---- Step cards ---- */
.step-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 1rem;
  overflow: hidden;
}
.step-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.02);
}
.step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--primary);
  color: var(--on-primary);
  font-weight: 700;
  font-size: 0.85rem;
  flex-shrink: 0;
}
.step-title {
  font-weight: 600;
  font-size: 1rem;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.badge {
  font-size: 0.75rem;
  padding: 0.15rem 0.5rem;
  border-radius: 10px;
  background: var(--primary);
  color: var(--on-primary);
  font-weight: 500;
}
.step-body {
  padding: 1rem;
}
.step-desc {
  margin: 0 0 0.75rem;
  font-size: 0.88rem;
  color: var(--muted);
}

/* ---- URL input ---- */
.url-input-row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.url-input {
  flex: 1;
  padding: 0.65rem 1rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 0.95rem;
  outline: none;
  transition: border-color 0.2s;
}
.url-input:focus {
  border-color: var(--primary);
}
.url-input::placeholder {
  color: var(--muted);
  font-size: 0.85rem;
}

/* ---- Buttons ---- */
.action-btn {
  padding: 0.6rem 1.3rem;
  border-radius: 8px;
  border: none;
  font-weight: 600;
  font-size: 0.9rem;
  cursor: pointer;
  transition: opacity 0.2s, transform 0.1s;
  white-space: nowrap;
}
.action-btn.primary {
  background: var(--primary);
  color: var(--on-primary);
}
.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.action-btn:hover:not(:disabled) {
  opacity: 0.85;
}
.action-btn:active:not(:disabled) {
  transform: scale(0.97);
}

.small-btn {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.3rem 0.7rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 0.82rem;
  cursor: pointer;
}
.small-btn:hover {
  border-color: var(--primary);
}
.small-btn.reset {
  color: var(--muted);
}

/* ---- Params ---- */
.params-row {
  display: flex;
  gap: 1rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}
.param {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.82rem;
  color: var(--muted);
}
.param input {
  width: 80px;
  padding: 0.35rem 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 0.85rem;
  outline: none;
}
.param input:focus {
  border-color: var(--primary);
}

/* ---- Messages ---- */
.error-msg {
  padding: 0.5rem 0.75rem;
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.3);
  border-radius: 6px;
  color: #ff6b6b;
  font-size: 0.88rem;
  margin-top: 0.5rem;
}
.success-msg {
  padding: 0.5rem 0.75rem;
  background: rgba(76, 175, 80, 0.1);
  border: 1px solid rgba(76, 175, 80, 0.3);
  border-radius: 6px;
  color: #4caf50;
  font-size: 0.88rem;
  margin-top: 0.5rem;
}
.empty-state {
  text-align: center;
  color: var(--muted);
  padding: 2rem 1rem;
  font-size: 1rem;
}

/* ---- Timeline ---- */
.timeline {
  margin: 0.75rem 0 1rem;
}
.timeline-bar {
  position: relative;
  height: 32px;
  background: var(--bg);
  border-radius: 6px;
  border: 1px solid var(--border);
  overflow: hidden;
}
.timeline-seg {
  position: absolute;
  top: 2px;
  bottom: 2px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: default;
  min-width: 18px;
  transition: opacity 0.15s;
}
.timeline-seg:nth-child(odd) { background: rgba(100, 181, 246, 0.5); }
.timeline-seg:nth-child(even) { background: rgba(255, 183, 77, 0.5); }
.timeline-seg:hover { opacity: 0.8; }
.timeline-label {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text);
}
.timeline-ticks {
  display: flex;
  justify-content: space-between;
  font-size: 0.72rem;
  color: var(--muted);
  margin-top: 0.2rem;
  padding: 0 2px;
}

/* ---- Segment list ---- */
.segment-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-bottom: 0.75rem;
  max-height: 400px;
  overflow-y: auto;
}
.segment-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.6rem;
  background: var(--bg);
  border-radius: 8px;
  border: 1px solid var(--border);
  transition: border-color 0.15s;
}
.segment-item:hover {
  border-color: var(--primary);
}
.seg-color {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  flex-shrink: 0;
}
.seg-label-input {
  width: 100px;
  padding: 0.25rem 0.4rem;
  border-radius: 4px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  font-size: 0.85rem;
  font-weight: 500;
  outline: none;
  transition: border-color 0.15s, background 0.15s;
}
.seg-label-input:hover,
.seg-label-input:focus {
  border-color: var(--border);
  background: var(--surface);
}
.seg-time {
  flex: 1;
  font-size: 0.82rem;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.seg-time small {
  opacity: 0.7;
}
.seg-actions {
  display: flex;
  gap: 0.3rem;
}
.icon-btn {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.82rem;
  transition: background 0.15s, border-color 0.15s;
}
.icon-btn:hover {
  border-color: var(--primary);
}
.icon-btn.delete:hover {
  border-color: #ff6b6b;
  color: #ff6b6b;
}

/* ---- Audio player bar ---- */
.audio-player-bar {
  position: sticky;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.75rem;
  background: var(--surface);
  border-top: 1px solid var(--border);
  box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.15);
  z-index: 10;
  margin: 0 -1rem;
  width: calc(100% + 2rem);
}
.player-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  min-width: 80px;
}
.player-audio {
  flex: 1;
  height: 36px;
}
.icon-btn.close {
  border: none;
  background: transparent;
  font-size: 1.1rem;
  color: var(--muted);
}
.icon-btn.close:hover {
  color: var(--text);
}

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
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ---- Mobile ---- */
@media (max-width: 600px) {
  .audio-panel {
    padding: 0.6rem 0.6rem 4rem;
  }
  .url-input-row {
    flex-direction: column;
  }
  .params-row {
    flex-direction: column;
  }
  .seg-time small {
    display: none;
  }
}
</style>
