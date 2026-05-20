<template>
  <div class="voice-clone-panel">
    <header class="panel-header">
      <h2>🎭 幻化宝音</h2>
      <p class="subtitle">用训练好的声音模型替换音色或朗读文字</p>
    </header>

    <!-- Backend config section -->
    <section class="config-section">
      <div class="config-header" @click="showConfig = !showConfig">
        <span>⚙️ 后端配置</span>
        <span class="toggle">{{ showConfig ? '▲' : '▼' }}</span>
      </div>
      <div v-if="showConfig" class="config-body">
        <div class="config-row">
          <label>后端选择</label>
          <select v-model="config.backend" @change="saveBackendConfig">
            <option value="rvc">RVC (本地·音色转换)</option>
            <option value="fish-audio">Fish Audio (云端·仅TTS)</option>
            <option value="gpt-sovits">GPT-SoVITS (本地)</option>
          </select>
        </div>
        <template v-if="config.backend === 'fish-audio'">
          <div class="config-row">
            <label>API Key</label>
            <input v-model="config.fishAudio.apiKey" type="password" placeholder="sk-..." @blur="saveBackendConfig" />
          </div>
          <div class="config-row">
            <label>Base URL</label>
            <input v-model="config.fishAudio.baseUrl" type="text" @blur="saveBackendConfig" />
          </div>
        </template>
        <template v-else-if="config.backend === 'rvc'">
          <div class="config-row">
            <label>RVC 地址</label>
            <input v-model="config.rvc.baseUrl" type="text" placeholder="http://127.0.0.1:7865" @blur="saveBackendConfig" />
          </div>
          <div class="config-row">
            <label>音高偏移</label>
            <input v-model.number="config.rvc.pitchShift" type="number" min="-12" max="12" @blur="saveBackendConfig" />
            <span class="config-hint">半音（男→女 +12，女→男 -12）</span>
          </div>
          <div class="config-row">
            <label>索引率</label>
            <input v-model.number="config.rvc.indexRate" type="number" min="0" max="1" step="0.05" @blur="saveBackendConfig" />
          </div>
        </template>
        <template v-else>
          <div class="config-row">
            <label>GPT-SoVITS 地址</label>
            <input v-model="config.gptSovits.baseUrl" type="text" placeholder="http://127.0.0.1:9880" @blur="saveBackendConfig" />
          </div>
        </template>
        <div class="config-status" :class="{ ok: statusOk }">
          {{ statusOk ? '✅ 后端已连接' : '❌ 后端未连接' }}
          <button class="btn-check" @click="checkBackendStatus">检测</button>
        </div>
      </div>
    </section>

    <!-- Models list -->
    <section class="models-section">
      <div class="section-header">
        <h3>📦 我的模型</h3>
        <button class="btn-refresh" @click="loadModels">🔄</button>
      </div>
      <div v-if="models.length === 0" class="empty-state">
        <p>暂无模型，请通过插件面板训练新模型</p>
      </div>
      <div v-else class="models-grid">
        <div
          v-for="model in models"
          :key="model.id"
          class="model-card"
          :class="{ active: selectedModel?.id === model.id }"
          @click="selectedModel = model"
        >
          <div class="model-icon">🎤</div>
          <div class="model-info">
            <span class="model-name">{{ model.name }}</span>
            <span class="model-meta">
              {{ model.backend === 'fish-audio' ? '☁️' : '💻' }}
              {{ model.audioCount }}个音频 ·
              {{ model.status === 'ready' ? '✅就绪' : '⏳训练中' }}
            </span>
          </div>
          <button class="btn-delete" @click.stop="deleteModel(model.id)" title="删除模型">🗑️</button>
        </div>
      </div>
    </section>

    <!-- Function tabs: TTS / Voice Conversion -->
    <section v-if="selectedModel" class="function-section">
      <div class="func-tabs">
        <button v-if="capabilities.includes('tts')" :class="{ active: funcTab === 'tts' }" @click="funcTab = 'tts'">📝 文字朗读</button>
        <button v-if="capabilities.includes('convert')" :class="{ active: funcTab === 'convert' }" @click="funcTab = 'convert'">🔄 音色替换</button>
      </div>

      <!-- TTS -->
      <div v-if="funcTab === 'tts'" class="func-body">
        <div class="selected-model-badge">
          使用模型：<strong>{{ selectedModel.name }}</strong>
        </div>
        <textarea
          ref="ttsTextarea"
          v-model="ttsText"
          class="tts-input"
          placeholder="输入要朗读的文字（支持标签控制语气，点击下方快捷插入）..."
          rows="4"
        />
        <div class="tts-tags">
          <span class="tags-label">插入标签：</span>
          <button v-for="tag in ttsTags" :key="tag.value" class="tag-btn" :title="tag.desc" @click="insertTag(tag.value)">
            {{ tag.label }}
          </button>
        </div>
        <button class="btn-action" :disabled="!ttsText.trim() || ttsLoading" @click="doTTS">
          <span v-if="ttsLoading" class="spinner" />
          {{ ttsLoading ? '生成中...' : '🔊 生成语音' }}
        </button>
      </div>

      <!-- Voice Conversion -->
      <div v-if="funcTab === 'convert'" class="func-body">
        <div class="selected-model-badge">
          使用模型：<strong>{{ selectedModel.name }}</strong>
        </div>
        <div class="upload-convert">
          <input
            ref="convertFileInput"
            type="file"
            accept="audio/*"
            style="display: none"
            @change="onConvertFileSelected"
          />
          <div class="drop-zone" @click="convertFileInput?.click()">
            <span v-if="convertFile">📄 {{ convertFile.name }}</span>
            <span v-else>📂 选择要替换音色的音频文件</span>
          </div>
        </div>
        <button class="btn-action" :disabled="!convertFile || convertLoading" @click="doConvert">
          <span v-if="convertLoading" class="spinner" />
          {{ convertLoading ? '转换中...' : '🎭 替换音色' }}
        </button>
      </div>

      <!-- Audio output -->
      <div v-if="outputAudioUrl" class="output-section">
        <h4>🎧 输出结果</h4>
        <audio :src="outputAudioUrl" controls class="audio-player" />
        <a :href="outputAudioUrl" download class="btn-download">💾 下载音频</a>
      </div>

      <!-- Error display -->
      <div v-if="funcError" class="func-error">
        ❌ {{ funcError }}
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";

