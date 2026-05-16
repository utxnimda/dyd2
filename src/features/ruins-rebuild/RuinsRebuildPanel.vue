<script setup lang="ts">
import { computed } from "vue";
import type { RuinsPanelTab } from "../../shared/appRoute";
import { RUINS_PANEL_HTML } from "./iframePages";

const panelTab = defineModel<RuinsPanelTab>("panelTab", { default: "hub" });

const iframeSrc = computed(() => {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, "/");
  return `${base}ruins-rebuild/${RUINS_PANEL_HTML[panelTab.value]}`;
});
</script>

<template>
  <div class="ruins-wrap">
    <div class="ruins-subview" role="tablist" aria-label="废墟重建计划子页面">
      <button
        :class="{ on: panelTab === 'hub' }"
        type="button"
        role="tab"
        :aria-selected="panelTab === 'hub'"
        @click="panelTab = 'hub'"
      >
        首页
      </button>
      <button
        :class="{ on: panelTab === 'playlist' }"
        type="button"
        role="tab"
        :aria-selected="panelTab === 'playlist'"
        @click="panelTab = 'playlist'"
      >
        忽闻宝声
      </button>
      <button
        :class="{ on: panelTab === 'treasures' }"
        type="button"
        role="tab"
        :aria-selected="panelTab === 'treasures'"
        @click="panelTab = 'treasures'"
      >
        视若珍宝
      </button>
      <button
        :class="{ on: panelTab === 'awards' }"
        type="button"
        role="tab"
        :aria-selected="panelTab === 'awards'"
        @click="panelTab = 'awards'"
      >
        中军帐下
      </button>
      <button
        :class="{ on: panelTab === 'admin' }"
        type="button"
        role="tab"
        :aria-selected="panelTab === 'admin'"
        @click="panelTab = 'admin'"
      >
        管理
      </button>
    </div>
    <iframe
      :key="iframeSrc"
      class="ruins-frame"
      title="废墟重建计划（调试）"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      :src="iframeSrc"
    />
  </div>
</template>

<style scoped>
.ruins-wrap {
  display: flex;
  flex-direction: column;
  min-height: min(85vh, 900px);
  height: calc(100vh - 200px);
}
/* 与预赛子导航一致：下划线分段 */
.ruins-subview {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  margin: 0 0 0.75rem;
  padding: 0;
  border-bottom: 1px solid var(--border);
  max-width: 100%;
  flex-shrink: 0;
}
.ruins-subview button {
  margin: 0;
  padding: 0.45rem 0.65rem 0.5rem;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  border-radius: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 600;
}
.ruins-subview button.on {
  color: var(--text);
  border-bottom-color: var(--primary);
  background: color-mix(in srgb, var(--surface) 55%, transparent);
}
.ruins-subview button:hover:not(.on) {
  color: var(--text);
  background: color-mix(in srgb, var(--surface) 35%, transparent);
}
.ruins-frame {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
}
</style>
