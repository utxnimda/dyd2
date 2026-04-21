<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed } from "vue";
import { getEnabledPlugins, type PluginDescriptor } from "../shared/plugins";

const plugins = getEnabledPlugins();

/** Which plugins are currently activated (panel visible) */
const activePlugins = reactive<Set<string>>(new Set());

/** Which plugins are minimised (collapsed to a small bar) */
const minimised = reactive<Set<string>>(new Set());

/** Plugin menu open state */
const menuOpen = ref(false);
const menuRef = ref<HTMLElement | null>(null);

/** Per-plugin drag position */
const positions = reactive<Record<string, { x: number; y: number }>>({});

function defaultPos(idx: number) {
  return { x: window.innerWidth - 420, y: 80 + idx * 40 };
}

function togglePlugin(id: string) {
  if (activePlugins.has(id)) {
    activePlugins.delete(id);
    minimised.delete(id);
  } else {
    activePlugins.add(id);
    minimised.delete(id);
    if (!positions[id]) {
      const idx = plugins.findIndex((p) => p.id === id);
      positions[id] = defaultPos(idx >= 0 ? idx : 0);
    }
  }
}

function minimisePlugin(id: string) {
  minimised.add(id);
}

function restorePlugin(id: string) {
  minimised.delete(id);
}

function closePlugin(id: string) {
  activePlugins.delete(id);
  minimised.delete(id);
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
}

/* ---- Click outside to close menu ---- */
function onClickOutside(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    menuOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", onDragEnd);
  document.addEventListener("mousedown", onClickOutside);
});
onUnmounted(() => {
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);
  document.removeEventListener("mousedown", onClickOutside);
});

const hasPlugins = computed(() => plugins.length > 0);

const activeList = computed(() =>
  plugins.filter((p) => activePlugins.has(p.id)),
);
</script>

<template>
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
          <span class="plugin-icon">{{ p.icon }}</span>
          <span class="plugin-label">{{ p.label }}</span>
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
        {{ p.icon }} {{ p.label }}
      </button>
    </div>

    <!-- Active floating panels -->
    <div
      v-for="p in activeList"
      v-show="!minimised.has(p.id)"
      :key="p.id"
      class="plugin-float"
      :style="{
        left: (positions[p.id]?.x ?? 100) + 'px',
        top: (positions[p.id]?.y ?? 80) + 'px',
      }"
    >
      <div class="plugin-float-header" @mousedown="onDragStart($event, p.id)">
        <span class="plugin-float-title">{{ p.icon }} {{ p.label }}</span>
        <span class="plugin-float-actions">
          <button type="button" title="最小化" @click.stop="minimisePlugin(p.id)">─</button>
          <button type="button" title="关闭" @click.stop="closePlugin(p.id)">✕</button>
        </span>
      </div>
      <div class="plugin-float-body">
        <component :is="p.component!" />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* ---- Trigger button (same style as gear button) ---- */
.plugin-wrapper {
  position: relative;
}
.plugin-btn {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 1.1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, color 0.15s;
}
.plugin-btn:hover,
.plugin-btn.active {
  background: var(--bg);
  color: var(--primary);
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
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  cursor: pointer;
  transition: background 0.12s;
}
.plugin-menu-item:hover {
  background: var(--bg);
}
.plugin-icon {
  font-size: 1rem;
}
.plugin-label {
  flex: 1;
  font-size: 0.85rem;
  color: var(--text);
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
  width: 400px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--surface);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  overflow: hidden;
  resize: both;
  min-width: 320px;
  min-height: 200px;
}
.plugin-float-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
}
.plugin-float-header:active {
  cursor: grabbing;
}
.plugin-float-title {
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--text);
}
.plugin-float-actions {
  display: flex;
  gap: 0.25rem;
}
.plugin-float-actions button {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 0.75rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s, color 0.12s;
}
.plugin-float-actions button:hover {
  background: var(--bg);
  color: var(--text);
}
.plugin-float-body {
  flex: 1;
  overflow: auto;
  padding: 0.75rem;
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
  padding: 0.4rem 0.85rem;
  border-radius: 20px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  transition: background 0.12s, transform 0.12s;
}
.plugin-pill:hover {
  background: var(--bg);
  transform: translateY(-2px);
}
</style>