const API_BASE = "/__fmz_voice_clone";

interface VoiceModel {
  id: string;
  name: string;
  backend: string;
  remoteId?: string;
  refAudioPath?: string;
  promptText?: string;
  audioCount: number;
  createdAt: string;
  status: string;
}

// ─── State ──────────────────────────────────────────────────────────────────
const showConfig = ref(false);
const statusOk = ref(false);
const config = ref({
  backend: "rvc",
  fishAudio: { apiKey: "", baseUrl: "https://api.fish.audio" },
  gptSovits: { baseUrl: "http://127.0.0.1:9880" },
  rvc: { baseUrl: "http://127.0.0.1:7865", pitchShift: 0, indexRate: 0.75, filterRadius: 3, rmsMixRate: 0.25, protect: 0.33 },
});

const models = ref<VoiceModel[]>([]);
const selectedModel = ref<VoiceModel | null>(null);

const funcTab = ref<"tts" | "convert">("convert");

// Backend capabilities
const capabilities = ref<string[]>(["tts", "convert"]);

// TTS state
const ttsText = ref("");
const ttsLoading = ref(false);
const ttsTextarea = ref<HTMLTextAreaElement | null>(null);

// Fish Audio TTS tags
const ttsTags = [
  { label: "😂 笑声", value: "[laugh]", desc: "插入笑声效果" },
  { label: "😊 开心", value: "[happy]", desc: "开心语气" },
  { label: "😢 悲伤", value: "[sad]", desc: "悲伤语气" },
  { label: "😠 愤怒", value: "[angry]", desc: "愤怒语气" },
  { label: "🫁 呼吸", value: "[breath]", desc: "插入呼吸声" },
  { label: "⏸️ 停顿1s", value: "[pause=1s]", desc: "停顿1秒" },
  { label: "⏸️ 停顿2s", value: "[pause=2s]", desc: "停顿2秒" },
  { label: "🤭 带笑", value: "[laughter]", desc: "带笑意的语气" },
];

