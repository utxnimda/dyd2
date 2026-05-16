<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, watch } from "vue";
import aiBotPortraitUrl from "../../image/BOT.jpg?url";
import {
  getEnabledPlugins,
  onPluginOpen,
  pluginPayloads,
  pluginPayloadVersion,
  type PluginDescriptor,
} from "../shared/plugins";

/** 刷新后恢复：开启的插件、浮窗位置/尺寸、最小化、AI 侧栏是否收起 */
const PLUGIN_HOST_LS_KEY = "fmz_plugin_host_state";

interface PersistedPluginHostState {
  v: 1;
  activeIds: string[];
  minimisedIds: string[];
  positions: Record<string, { x: number; y: number }>;
  sizes: Record<string, { w: number; h: number }>;
  aiSideDockHidden: boolean;
}

const plugins = getEnabledPlugins();

/** Plugins that use floating panel mode */
const floatPlugins = computed(() => plugins.filter((p) => (p.panelMode || "float") === "float"));
/** Plugins that use side panel mode */
const sidePlugins = computed(() => plugins.filter((p) => p.panelMode === "side"));

/** Which plugins are currently activated (panel visible) */
const activePlugins = reactive<Set<string>>(new Set());

/**
 * AI 侧栏：用户点「AI」圆钮可暂时收起侧栏（插件仍为 ON，便于再展开）。
 * 其他 side 模式插件若日后增加，默认可始终显示。
 */
const aiSideDockHidden = ref(false);

/** Which plugins are minimised (collapsed to a small bar) */
const minimised = reactive<Set<string>>(new Set());

/** Plugin menu open state */
const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);

/** Per-plugin drag position */
const positions = reactive<Record<string, { x: number; y: number }>>({});

/** Per-plugin size (persisted during resize) */
const sizes = reactive<Record<string, { w: number; h: number }>>({});

const resizeObservers = new Map<string, ResizeObserver>();
let persistReady = false;
let suppressPersist = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function enabledPluginIdSet(): Set<string> {
  return new Set(plugins.map((p) => p.id));
}

function clampPersistedPosition(x: number, y: number): { x: number; y: number } {
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(window.innerWidth - 100, x)),
    y: Math.max(margin, Math.min(window.innerHeight - 40, y)),
  };
}

function loadPluginHostPersistedState(): void {
  suppressPersist = true;
  try {
    const raw = localStorage.getItem(PLUGIN_HOST_LS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as Partial<PersistedPluginHostState>;
    if (data.v !== 1 || !Array.isArray(data.activeIds)) return;
    const ok = enabledPluginIdSet();

    activePlugins.clear();
    for (const id of data.activeIds) {
      if (ok.has(id)) activePlugins.add(id);
    }
    minimised.clear();
    for (const id of data.minimisedIds || []) {
      if (ok.has(id)) minimised.add(id);
    }

    aiSideDockHidden.value =
      !!data.aiSideDockHidden && activePlugins.has("ai-agent");

    for (const [id, pos] of Object.entries(data.positions || {})) {
      if (!ok.has(id) || !pos || typeof pos.x !== "number" || typeof pos.y !== "number") continue;
      positions[id] = clampPersistedPosition(pos.x, pos.y);
    }
    for (const [id, sz] of Object.entries(data.sizes || {})) {
      if (!ok.has(id) || !sz || typeof sz.w !== "number") continue;
      sizes[id] = {
        w: Math.max(380, Math.min(sz.w, window.innerWidth - 32)),
        h: Math.max(240, Math.min(typeof sz.h === "number" ? sz.h : 360, window.innerHeight - 48)),
      };
    }
  } catch {
    /* ignore */
  } finally {
    suppressPersist = false;
  }
}

function schedulePersistPluginHostState(): void {
  if (!persistReady || suppressPersist) return;
  if (saveTimer != null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const ok = enabledPluginIdSet();
      const payload: PersistedPluginHostState = {
        v: 1,
        activeIds: [...activePlugins].filter((id) => ok.has(id)),
        minimisedIds: [...minimised].filter((id) => ok.has(id)),
        positions: {},
        sizes: {},
        aiSideDockHidden: aiSideDockHidden.value,
      };
      for (const id of ok) {
        if (positions[id]) payload.positions[id] = { ...positions[id] };
        if (sizes[id]) payload.sizes[id] = { ...sizes[id] };
      }
      localStorage.setItem(PLUGIN_HOST_LS_KEY, JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }, 160);
}

function bindFloatPanelResizeObserver(id: string, el: unknown): void {
  resizeObservers.get(id)?.disconnect();
  resizeObservers.delete(id);
  if (!(el instanceof HTMLElement)) return;
  const ro = new ResizeObserver(() => {
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) return;
    sizes[id] = { w: Math.round(r.width), h: Math.round(r.height) };
    schedulePersistPluginHostState();
  });
  ro.observe(el);
  resizeObservers.set(id, ro);
  const r = el.getBoundingClientRect();
  if (r.width > 80 && r.height > 80) {
    sizes[id] = { w: Math.round(r.width), h: Math.round(r.height) };
  }
}

