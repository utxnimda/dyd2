<script setup lang="ts">
import { reactive, watch } from "vue";
import type { StoredSettings } from "../settings";
import { defaultSettings, saveSettings } from "../settings";
import { THEME_PRESETS, type ThemePresetId } from "../lib/themePresets";

const props = defineProps<{ modelValue: StoredSettings }>();
const emit = defineEmits<{
  "update:modelValue": [v: StoredSettings];
  apply: [];
}>();

const form = reactive<StoredSettings>({ ...props.modelValue });

const releaseLabel = import.meta.env.VITE_APP_RELEASE_LABEL as string | undefined;

const themeOptions: Array<{ value: ThemePresetId; label: string; hint?: string }> = [
  ...THEME_PRESETS.map((p) => ({
    value: p.id as ThemePresetId,
    label: p.label,
    hint: p.hint,
  })),
  { value: "custom", label: "自定义（背景 + 字色）" },
];

watch(
  () => props.modelValue,
  (v) => Object.assign(form, v),
  { deep: true },
);

function reset() {
  Object.assign(form, defaultSettings());
}

function syncToParent() {
  emit("update:modelValue", { ...form });
}

function onThemePresetChange() {
  if (form.themePreset !== "custom") {
    const p = THEME_PRESETS.find((x) => x.id === form.themePreset);
    if (p) {
      form.backgroundColor = p.vars.bg;
      form.textColor = p.vars.text;
    }
  }
  syncToParent();
}

/** 将 #rgb 规范为 #rrggbb */
function normalizeHexKey(key: "backgroundColor" | "textColor") {
  let h = String(form[key] || "").trim();
  if (!h.startsWith("#")) h = "#" + h;
  if (/^#[0-9A-Fa-f]{3}$/i.test(h)) {
    const r = h[1],
      g = h[2],
      b = h[3];
    h = ("#" + r + r + g + g + b + b).toLowerCase();
  }
  if (/^#[0-9A-Fa-f]{6}$/i.test(h)) {
    form[key] = h.toLowerCase();
    syncToParent();
  }
}

function normalizeBackground() {
  normalizeHexKey("backgroundColor");
}

function normalizeTextColor() {
  normalizeHexKey("textColor");
}

function save() {
  normalizeBackground();
  normalizeTextColor();
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
      <label class="wide theme-label">
        配色方案
        <select
          v-model="form.themePreset"
          class="theme-select"
          @change="onThemePresetChange"
        >
          <option
            v-for="opt in themeOptions"
            :key="opt.value"
            :value="opt.value"
            :title="opt.hint || opt.label"
          >
            {{ opt.label }}
          </option>
        </select>
      </label>
      <label>
        页面背景色
        <span class="color-row">
          <input
            v-model="form.backgroundColor"
            type="color"
            class="color-swatch"
            title="选取颜色"
            :disabled="form.themePreset !== 'custom'"
            @input="syncToParent"
          />
          <input
            v-model="form.backgroundColor"
            type="text"
            class="color-hex"
            placeholder="#0f1419"
            pattern="^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$"
            maxlength="9"
            :disabled="form.themePreset !== 'custom'"
            @input="syncToParent"
            @change="normalizeBackground"
            @blur="normalizeBackground"
          />
        </span>
      </label>
      <label>
        主文字颜色
        <span class="color-row">
          <input
            v-model="form.textColor"
            type="color"
            class="color-swatch"
            title="正文与标题主色"
            :disabled="form.themePreset !== 'custom'"
            @input="syncToParent"
          />
          <input
            v-model="form.textColor"
            type="text"
            class="color-hex"
            placeholder="#e8eef7"
            pattern="^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$"
            maxlength="9"
            :disabled="form.themePreset !== 'custom'"
            @input="syncToParent"
            @change="normalizeTextColor"
            @blur="normalizeTextColor"
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
      切换配色会立即应用到全站 CSS 变量；点「保存并应用」写入本地，下次打开仍保留。预设已含背景、字色、边框与主按钮配色；选「自定义」可单独调背景与主文字色（次要色自动推导）。
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
.theme-label {
  min-width: min(100%, 420px);
}
.theme-select {
  padding: 0.45rem 0.6rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 0.85rem;
}
input {
  padding: 0.45rem 0.6rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
}
input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
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
  color: var(--on-primary);
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