function insertTag(tag: string) {
  const textarea = ttsTextarea.value;
  if (!textarea) {
    ttsText.value += tag;
    return;
  }
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = ttsText.value;
  ttsText.value = text.slice(0, start) + tag + text.slice(end);
  // Restore cursor position after the inserted tag
  const newPos = start + tag.length;
  requestAnimationFrame(() => {
    textarea.focus();
    textarea.setSelectionRange(newPos, newPos);
  });
}

// Convert state
const convertFileInput = ref<HTMLInputElement | null>(null);
const convertFile = ref<File | null>(null);
const convertLoading = ref(false);

// Output
const outputAudioUrl = ref("");
const funcError = ref("");

// ─── Methods ────────────────────────────────────────────────────────────────
async function checkBackendStatus() {
  try {
    const resp = await fetch(`${API_BASE}/status`);
    if (resp.ok) {
      const data = await resp.json();
      statusOk.value = data.ok && data.configured;
      if (data.capabilities) {
        capabilities.value = data.capabilities;
        // Auto-switch tab if current tab is not available
        if (!capabilities.value.includes(funcTab.value)) {
          funcTab.value = capabilities.value[0] as "tts" | "convert";
        }
      }
    } else {
      statusOk.value = false;
    }
  } catch {
    statusOk.value = false;
  }
}

async function loadConfig() {
  try {
    const resp = await fetch(`${API_BASE}/config`);
    if (resp.ok) {
      const data = await resp.json();
      config.value = { ...config.value, ...data };
    }
  } catch { /* ignore */ }
}

async function saveBackendConfig() {
  try {
    await fetch(`${API_BASE}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config.value),
    });
    await checkBackendStatus();
  } catch { /* ignore */ }
}

async function loadModels() {
  try {
    const resp = await fetch(`${API_BASE}/models`);
    if (resp.ok) {
      models.value = await resp.json();
    }
  } catch { /* ignore */ }
}

async function deleteModel(id: string) {
  if (!confirm("确定删除此模型？")) return;
  try {
    await fetch(`${API_BASE}/models/${id}`, { method: "DELETE" });
    if (selectedModel.value?.id === id) selectedModel.value = null;
    await loadModels();
  } catch { /* ignore */ }
}

function onConvertFileSelected(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files?.[0]) {
    convertFile.value = input.files[0];
  }
}

function cleanupOutput() {
  if (outputAudioUrl.value) {
    URL.revokeObjectURL(outputAudioUrl.value);
    outputAudioUrl.value = "";
  }
  funcError.value = "";
}

async function doTTS() {
  if (!selectedModel.value || !ttsText.value.trim()) return;
  cleanupOutput();
  ttsLoading.value = true;

  try {
    const resp = await fetch(`${API_BASE}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: ttsText.value.trim(),
        modelId: selectedModel.value.id,
      }),
    });

    if (resp.ok) {
      const blob = await resp.blob();
      outputAudioUrl.value = URL.createObjectURL(blob);
    } else {
      const err = await resp.json();
      funcError.value = err.error || "TTS 生成失败";
    }
  } catch (e: any) {
    funcError.value = e.message || "网络错误";
  } finally {
    ttsLoading.value = false;
  }
}