function defaultPos(idx: number) {
  // Position the panel on the right side so it doesn't cover the main content
  const panelW = Math.min(480, window.innerWidth - 40);
  return {
    x: Math.max(20, window.innerWidth - panelW - 20),
    y: Math.max(40, 60 + idx * 30),
  };
}

function togglePlugin(id: string) {
  if (activePlugins.has(id)) {
    activePlugins.delete(id);
    minimised.delete(id);
    if (id === "ai-agent") aiSideDockHidden.value = false;
  } else {
    activePlugins.add(id);
    minimised.delete(id);
    if (id === "ai-agent") aiSideDockHidden.value = false;
    if (!positions[id]) {
      const idx = plugins.findIndex((p) => p.id === id);
      positions[id] = defaultPos(idx >= 0 ? idx : 0);
    }
  }
  schedulePersistPluginHostState();
}

function minimisePlugin(id: string) {
  minimised.add(id);
  schedulePersistPluginHostState();
}

function restorePlugin(id: string) {
  minimised.delete(id);
  schedulePersistPluginHostState();
}

function closePlugin(id: string) {
  activePlugins.delete(id);
  minimised.delete(id);
  if (id === "ai-agent") aiSideDockHidden.value = false;
  schedulePersistPluginHostState();
}

/* ---- Drag logic ---- */
const dragging = ref<string | null>(null);
const dragOffset = ref({ x: 0, y: 0 });

function onDragStart(e: MouseEvent, id: string) {
  // Only left button
  if (e.button !== 0) return;
  dragging.value = id;
  const pos = positions[id] || defaultPos(0);
  dragOffset.value = { x: e.clientX - pos.x, y: e.clientY - pos.y };
  e.preventDefault();
}

function onDragMove(e: MouseEvent) {
  if (!dragging.value) return;
  const id = dragging.value;
  positions[id] = {
    x: Math.max(0, Math.min(window.innerWidth - 100, e.clientX - dragOffset.value.x)),
    y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragOffset.value.y)),
  };
}

function onDragEnd() {
  dragging.value = null;
  schedulePersistPluginHostState();
}

/* ---- Click outside to close menu ---- */
function onClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    menuOpen.value = false;
  }
}

/* ---- Plugin open event listener ---- */
let unsubPluginOpen: (() => void) | null = null;

watch(aiSideDockHidden, () => schedulePersistPluginHostState());

onMounted(() => {
  loadPluginHostPersistedState();
  persistReady = true;

  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", onDragEnd);
  document.addEventListener("mousedown", onClickOutside);

  // Listen for external plugin-open requests
  unsubPluginOpen = onPluginOpen((evt) => {
    const idx = plugins.findIndex((p) => p.id === evt.pluginId);
    if (idx < 0) return;
    // Store payload so the plugin component can read it
    if (evt.payload) {
      pluginPayloads.value = { ...pluginPayloads.value, [evt.pluginId]: { ...evt.payload, _ts: Date.now() } };
      pluginPayloadVersion.value++;
    }
    // Activate the plugin if not already active
    if (!activePlugins.has(evt.pluginId)) {
      activePlugins.add(evt.pluginId);
      minimised.delete(evt.pluginId);
      if (!positions[evt.pluginId]) {
        positions[evt.pluginId] = defaultPos(idx);
      }
    } else {
      // If minimised, restore it
      minimised.delete(evt.pluginId);
    }
    if (evt.pluginId === "ai-agent") aiSideDockHidden.value = false;
    schedulePersistPluginHostState();
  });

});
onUnmounted(() => {
  persistReady = false;
  if (saveTimer != null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  for (const ro of resizeObservers.values()) ro.disconnect();
  resizeObservers.clear();

  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);
  document.removeEventListener("mousedown", onClickOutside);
  unsubPluginOpen?.();
});

