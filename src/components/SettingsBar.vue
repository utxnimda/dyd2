<script setup lang="ts">
import { reactive, watch } from "vue";
import type { StoredSettings } from "../settings";
import { defaultSettings, saveSettings } from "../settings";

const props = defineProps<{ modelValue: StoredSettings }>();
const emit = defineEmits<{
  "update:modelValue": [v: StoredSettings];
  apply: [];
}>();

const form = reactive<StoredSettings>({ ...props.modelValue });

const releaseLabel = import.meta.env.VITE_APP_RELEASE_LABEL as string | undefined;

watch(
  () => props.modelValue,
  (v) => Object.assign(form, v),
  { deep: true },
);

function reset() {
  Object.assign(form, defaultSettings());
}

function syncBgToParent() {
  emit("update:modelValue", { ...form });
}

/** 将 #rgb 规范为 #rrggbb，便于 color input 识别 */
function normalizeHex() {
  let h = String(form.backgroundColor || "").trim();
  if (!h.startsWith("#")) h = "#" + h;
  if (/^#[0-9A-Fa-f]{3}$/i.test(h)) {
    const r = h[1],
      g = h[2],
      b = h[3];
    h = ("#" + r + r + g + g + b + b).toLowerCase();
  }
  if (/^#[0-9A-Fa-f]{6}$/i.test(h)) {
    form.backgroundColor = h.toLowerCase();
    syncBgToParent();
  }
}

function save() {
  normalizeHex();
  saveSettings({ ...form });
  emit("update:modelValue", { ...form });
  emit("apply");
}
</script>

<template>
  <header class="bar">
    <div class="brand">
      伐木训练营 · 数据面板
      <span v-if="releaseLabel" class="release" :title="`构建 ${releaseLabel}`">{{ releaseLabel }}</span>
    </div>
    <div class="grid">
      <label>
        API 根路径
        <input v-model="form.apiBase" placeholder="/__fmz_api 或 https://..." />
      </label>
      <label>
        房间号 LIVE_ROOM
        <input v-model="form.liveRoom" />
      </label>
      <label>
        X-Project
        <input v-model="form.xProject" />
      </label>
      <label>
        积分比例 CURRENCY_PROPORTION
        <input v-model.number="form.currencyProportion" type="number" min="1" />
      </label>
      <label class="wide">
        Bearer Token
        <input v-model="form.bearerToken" type="password" autocomplete="off" placeholder="从已登录站点复制" />
      </label>
      <label>
        页面背景色
        <span class="color-row">
          <input
            v-model="form.backgroundColor"
            type="color"
            class="color-swatch"
            title="选取颜色"
            @input="syncBgToParent"
          />
          <input
            v-model="form.backgroundColor"
            type="text"
            class="color-hex"
            placeholder="#0f1419"
            pattern="^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$"
            maxlength="9"
            @input="syncBgToParent"
            @change="normalizeHex"
            @blur="normalizeHex"
          />
        </span>
      </label>
    </div>
    <div class="actions">
      <button type="button" class="ghost" @click="reset">恢复默认</button>
      <button type="button" class="primary" @click="save">保存并应用</button>
    </div>
    <p class="hint">
      开发模式请保持 API 为 <code>/__fmz_api</code> 以走 Vite 代理；生产环境需自行解决跨域或同域反代。
      背景色在选取后会立即生效；与其他设置一起点「保存并应用」可写入本地，下次打开仍保留。
    </p>
  </header>
</template>

<style scoped>
.bar {
  padding: 1rem 1.25rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.brand {
  font-weight: 700;
  font-size: 1.1rem;
  margin-bottom: 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.brand .release {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--muted);
  padding: 0.12rem 0.45rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 0.75rem;
}
label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--muted);
}
label.wide {
  grid-column: 1 / -1;
}
input {
  padding: 0.45rem 0.6rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
}
.actions {
  margin-top: 0.75rem;
  display: flex;
  gap: 0.5rem;
}
button {
  padding: 0.45rem 1rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  cursor: pointer;
}
button.primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #0a1628;
  font-weight: 600;
}
button.ghost {
  background: transparent;
  color: var(--text);
}
.hint {
  margin: 0.5rem 0 0;
  font-size: 0.75rem;
  color: var(--muted);
}
code {
  color: var(--accent);
}
.color-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
input.color-swatch {
  width: 44px;
  height: 36px;
  padding: 2px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid var(--border);
}
input.color-hex {
  flex: 1;
  min-width: 0;
  max-width: 120px;
  font-family: ui-monospace, monospace;
}
</style>
