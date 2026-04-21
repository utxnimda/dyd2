<script setup lang="ts">
import { ref, onMounted } from "vue";

/** Default port for the quota server (lsy server.js) */
const QUOTA_SERVER_PORT = 3210;
const QUOTA_SERVER_URL = `http://localhost:${QUOTA_SERVER_PORT}`;

const serverOnline = ref<boolean | null>(null);
const checking = ref(false);

async function checkServer() {
  checking.value = true;
  try {
    const res = await fetch(`${QUOTA_SERVER_URL}/api/config-status`, {
      mode: "no-cors",
      signal: AbortSignal.timeout(3000),
    });
    // no-cors returns opaque response (status 0), but if it doesn't throw it means server is up
    serverOnline.value = true;
  } catch {
    serverOnline.value = false;
  } finally {
    checking.value = false;
  }
}

function openDashboard() {
  window.open(QUOTA_SERVER_URL, "_blank");
}

function reload() {
  void checkServer();
}

onMounted(() => {
  void checkServer();
});

defineExpose({ reload });
</script>

<template>
  <section class="quota-panel">
    <div class="quota-card">
      <div class="quota-icon">📊</div>
      <h2 class="quota-title">Cursor / CodeBuddy 用量看板</h2>
      <p class="quota-desc">查看 Cursor、CodeBuddy Plugin、CodeBuddy IDE 的配额使用情况</p>

      <button class="quota-open-btn" @click="openDashboard">
        🚀 打开用量看板
      </button>

      <div v-if="serverOnline === false" class="quota-status offline">
        <span>⚠️ Quota Server 未运行</span>
        <span class="quota-hint">请先启动：<code>node server.js</code>（在 lsy 目录下）</span>
        <button class="quota-retry-btn" :disabled="checking" @click="checkServer">
          {{ checking ? '检测中...' : '🔄 重试检测' }}
        </button>
      </div>
      <div v-else-if="serverOnline === true" class="quota-status online">
        <span>✅ Quota Server 运行中</span>
        <span class="quota-hint">{{ QUOTA_SERVER_URL }}</span>
      </div>
      <div v-else class="quota-status checking">
        <span>⏳ 正在检测服务器状态...</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.quota-panel {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 3rem 1.25rem;
}

.quota-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  max-width: 420px;
  width: 100%;
  padding: 2.5rem 2rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  text-align: center;
}

.quota-icon {
  font-size: 3rem;
  line-height: 1;
}

.quota-title {
  margin: 0;
  font-size: 1.2rem;
  font-weight: 700;
  color: var(--text);
}

.quota-desc {
  margin: 0;
  font-size: 0.85rem;
  color: var(--muted);
  line-height: 1.5;
}

.quota-open-btn {
  margin-top: 0.5rem;
  padding: 0.75rem 2rem;
  border-radius: 10px;
  border: none;
  background: var(--primary);
  color: var(--on-primary);
  font-size: 1rem;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.1s;
}

.quota-open-btn:hover {
  opacity: 0.88;
}

.quota-open-btn:active {
  transform: scale(0.97);
}

.quota-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin-top: 0.75rem;
  padding: 0.6rem 1rem;
  border-radius: 8px;
  font-size: 0.8rem;
  width: 100%;
}

.quota-status.online {
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.25);
  color: #22c55e;
}

.quota-status.offline {
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.25);
  color: #f59e0b;
}

.quota-status.checking {
  background: var(--bg, #111);
  border: 1px solid var(--border);
  color: var(--muted);
}

.quota-hint {
  font-size: 0.72rem;
  opacity: 0.8;
}

.quota-hint code {
  background: var(--bg, #111);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.72rem;
}

.quota-retry-btn {
  margin-top: 4px;
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid rgba(245, 158, 11, 0.4);
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  cursor: pointer;
  font-size: 0.75rem;
  transition: background 0.15s;
}

.quota-retry-btn:hover:not(:disabled) {
  background: rgba(245, 158, 11, 0.25);
}

.quota-retry-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
