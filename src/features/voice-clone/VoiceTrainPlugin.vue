<template>
  <div class="voice-train-plugin">
    <h3 class="plugin-title">🎤 声音模型训练</h3>
    <p class="plugin-desc">选择音频文件训练专属声音模型，支持从本地上传或项目歌曲库选择。</p>

    <!-- Backend status -->
    <div class="status-bar" :class="{ ok: backendOk, warn: serverReachable && !backendOk, err: !serverReachable }">
      <span class="dot" />
      <span v-if="backendOk">已连接 ({{ backendName }})</span>
      <span v-else-if="serverReachable">服务已连接，但{{ backendName }}未配置 — 请在「幻化宝音」页签中配置</span>
      <span v-else>未连接后端服务</span>
      <button class="btn-sm" @click="checkStatus">刷新</button>
    </div>

    <!-- Model name -->
    <div class="field">
      <label>模型名称</label>
      <input v-model="modelName" type="text" placeholder="给模型起个名字..." />
    </div>

    <!-- Prompt text (for GPT-SoVITS) -->
    <div class="field" v-if="backendType === 'gpt-sovits'">
      <label>参考文本 <small>(可选，参考音频对应的文字)</small></label>
      <input v-model="promptText" type="text" placeholder="参考音频中说的话..." />
    </div>

    <!-- Audio source selection -->
    <div class="field">
      <label>音频来源</label>
      <div class="source-tabs">
        <button :class="{ active: audioSource === 'local' }" @click="audioSource = 'local'">📁 本地文件</button>
        <button :class="{ active: audioSource === 'library' }" @click="audioSource = 'library'">🎵 歌曲库</button>
      </div>
    </div>

    <!-- Local file upload -->
    <div v-if="audioSource === 'local'" class="upload-area">
      <input
        ref="fileInput"
        type="file"
        multiple
        accept="audio/*"
        style="display: none"
        @change="onFilesSelected"
      />
      <div class="drop-zone" @click="fileInput?.click()" @dragover.prevent @drop.prevent="onDrop">
        <span class="drop-icon">📂</span>
        <span>点击选择或拖拽音频文件</span>
        <small>支持 mp3, wav, flac, ogg 等格式，可多选</small>
      </div>
    </div>

    <!-- Song library selection -->
    <div v-if="audioSource === 'library'" class="library-area">
      <div v-if="libraryLoading" class="empty-hint">
        <span>正在加载歌曲库...</span>
      </div>
      <div v-else-if="librarySongs.length === 0" class="empty-hint">
        <span>歌曲库为空，请先在「音频提取」中提取歌曲</span>
      </div>
      <div v-else class="song-list">
        <label
          v-for="song in librarySongs"
          :key="song.id"
          class="song-item"
          :class="{ selected: selectedSongs.has(song.id) }"
        >
          <input type="checkbox" :checked="selectedSongs.has(song.id)" @change="toggleSong(song)" />
          <span class="song-title">{{ song.title }}</span>
          <span class="song-duration">{{ formatDuration(song.duration) }}</span>
        </label>
      </div>
    </div>

    <!-- Selected files list -->
    <div v-if="selectedFiles.length > 0" class="selected-files">
      <h4>已选择 {{ selectedFiles.length }} 个文件</h4>
      <ul>
        <li v-for="(f, i) in selectedFiles" :key="i">
          <span class="file-name">{{ f.name }}</span>
          <button class="btn-remove" @click="removeFile(i)">✕</button>
        </li>
      </ul>
    </div>

    <!-- Train button -->
    <button
      class="btn-train"
      :disabled="!canTrain || training"
      @click="startTraining"
    >
      <span v-if="training" class="spinner" />
      {{ training ? '训练中...' : '🚀 开始训练' }}
    </button>

    <!-- Training result -->
    <div v-if="trainResult || trainError" class="train-result" :class="{ success: !trainError, error: trainError }">
      <p v-if="trainError">❌ {{ trainError }}</p>
      <p v-else>✅ 模型「{{ trainResult.name }}」创建成功！{{ trainResult.status === 'training' ? '(训练中，请稍后查看)' : '(已就绪)' }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";

const API_BASE = "/__fmz_voice_clone";

// ─── State ──────────────────────────────────────────────────────────────────
const backendOk = ref(false);
const serverReachable = ref(false);
const backendType = ref("rvc");
const backendName = computed(() => {
  if (backendType.value === "fish-audio") return "Fish Audio";
  if (backendType.value === "rvc") return "RVC";
  return "GPT-SoVITS";
});

const modelName = ref("");
const promptText = ref("");
const audioSource = ref<"local" | "library">("local");

const fileInput = ref<HTMLInputElement | null>(null);
const selectedFiles = ref<File[]>([]);
const selectedSongs = ref(new Set<string>());
const librarySongs = ref<Array<{ id: string; title: string; duration: number; url: string }>>([]);

const libraryLoading = ref(false);
const training = ref(false);
const trainResult = ref<any>(null);
const trainError = ref("");

const canTrain = computed(() => {
  if (!modelName.value.trim()) return false;
  if (audioSource.value === "local" && selectedFiles.value.length === 0) return false;
  if (audioSource.value === "library" && selectedSongs.value.size === 0) return false;
  return serverReachable.value;
});

// ─── Methods ────────────────────────────────────────────────────────────────
async function checkStatus() {
  try {
    const resp = await fetch(`${API_BASE}/status`);
    if (resp.ok) {
      const data = await resp.json();
      serverReachable.value = true;
      backendOk.value = data.ok && data.configured;
      backendType.value = data.backend;
    } else {
      serverReachable.value = false;
      backendOk.value = false;
    }
  } catch {
    serverReachable.value = false;
    backendOk.value = false;
  }
}

function onFilesSelected(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files) {
    selectedFiles.value.push(...Array.from(input.files));
  }
  input.value = "";
}

