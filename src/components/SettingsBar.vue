<script setup lang="ts">
import { reactive, ref, watch, onMounted, onUnmounted } from "vue";
import type { StoredSettings } from "../shared/settings";
import { defaultSettings, saveSettings } from "../shared/settings";
import { FMZ_RELEASE_LABEL } from "../shared/buildInfo";
import { THEME_PRESETS, type ThemePresetId } from "../shared/themePresets";

const props = defineProps<{ modelValue: StoredSettings }>();
const emit = defineEmits<{
  "update:modelValue": [v: StoredSettings];
  apply: [];
}>();

const form = reactive<StoredSettings>({ ...props.modelValue });

const themeOptions: Array<{ value: ThemePresetId; label: string; hint?: string }> = [
  ...THEME_PRESETS.map((p) => ({
    value: p.id as ThemePresetId,
    label: p.label,
    hint: p.hint,
  })),
  { value: "custom", label: "自定义（背景 + 字色）" },
];

/** Dropdown open state */
const open = ref(false);
const dropdownRef = ref<HTMLElement | null>(null);

function toggleDropdown() {
  open.value = !open.value;
}

function onClickOutside(e: MouseEvent) {
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    open.value = false;
  }
}

onMounted(() => {
  document.addEventListener("mousedown", onClickOutside);
});
onUnmounted(() => {
  document.removeEventListener("mousedown", onClickOutside);
});

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

/** Normalize #rgb → #rrggbb */
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
  open.value = false;
}

function toggleBaobaoMode() {
  form.baobaoMode = !form.baobaoMode;
  saveSettings({ ...form });
  emit("update:modelValue", { ...form });
}
</script>

<template>
  <header class="bar">
    <div class="brand-row">
      <div class="brand">
机器猫的百宝箱
        <span v-if="FMZ_RELEASE_LABEL" class="release" :title="`构建 ${FMZ_RELEASE_LABEL}`">{{
          FMZ_RELEASE_LABEL
        }}</span>
      </div>

      <!-- Extra action buttons (e.g. plugin host) -->
      <div class="header-actions">
        <slot name="extra-actions" />

      <!-- Baobao mode toggle -->
      <button
        v-if="form.baobaoMode !== undefined"
        type="button"
        class="baobao-toggle"
        :class="{ active: form.baobaoMode }"
        title="宝宝版开关 — 开启后显示宝宝魅力时刻等专属功能"
        @click="toggleBaobaoMode"
      >
        {{ form.baobaoMode ? '👶 宝宝版' : '👶' }}
      </button>

      <!-- Gear icon to toggle settings dropdown -->
      <div ref="dropdownRef" class="dropdown-wrapper">
        <button
          type="button"
          class="gear-btn"
          :class="{ active: open }"
          title="配色设置"
          @click="toggleDropdown"
        >
          ⚙
        </button>

        <Transition name="dropdown">
          <div v-if="open" class="dropdown-panel">
            <div class="grid">
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
              切换配色会立即生效；点「保存并应用」写入本地。选「自定义」可单独调背景与主文字色（次要色自动推导）。
            </p>
          </div>
        </Transition>
      </div>
      </div><!-- end .header-actions -->
    </div>
  </header>
</template>

<style scoped>
.bar {
  padding: 0.5rem 1.25rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}
.brand-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.brand {
  font-weight: 700;
  font-size: 1.1rem;
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

/* Header actions row */
.header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

/* Baobao mode toggle */
.baobao-toggle {
  height: 36px;
  padding: 0 0.7rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 0.85rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.3rem;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
  white-space: nowrap;
}
.baobao-toggle:hover {
  background: var(--bg);
  color: var(--text);
}
.baobao-toggle.active {
  background: rgba(236, 72, 153, 0.15);
  color: #ec4899;
  border-color: rgba(236, 72, 153, 0.4);
}

/* Gear button */
.gear-btn {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 1.2rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}
.gear-btn:hover,
.gear-btn.active {
  background: var(--bg);
  color: var(--primary);
}

/* Dropdown wrapper */
.dropdown-wrapper {
  position: relative;
}

/* Dropdown panel */
.dropdown-panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 1000;
  min-width: 340px;
  max-width: 480px;
  padding: 1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}

/* Dropdown transition */
.dropdown-enter-active,
.dropdown-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.grid {
  display: grid;
  grid-template-columns: 1fr;
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
  min-width: 0;
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