const hasPlugins = computed(() => plugins.length > 0);

/** Dedicated AI Agent plugin (for the standalone AI button) */
const aiAgentPlugin = computed(() => plugins.find((p) => p.id === "ai-agent") || null);
const isAiAgentActive = computed(() => activePlugins.has("ai-agent"));
/** 侧栏实际挂在 App.vue 上：开启插件且用户未收起 */
const isAiSidePanelOpen = computed(
  () => isAiAgentActive.value && aiAgentPlugin.value?.panelMode === "side" && !aiSideDockHidden.value,
);

function toggleAiSidePanel() {
  if (!activePlugins.has("ai-agent")) {
    activePlugins.add("ai-agent");
    minimised.delete("ai-agent");
    aiSideDockHidden.value = false;
    const idx = plugins.findIndex((p) => p.id === "ai-agent");
    if (idx >= 0 && !positions["ai-agent"]) positions["ai-agent"] = defaultPos(idx);
    schedulePersistPluginHostState();
    return;
  }
  aiSideDockHidden.value = !aiSideDockHidden.value;
  schedulePersistPluginHostState();
}

const activeFloatList = computed(() =>
  floatPlugins.value.filter((p) => activePlugins.has(p.id)),
);

const activeSidePlugin = computed<PluginDescriptor | null>(() =>
  sidePlugins.value.find((p) => activePlugins.has(p.id)) || null,
);

/** 计入「用户收起侧栏」后，交给 App.vue 决定是否渲染 aside */
const visibleSidePlugin = computed<PluginDescriptor | null>(() => {
  const p = activeSidePlugin.value;
  if (!p) return null;
  if (p.id === "ai-agent" && aiSideDockHidden.value) return null;
  return p;
});

/** Expose side panel state so App.vue can render it inline */
defineExpose({ activeSidePlugin, visibleSidePlugin, closePlugin });
</script>

<template>
  <!-- Standalone AI Agent circle button (only shown when AI plugin is toggled ON in plugin menu) -->
  <button
    v-if="isAiAgentActive"
    type="button"
    class="ai-circle-btn"
    :class="{ open: isAiSidePanelOpen }"
    title="展开 / 收起 AI 侧栏"
    @click="toggleAiSidePanel"
  >
    <img class="ai-circle-btn-img" :src="aiBotPortraitUrl" alt="" />
  </button>

  <!-- Plugin trigger button (sits in header bar) -->
  <div v-if="hasPlugins" ref="menuRef" class="plugin-wrapper">
    <button
      type="button"
      class="plugin-btn"
      :class="{ active: menuOpen }"
      title="插件"
      @click="menuOpen = !menuOpen"
    >
      🧩
    </button>

    <!-- Plugin menu dropdown -->
    <Transition name="pmenu">
      <div v-if="menuOpen" class="plugin-menu">
        <div class="plugin-menu-title">插件</div>
        <div
          v-for="p in plugins"
          :key="p.id"
          class="plugin-menu-item"
          @click="togglePlugin(p.id)"
        >
          <img
            v-if="p.iconUrl"
            :src="p.iconUrl"
            class="plugin-icon plugin-icon-img"
            alt=""
          />
          <span v-else class="plugin-icon">{{ p.icon }}</span>
          <div class="plugin-menu-item-text">
            <span class="plugin-label">{{ p.label }}</span>
            <span class="plugin-desc">{{ p.description }}</span>
          </div>
          <span class="plugin-toggle" :class="{ on: activePlugins.has(p.id) }">
            {{ activePlugins.has(p.id) ? "ON" : "OFF" }}
          </span>
        </div>
        <div v-if="plugins.length === 0" class="plugin-empty">暂无可用插件</div>
      </div>
    </Transition>
  </div>

  <!-- Floating panels (teleported to body) -->
  <Teleport to="body">
    <!-- Minimised pills at bottom-right -->
    <div v-if="minimised.size > 0" class="plugin-minimised-bar">
      <button
        v-for="p in plugins.filter((pp) => minimised.has(pp.id))"
        :key="p.id"
        class="plugin-pill"
        @click="restorePlugin(p.id)"
      >
        <img
          v-if="p.iconUrl"
          :src="p.iconUrl"
          class="plugin-pill-icon"
          alt=""
        />
        <span v-else>{{ p.icon }}</span>
        {{ p.label }}
      </button>
    </div>

    <!-- Active floating panels (float mode) -->
    <Transition
      v-for="p in activeFloatList"
      :key="p.id"
      name="pfloat"
    >
      <div
        v-show="!minimised.has(p.id)"
        class="plugin-float"
        :ref="(el) => bindFloatPanelResizeObserver(p.id, el)"
        :style="{
          left: (positions[p.id]?.x ?? 100) + 'px',
          top: (positions[p.id]?.y ?? 80) + 'px',
          width: (sizes[p.id]?.w ?? 480) + 'px',
          ...(sizes[p.id]?.h ? { height: sizes[p.id]!.h + 'px' } : {}),
        }"
      >
        <div class="plugin-float-header" @mousedown="onDragStart($event, p.id)">
          <div class="plugin-float-header-left">
            <img
              v-if="p.iconUrl"
              :src="p.iconUrl"
              class="plugin-float-icon plugin-float-icon-img"
              alt=""
            />
            <span v-else class="plugin-float-icon">{{ p.icon }}</span>
            <div class="plugin-float-header-text">
              <span class="plugin-float-title">{{ p.label }}</span>
              <span class="plugin-float-desc">{{ p.description }}</span>
            </div>
          </div>
          <span class="plugin-float-actions">
            <button type="button" title="最小化" @click.stop="minimisePlugin(p.id)">─</button>
            <button type="button" title="关闭" @click.stop="closePlugin(p.id)">✕</button>
          </span>
        </div>
        <div class="plugin-float-body">
          <component :is="p.component!" />
        </div>
      </div>
    </Transition>

  </Teleport>
