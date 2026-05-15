<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from "vue";
import { pluginPayloads, pluginPayloadVersion } from "../../shared/plugins";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
}

interface AnalysisPreset {
  id: string;
  label: string;
  icon: string;
  prompt: string;
}

/* ------------------------------------------------------------------ */
/*  Presets                                                           */
/* ------------------------------------------------------------------ */

const PRESETS: AnalysisPreset[] = [
  {
    id: "summary",
    label: "聊天摘要",
    icon: "📝",
    prompt: "请分析以下直播间弹幕内容，总结大家具体在聊什么话题，列出主要讨论点和热门话题。",
  },
  {
    id: "mood",
    label: "自闭/预约值",
    icon: "🎭",
    prompt: `假设主播有两个隐藏数值：
- 「自闭值」(0-100)：弹幕中的负面评价、嘲讽、催促、质疑会增加自闭值；鼓励、夸奖、安慰会降低自闭值。
- 「预约值」(0-100)：弹幕中的期待、催更、"什么时候播"、预约提醒会增加预约值；无关话题会降低预约值。

请根据以下弹幕内容，分析当前这两个值大概是多少，并详细说明哪些弹幕对这两个值产生了影响（增/减），给出具体的弹幕示例。`,
  },
  {
    id: "sentiment",
    label: "情感分析",
    icon: "💬",
    prompt: "请对以下直播间弹幕进行情感分析，统计正面、负面、中性弹幕的比例，并列出典型的正面和负面弹幕示例。",
  },
  {
    id: "highlight",
    label: "高光时刻",
    icon: "⭐",
    prompt: "请分析以下弹幕，找出可能的高光时刻（弹幕密度突然增加、大量相似内容、刷屏等），推测当时直播间发生了什么。",
  },
  {
    id: "custom",
    label: "自定义",
    icon: "✏️",
    prompt: "",
  },
];

/* ------------------------------------------------------------------ */
/*  AI Agent API (server-side proxy)                                  */
/* ------------------------------------------------------------------ */

const AI_AGENT_BASE = "/__fmz_ai_agent";

interface ModelOption {
  id: string;
  label: string;
  provider: string;
}

const availableModels = ref<ModelOption[]>([]);
const modelsLoading = ref(false);