function onDrop(e: DragEvent) {
  const files = e.dataTransfer?.files;
  if (files) {
    const audioFiles = Array.from(files).filter((f) => f.type.startsWith("audio/"));
    selectedFiles.value.push(...audioFiles);
  }
}

function removeFile(index: number) {
  selectedFiles.value.splice(index, 1);
}

function toggleSong(song: { id: string }) {
  if (selectedSongs.value.has(song.id)) {
    selectedSongs.value.delete(song.id);
  } else {
    selectedSongs.value.add(song.id);
  }
  // Force reactivity
  selectedSongs.value = new Set(selectedSongs.value);
}

function formatDuration(sec: number): string {
  if (!sec) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

async function loadLibrarySongs() {
  libraryLoading.value = true;
  try {
    const resp = await fetch("/__fmz_audio/library");
    if (resp.ok) {
      const data = await resp.json();
      const videos = data.videos || [];
      const allSongs: Array<{ id: string; title: string; duration: number; url: string }> = [];
      for (const video of videos) {
        const bvid = video.bvid;
        const page = video.page || 1;
        for (const song of (video.songs || [])) {
          const pagePrefix = page > 1 ? `p${page}/` : "";
          allSongs.push({
            id: `${bvid}/${pagePrefix}${song.file}`,
            title: song.label || song.file.replace(/\.[^.]+$/, ""),
            duration: song.duration || 0,
            url: `/__fmz_audio/download/${bvid}/${pagePrefix}music/${encodeURIComponent(song.file)}`,
          });
        }
      }
      librarySongs.value = allSongs;
    } else {
      librarySongs.value = [];
    }
  } catch {
    // Song library not available
    librarySongs.value = [];
  } finally {
    libraryLoading.value = false;
  }
}

async function startTraining() {
  training.value = true;
  trainResult.value = null;
  trainError.value = "";

  try {
    const formData = new FormData();
    formData.append("name", modelName.value.trim());
    if (promptText.value) formData.append("promptText", promptText.value);

    if (audioSource.value === "local") {
      for (const file of selectedFiles.value) {
        formData.append("audio", file, file.name);
      }
    } else {
      // Send library file paths for the server to read directly
      const paths: string[] = [];
      for (const songId of selectedSongs.value) {
        const song = librarySongs.value.find((s) => s.id === songId);
        if (song) {
          // song.id format: "{bvid}/music/{filename}" or "{bvid}/p{N}/music/{filename}"
          // Convert to relative path the server can read from audio data dir
          const parts = song.id.split("/");
          const bvid = parts[0];
          const filename = parts[parts.length - 1];
          const pagePrefix = parts.length > 2 && parts[1].startsWith("p") ? `${parts[1]}/` : "";
          paths.push(`${bvid}/${pagePrefix}music/${filename}`);
        }
      }
      if (paths.length > 0) {
        formData.append("libraryPaths", JSON.stringify(paths));
      }
    }

    const resp = await fetch(`${API_BASE}/train`, {
      method: "POST",
      body: formData,
    });

    if (resp.ok) {
      trainResult.value = await resp.json();
    } else {
      const err = await resp.json();
      trainError.value = err.error || "训练失败";
    }
  } catch (e: any) {
    trainError.value = e.message || "网络错误";
  } finally {
    training.value = false;
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────
onMounted(() => {
  checkStatus();
  loadLibrarySongs();
});
</script>

<style scoped>
.voice-train-plugin {
  padding: 1rem;
  font-size: 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.plugin-title {
  margin: 0;
  font-size: 1.1rem;
}
.plugin-desc {
  margin: 0;
  color: var(--muted);
  font-size: 0.82rem;
}
.status-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  border-radius: 6px;
  font-size: 0.82rem;
}
.status-bar.ok { background: #e8f5e9; color: #2e7d32; }
.status-bar.warn { background: #fff3e0; color: #e65100; }
.status-bar.err { background: #fbe9e7; color: #c62828; }
.dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: currentColor;
}
.btn-sm {
  margin-left: auto;
  padding: 0.2rem 0.5rem;
  border: 1px solid currentColor;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 0.75rem;
}
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.field label { font-weight: 600; font-size: 0.82rem; }
.field input {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 0.85rem;
  background: var(--bg);
  color: var(--text);
}
.source-tabs {
  display: flex; gap: 0.5rem;
}
.source-tabs button {
  flex: 1;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  font-size: 0.82rem;
  transition: all 0.15s;
}
.source-tabs button.active {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}
.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
  padding: 1.5rem;
  border: 2px dashed var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.15s;
  text-align: center;
}
.drop-zone:hover { border-color: var(--primary); }
.drop-icon { font-size: 1.5rem; }
.drop-zone small { color: var(--muted); font-size: 0.75rem; }
.song-list {
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.song-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.75rem;
  cursor: pointer;
  transition: background 0.1s;
}
.song-item:hover { background: var(--bg); }
.song-item.selected { background: #e3f2fd; }
.song-title { flex: 1; font-size: 0.82rem; }
.song-duration { color: var(--muted); font-size: 0.75rem; }
.selected-files h4 { margin: 0; font-size: 0.85rem; }
.selected-files ul {
  list-style: none; padding: 0; margin: 0.3rem 0 0;
  display: flex; flex-direction: column; gap: 0.2rem;
}
.selected-files li {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.3rem 0.5rem;
  background: var(--bg);
  border-radius: 4px;
  font-size: 0.8rem;
}
.file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn-remove {
  background: none; border: none; color: var(--muted);
  cursor: pointer; font-size: 0.9rem; padding: 0 0.3rem;
}
.btn-remove:hover { color: #c62828; }
.btn-train {
  padding: 0.7rem 1.2rem;
  border: none;
  border-radius: 8px;
  background: var(--primary);
  color: #fff;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
}
.btn-train:disabled { opacity: 0.5; cursor: not-allowed; }
.spinner {
  width: 14px; height: 14px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.train-result {
  padding: 0.6rem 0.75rem;
  border-radius: 6px;
  font-size: 0.82rem;
}
.train-result.success { background: #e8f5e9; color: #2e7d32; }
.train-result.error { background: #fbe9e7; color: #c62828; }
.train-result p { margin: 0; }
.empty-hint {
  padding: 1rem;
  text-align: center;
  color: var(--muted);
  font-size: 0.82rem;
}
</style>