</template>

<style scoped>
/* ---- Standalone AI circle button ---- */
.ai-circle-btn {
  width: 36px;
  height: 36px;
  padding: 0;
  overflow: hidden;
  border-radius: 50%;
  border: 2px solid rgba(124, 77, 255, 0.5);
  background: linear-gradient(135deg, rgba(124, 77, 255, 0.12) 0%, rgba(77, 171, 255, 0.12) 100%);
  color: #a78bfa;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  position: relative;
  flex-shrink: 0;
}
.ai-circle-btn-img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  object-position: center 28%;
}
.ai-circle-btn:hover {
  border-color: rgba(124, 77, 255, 0.8);
  background: linear-gradient(135deg, rgba(124, 77, 255, 0.22) 0%, rgba(77, 171, 255, 0.22) 100%);
  color: #c4b5fd;
  transform: scale(1.08);
  box-shadow: 0 0 12px rgba(124, 77, 255, 0.3);
}
.ai-circle-btn.open {
  background: linear-gradient(135deg, #7c4dff 0%, #4dabff 100%);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 0 14px rgba(124, 77, 255, 0.4);
}
.ai-circle-btn.open:hover {
  color: #fff;
  box-shadow: 0 0 18px rgba(124, 77, 255, 0.55);
  transform: scale(1.08);
}

/* ---- Plugin menu trigger：与 AI 圆钮同款轮廓 ---- */
.plugin-wrapper {
  position: relative;
}
.plugin-btn {
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 50%;
  border: 2px solid rgba(124, 77, 255, 0.45);
  background: linear-gradient(
    135deg,
    rgba(124, 77, 255, 0.12) 0%,
    rgba(77, 171, 255, 0.12) 100%
  );
  color: #a78bfa;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  flex-shrink: 0;
}
.plugin-btn:hover {
  border-color: rgba(124, 77, 255, 0.85);
  background: linear-gradient(
    135deg,
    rgba(124, 77, 255, 0.22) 0%,
    rgba(77, 171, 255, 0.22) 100%
  );
  color: #c4b5fd;
  transform: scale(1.08);
  box-shadow: 0 0 12px rgba(124, 77, 255, 0.28);
}
.plugin-btn.active {
  background: linear-gradient(135deg, #7c4dff 0%, #4dabff 100%);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 0 14px rgba(124, 77, 255, 0.38);
}
.plugin-btn.active:hover {
  color: #fff;
  box-shadow: 0 0 18px rgba(124, 77, 255, 0.52);
  transform: scale(1.08);
}

/* ---- Dropdown menu ---- */
.plugin-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 1001;
  min-width: 220px;
  padding: 0.5rem 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}
.plugin-menu-title {
  padding: 0.35rem 1rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.plugin-menu-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.55rem 1rem;
  cursor: pointer;
  transition: background 0.12s;
}
.plugin-menu-item:hover {
  background: var(--bg);
}
.plugin-icon {
  font-size: 1.1rem;
  flex-shrink: 0;
}
.plugin-icon-img {
  width: 1.35rem;
  height: 1.35rem;
  border-radius: 6px;
  object-fit: cover;
  object-position: center 12%;
}
.plugin-pill-icon {
  width: 1rem;
  height: 1rem;
  border-radius: 4px;
  object-fit: cover;
  object-position: center 12%;
  flex-shrink: 0;
}
.plugin-menu-item-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.plugin-label {
  font-size: 0.85rem;
  color: var(--text);
  font-weight: 500;
}
.plugin-desc {
  font-size: 0.7rem;
  color: var(--muted);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.plugin-toggle {
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
  background: var(--bg);
  color: var(--muted);
  border: 1px solid var(--border);
}
.plugin-toggle.on {
  background: var(--primary);
  color: var(--on-primary);
  border-color: var(--primary);
}
.plugin-empty {
  padding: 0.75rem 1rem;
  font-size: 0.8rem;
  color: var(--muted);
}

/* Menu transition */
.pmenu-enter-active,
.pmenu-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.pmenu-enter-from,
.pmenu-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* ---- Floating panel ---- */
.plugin-float {
  position: fixed;
  z-index: 9000;
  width: 480px;
  max-width: calc(100vw - 32px);
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--surface);
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.28),
    0 2px 8px rgba(0, 0, 0, 0.12);
  overflow: hidden;
  resize: both;
  min-width: 380px;
  min-height: 240px;
  backdrop-filter: blur(12px);
}
.plugin-float-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0.85rem;
  background: linear-gradient(180deg, rgba(255,255,255,0.04) 0%, transparent 100%);
  border-bottom: 1px solid var(--border);
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
  gap: 0.5rem;
}
.plugin-float-header:active {
  cursor: grabbing;
}
.plugin-float-header-left {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
}
.plugin-float-icon {
  font-size: 1.3rem;
  flex-shrink: 0;
  line-height: 1;
}
.plugin-float-icon-img {
  width: 1.55rem;
  height: 1.55rem;
  border-radius: 6px;
  object-fit: cover;
  object-position: center 12%;
}
.plugin-float-header-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.plugin-float-title {
  font-size: 0.88rem;
  font-weight: 700;
  color: var(--text);
  line-height: 1.2;
}
.plugin-float-desc {
  font-size: 0.72rem;
  color: var(--muted);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.plugin-float-actions {
  display: flex;
  gap: 0.3rem;
  flex-shrink: 0;
}
.plugin-float-actions button {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted);
  font-size: 0.8rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.plugin-float-actions button:hover {
  background: var(--bg);
  color: var(--text);
  border-color: var(--border);
}
.plugin-float-actions button:last-child:hover {
  color: #ff6b6b;
  border-color: rgba(255, 107, 107, 0.4);
}
.plugin-float-body {
  flex: 1;
  overflow: auto;
  padding: 0;
}

/* Float panel transition */
.pfloat-enter-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.pfloat-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.pfloat-enter-from {
  opacity: 0;
  transform: scale(0.92) translateY(8px);
}
.pfloat-leave-to {
  opacity: 0;
  transform: scale(0.95) translateY(4px);
}



/* ---- Minimised pills ---- */
.plugin-minimised-bar {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 9001;
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.plugin-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.45rem 1rem;
  border-radius: 22px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22);
  transition: background 0.15s, transform 0.15s, box-shadow 0.15s;
  animation: pill-pop 0.25s ease;
}
.plugin-pill:hover {
  background: var(--bg);
  transform: translateY(-3px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
}
@keyframes pill-pop {
  from { opacity: 0; transform: translateY(8px) scale(0.9); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