async function fetchModels() {
  modelsLoading.value = true;
  try {
    const res = await fetch(`${AI_AGENT_BASE}/models`);
    if (res.ok) {
      const data = await res.json();
      availableModels.value = data.models || [];
      // If current selection is invalid, pick first available
      if (availableModels.value.length > 0 && !availableModels.value.find((m) => m.id === selectedModel.value)) {
        selectedModel.value = availableModels.value[0].id;
      }
    }
  } catch (err) {
    console.warn("[ai-agent] Failed to fetch models:", err);
  } finally {
    modelsLoading.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  State                                                             */
/* ------------------------------------------------------------------ */

const LS_MODEL = "fmz_ai_agent_model";

const selectedModel = ref(localStorage.getItem(LS_MODEL) || "");

const selectedPreset = ref<string>("summary");
const customPrompt = ref("");
const chatMessages = ref<ChatMessage[]>([]);
const isLoading = ref(false);
const chatScrollRef = ref<HTMLElement | null>(null);
const abortController = ref<AbortController | null>(null);

/** Danmaku data received from the main panel */
const danmakuData = ref<string>("");
const danmakuCount = ref(0);
const danmakuRoomId = ref("");

/* ------------------------------------------------------------------ */
/*  Persistence                                                       */
/* ------------------------------------------------------------------ */

watch(selectedModel, (v) => { try { localStorage.setItem(LS_MODEL, v); } catch {} });

/* ------------------------------------------------------------------ */
/*  Payload from danmaku panel                                        */
/* ------------------------------------------------------------------ */

function handlePayload() {
  const p = pluginPayloads.value["ai-agent"];
  if (!p) return;
  if (typeof p.danmakuText === "string") {
    danmakuData.value = p.danmakuText;
    danmakuCount.value = (p.danmakuCount as number) || 0;
    danmakuRoomId.value = (p.roomId as string) || "";
  }
}

watch(pluginPayloadVersion, () => handlePayload());
onMounted(() => {
  handlePayload();
  setTimeout(handlePayload, 50);
  fetchModels();
});

/* ------------------------------------------------------------------ */
/*  Computed                                                          */
/* ------------------------------------------------------------------ */

const activePreset = computed(() => PRESETS.find((p) => p.id === selectedPreset.value));

const effectivePrompt = computed(() => {
  if (selectedPreset.value === "custom") return customPrompt.value;
  return activePreset.value?.prompt || "";
});

const canSend = computed(() => {
  return selectedModel.value && effectivePrompt.value.trim() && danmakuData.value.trim() && !isLoading.value;
});

/* ------------------------------------------------------------------ */
/*  Chat logic                                                        */
/* ------------------------------------------------------------------ */

async function sendAnalysis() {
  if (!canSend.value) return;

  const userContent = `${effectivePrompt.value}\n\n---\n\n以下是直播间 ${danmakuRoomId.value || "未知"} 的弹幕数据（共 ${danmakuCount.value} 条）：\n\n${danmakuData.value}`;

  chatMessages.value.push({
    role: "user",
    content: `📊 分析请求：${activePreset.value?.label || "自定义分析"}\n\n弹幕数据：${danmakuCount.value} 条（房间 ${danmakuRoomId.value || "未知"}）`,
    ts: Date.now(),
  });

  chatMessages.value.push({
    role: "assistant",
    content: "",
    ts: Date.now(),
  });

  isLoading.value = true;
  const controller = new AbortController();
  abortController.value = controller;

  try {
    const res = await fetch(`${AI_AGENT_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelId: selectedModel.value,
        messages: [
          {
            role: "system",
            content: "你是一个直播间弹幕分析助手。用户会给你一段直播间的弹幕数据，请根据用户的要求进行分析。回复使用中文，格式清晰，适当使用 emoji 增加可读性。",
          },
          { role: "user", content: userContent },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`API 请求失败 (${res.status}): ${errText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("无法读取响应流");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            const lastMsg = chatMessages.value[chatMessages.value.length - 1];
            if (lastMsg && lastMsg.role === "assistant") {
              lastMsg.content += delta;
            }
          }
        } catch {
          // skip malformed JSON
        }
      }

      await nextTick();
      scrollToBottom();
    }
  } catch (err: any) {
    if (err.name === "AbortError") {
      const lastMsg = chatMessages.value[chatMessages.value.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        lastMsg.content += "\n\n⚠️ 已中断";
      }
    } else {
      const lastMsg = chatMessages.value[chatMessages.value.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        lastMsg.content = `❌ 错误：${err.message}`;
      }
    }
  } finally {
    isLoading.value = false;
    abortController.value = null;
    scrollToBottom();
  }
}

function stopGeneration() {
  abortController.value?.abort();
}

function clearChat() {
  chatMessages.value = [];
}

function scrollToBottom() {
  nextTick(() => {
    const el = chatScrollRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

/* ------------------------------------------------------------------ */
/*  Free-form chat                                                    */
/* ------------------------------------------------------------------ */

const freeInput = ref("");

const inputTextareaRef = ref<HTMLTextAreaElement | null>(null);

function autoResizeTextarea() {
  const el = inputTextareaRef.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

async function sendFreeChat() {
  const text = freeInput.value.trim();
  if (!text || isLoading.value || !selectedModel.value) return;

  freeInput.value = "";
  nextTick(() => { if (inputTextareaRef.value) inputTextareaRef.value.style.height = "auto"; });

  chatMessages.value.push({ role: "user", content: text, ts: Date.now() });
  chatMessages.value.push({ role: "assistant", content: "", ts: Date.now() });

  isLoading.value = true;
  const controller = new AbortController();
  abortController.value = controller;

  // Build conversation history (last 20 messages max)
  const historyMsgs = chatMessages.value.slice(0, -1).slice(-20).map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }));

  try {
    const res = await fetch(`${AI_AGENT_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelId: selectedModel.value,
        messages: [
          {
            role: "system",
            content: `你是一个直播间弹幕分析助手。当前直播间房间号：${danmakuRoomId.value || "未知"}。用户可能会基于之前的弹幕分析结果继续追问。回复使用中文。${danmakuData.value ? `\n\n当前弹幕数据参考（${danmakuCount.value}条）：\n${danmakuData.value.slice(0, 4000)}` : ""}`,
          },
          ...historyMsgs,
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`API 请求失败 (${res.status}): ${errText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("无法读取响应流");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            const lastMsg = chatMessages.value[chatMessages.value.length - 1];
            if (lastMsg && lastMsg.role === "assistant") {
              lastMsg.content += delta;
            }
          }
        } catch { /* skip */ }
      }

      await nextTick();
      scrollToBottom();
    }
  } catch (err: any) {
    if (err.name === "AbortError") {
      const lastMsg = chatMessages.value[chatMessages.value.length - 1];
      if (lastMsg?.role === "assistant") lastMsg.content += "\n\n⚠️ 已中断";
    } else {
      const lastMsg = chatMessages.value[chatMessages.value.length - 1];
      if (lastMsg?.role === "assistant") lastMsg.content = `❌ 错误：${err.message}`;
    }
  } finally {
    isLoading.value = false;
    abortController.value = null;
    scrollToBottom();
  }
}

function onFreeInputKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendFreeChat();
  }
}
</script>

<template>
  <div class="ai-agent-root">
    <!-- Chat area -->
    <div ref="chatScrollRef" class="ai-chat-area">
      <div v-if="chatMessages.length === 0" class="ai-empty-hint">
        <div class="ai-empty-icon">🤖</div>
        <div class="ai-empty-text">
          在弹幕面板点击「发送到 AI」按钮加载弹幕数据，<br />
          然后选择分析模式开始分析
        </div>
      </div>
      <div
        v-for="(msg, i) in chatMessages"
        :key="i"
        class="ai-chat-msg"
        :class="msg.role"
      >
        <div class="ai-msg-avatar">{{ msg.role === "user" ? "👤" : "🤖" }}</div>
        <div class="ai-msg-bubble">
          <div class="ai-msg-content" v-html="renderMarkdown(msg.content)" />
          <div v-if="msg.role === 'assistant' && isLoading && i === chatMessages.length - 1" class="ai-typing-indicator">
            <span /><span /><span />
          </div>
        </div>
      </div>
    </div>

    <!-- Unified search-bar style input -->
    <div class="ai-input-container">
      <div v-if="isLoading || (chatMessages.length > 0 && !isLoading)" class="ai-toolbar">
        <button
          v-if="isLoading"
          class="ai-action-btn ai-stop-btn"
          title="停止生成"
          @click="stopGeneration"
        >
          ⏹ 停止
        </button>
        <button
          v-if="chatMessages.length > 0 && !isLoading"
          class="ai-action-btn ai-clear-btn"
          title="清空对话"
          @click="clearChat"
        >
          🗑 清空
        </button>
      </div>
      <div class="ai-search-bar">
        <div class="ai-search-model">
          <select v-model="selectedModel" :disabled="modelsLoading">
            <option v-if="modelsLoading" value="" disabled>加载中...</option>
            <option v-else-if="availableModels.length === 0" value="" disabled>无可用模型</option>
            <option v-for="m in availableModels" :key="m.id" :value="m.id">{{ m.label }}</option>
          </select>
        </div>
        <div class="ai-search-input">
          <textarea
            v-model="freeInput"
            placeholder="继续追问或输入新问题..."
            rows="1"
            @keydown="onFreeInputKeydown"
            @input="autoResizeTextarea"
            ref="inputTextareaRef"
          />
        </div>
        <button
          class="ai-search-send"
          :disabled="!freeInput.trim() || isLoading || !selectedModel"
          title="发送"
          @click="sendFreeChat"
        >
          ➤
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/** Simple markdown-ish renderer (no external deps) */
function renderMarkdown(text: string): string {
  if (!text) return "";
  let html = text
    // Escape HTML
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Headers
    .replace(/^### (.+)$/gm, '<h4 class="ai-md-h">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 class="ai-md-h">$1</h3>')
    .replace(/^# (.+)$/gm, '<h2 class="ai-md-h">$1</h2>')
    // Horizontal rule
    .replace(/^---$/gm, "<hr />")
    // Line breaks
    .replace(/\n/g, "<br />");
  return html;
}
</script>

<style scoped>
.ai-agent-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-size: 0.85rem;
  color: var(--text);
  background: var(--surface);
}

/* Chat area — scrollbar stays at the rightmost edge */
.ai-chat-area {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.ai-empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  gap: 0.75rem;
  color: var(--muted);
}
.ai-empty-icon {
  font-size: 2.5rem;
  opacity: 0.5;
}
.ai-empty-text {
  font-size: 0.78rem;
  text-align: center;
  line-height: 1.6;
}

/* Chat messages */
.ai-chat-msg {
  display: flex;
  gap: 0.5rem;
  max-width: 100%;
}
.ai-chat-msg.user {
  flex-direction: row-reverse;
}
.ai-msg-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
  flex-shrink: 0;
  border: 1px solid var(--border);
}
.ai-msg-bubble {
  max-width: 85%;
  padding: 0.5rem 0.75rem;
  border-radius: 12px;
  font-size: 0.8rem;
  line-height: 1.6;
  word-break: break-word;
}
.ai-chat-msg.user .ai-msg-bubble {
  background: var(--primary);
  color: var(--on-primary);
  border-bottom-right-radius: 4px;
}
.ai-chat-msg.assistant .ai-msg-bubble {
  background: var(--bg);
  color: var(--text);
  border-bottom-left-radius: 4px;
  border: 1px solid var(--border);
}