async function doConvert() {
  if (!selectedModel.value || !convertFile.value) return;
  cleanupOutput();
  convertLoading.value = true;

  try {
    const formData = new FormData();
    formData.append("modelId", selectedModel.value.id);
    formData.append("audio", convertFile.value);

    const resp = await fetch(`${API_BASE}/convert`, {
      method: "POST",
      body: formData,
    });

    if (resp.ok) {
      const blob = await resp.blob();
      outputAudioUrl.value = URL.createObjectURL(blob);
    } else {
      const err = await resp.json();
      funcError.value = err.error || "音色替换失败";
    }
  } catch (e: any) {
    funcError.value = e.message || "网络错误";
  } finally {
    convertLoading.value = false;
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────
onMounted(async () => {
  await Promise.all([loadConfig(), loadModels(), checkBackendStatus()]);
});

onUnmounted(() => {
  if (outputAudioUrl.value) URL.revokeObjectURL(outputAudioUrl.value);
});
</script>

<style scoped>
.voice-clone-panel {
  padding: 1.25rem;
  max-width: 800px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.panel-header h2 { margin: 0; font-size: 1.4rem; }
.subtitle { margin: 0.25rem 0 0; color: var(--muted); font-size: 0.85rem; }

/* Config section */
.config-section {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.config-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.6rem 1rem;
  background: var(--bg);
  cursor: pointer;
  font-weight: 600;
  font-size: 0.9rem;
}
.config-body {
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border-top: 1px solid var(--border);
}
.config-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.config-row label {
  min-width: 80px;
  font-size: 0.82rem;
  font-weight: 600;
}
.config-row input, .config-row select {
  flex: 1;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 0.85rem;
  background: var(--bg);
  color: var(--text);
}
.config-hint {
  font-size: 0.72rem;
  color: var(--muted);
  white-space: nowrap;
}
.config-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.82rem;
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  background: #fbe9e7;
  color: #c62828;
}
.config-status.ok { background: #e8f5e9; color: #2e7d32; }
.btn-check {
  margin-left: auto;
  padding: 0.2rem 0.6rem;
  border: 1px solid currentColor;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 0.75rem;
}

/* Models section */
.models-section { }
.section-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.section-header h3 { margin: 0; font-size: 1rem; }
.btn-refresh {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  padding: 0.2rem;
}
.empty-state {
  padding: 1.5rem;
  text-align: center;
  color: var(--muted);
  border: 1px dashed var(--border);
  border-radius: 8px;
  font-size: 0.85rem;
}
.models-grid {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.model-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
}
.model-card:hover { border-color: var(--primary); }
.model-card.active {
  border-color: var(--primary);
  background: #e3f2fd;
}
.model-icon { font-size: 1.5rem; }
.model-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.model-name { font-weight: 600; font-size: 0.9rem; }
.model-meta { font-size: 0.75rem; color: var(--muted); }
.btn-delete {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  opacity: 0.5;
  transition: opacity 0.15s;
}
.btn-delete:hover { opacity: 1; }

/* Function section */
.function-section {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.func-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
}
.func-tabs button {
  flex: 1;
  padding: 0.6rem;
  border: none;
  background: var(--bg);
  color: var(--muted);
  cursor: pointer;
  font-weight: 600;
  font-size: 0.85rem;
  transition: all 0.15s;
}
.func-tabs button.active {
  background: var(--surface);
  color: var(--primary);
  border-bottom: 2px solid var(--primary);
}
.func-body {
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.selected-model-badge {
  font-size: 0.82rem;
  padding: 0.3rem 0.6rem;
  background: #e8eaf6;
  border-radius: 4px;
  color: #3949ab;
}
.tts-input {
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 0.9rem;
  resize: vertical;
  min-height: 80px;
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
}
.tts-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.tags-label {
  font-size: 0.75rem;
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
}
.tag-btn {
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg);
  color: var(--text);
  font-size: 0.72rem;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.tag-btn:hover {
  border-color: var(--primary);
  background: #e3f2fd;
  color: var(--primary);
}
.upload-convert .drop-zone {
  padding: 1rem;
  border: 2px dashed var(--border);
  border-radius: 8px;
  text-align: center;
  cursor: pointer;
  font-size: 0.85rem;
  transition: border-color 0.15s;
}
.upload-convert .drop-zone:hover { border-color: var(--primary); }
.btn-action {
  padding: 0.7rem 1.2rem;
  border: none;
  border-radius: 8px;
  background: var(--primary);
  color: #fff;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  transition: opacity 0.15s;
}
.btn-action:disabled { opacity: 0.5; cursor: not-allowed; }
.spinner {
  width: 14px; height: 14px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Output */
.output-section {
  padding: 1rem;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.output-section h4 { margin: 0; font-size: 0.9rem; }
.audio-player { width: 100%; }
.btn-download {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.4rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  text-decoration: none;
  color: var(--text);
  font-size: 0.82rem;
  width: fit-content;
  transition: border-color 0.15s;
}
.btn-download:hover { border-color: var(--primary); }

/* Error */
.func-error {
  padding: 0.6rem 0.75rem;
  background: #fbe9e7;
  color: #c62828;
  border-radius: 6px;
  font-size: 0.82rem;
  margin: 0 1rem 1rem;
}
</style>