/* Markdown content */
.ai-msg-content :deep(h2),
.ai-msg-content :deep(h3),
.ai-msg-content :deep(h4) {
  margin: 0.5rem 0 0.25rem;
  font-weight: 700;
}
.ai-msg-content :deep(h2) { font-size: 1rem; }
.ai-msg-content :deep(h3) { font-size: 0.92rem; }
.ai-msg-content :deep(h4) { font-size: 0.85rem; }
.ai-msg-content :deep(code) {
  background: rgba(0, 0, 0, 0.15);
  padding: 0.1rem 0.3rem;
  border-radius: 4px;
  font-size: 0.78rem;
}
.ai-msg-content :deep(strong) {
  font-weight: 700;
}
.ai-msg-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 0.5rem 0;
}

/* Typing indicator */
.ai-typing-indicator {
  display: flex;
  gap: 4px;
  padding-top: 0.3rem;
}
.ai-typing-indicator span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
  animation: ai-bounce 1.2s infinite;
}
.ai-typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
.ai-typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
@keyframes ai-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
}

/* ---- Input container ---- */
.ai-input-container {
  padding: 0.6rem 0.75rem;
  border-top: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

/* Toolbar (stop / clear) */
.ai-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.35rem;
}
.ai-action-btn {
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 0.7rem;
  cursor: pointer;
  transition: all 0.15s;
}
.ai-action-btn:hover {
  background: var(--bg);
  color: var(--text);
}
.ai-stop-btn {
  color: #ff6b6b;
  border-color: rgba(255, 107, 107, 0.4);
}
.ai-stop-btn:hover {
  background: rgba(255, 107, 107, 0.1);
  color: #ff4444;
}
.ai-clear-btn:hover {
  color: var(--text);
}

/* ---- Unified search bar (model | input | send) ---- */
.ai-search-bar {
  display: flex;
  align-items: stretch;
  border: 1px solid var(--border);
  border-radius: 22px;
  background: var(--bg);
  overflow: hidden;
  transition: border-color 0.15s;
}
.ai-search-bar:focus-within {
  border-color: var(--primary);
}

/* Left: model selector (half-ellipse) */
.ai-search-model {
  display: flex;
  align-items: center;
  background: var(--surface);
  border-right: 1px solid var(--border);
  flex-shrink: 0;
  max-width: 100px;
}
.ai-search-model select {
  padding: 0.45rem 0.3rem 0.45rem 0.6rem;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 0.75rem;
  font-weight: 600;
  outline: none;
  cursor: pointer;
  appearance: auto;
  min-width: 0;
  max-width: 100%;
}

/* Middle: textarea */
.ai-search-input {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}
.ai-search-input textarea {
  width: 100%;
  padding: 0.45rem 0.6rem;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 0.82rem;
  resize: none;
  outline: none;
  font-family: inherit;
  line-height: 1.5;
  min-height: 36px;
  max-height: 120px;
  box-sizing: border-box;
}
.ai-search-input textarea::placeholder {
  color: var(--muted);
}

/* Right: send button (embedded) */
.ai-search-send {
  width: 38px;
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--primary);
  font-size: 1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, background 0.15s;
}
.ai-search-send:hover:not(:disabled) {
  background: var(--surface);
  color: var(--primary);
}
.ai-search-send:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
</style>
