<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref, watch } from "vue";
import SettingsBar from "./components/SettingsBar.vue";
import CaptainCornersHud from "./components/CaptainCornersHud.vue";
import PreliminaryPanel from "./components/PreliminaryPanel.vue";
import UsersPanel from "./components/UsersPanel.vue";
import TreasuryPanel from "./components/TreasuryPanel.vue";
import { FMZ_RELEASE_LABEL } from "./buildInfo";
import {
  FMZ_REACTIONS_CLIENT_KEY,
  loadMemberVotesFromServer,
  reactionsClientFromSettings,
} from "./lib/memberLikes";
import { loadSettings, toClientConfig, type StoredSettings } from "./settings";
import {
  applyThemeVarsToDocument,
  deriveCustomTheme,
  presetVars,
  type ThemePresetId,
} from "./lib/themePresets";

const settings = ref<StoredSettings>(loadSettings());

function applyTheme() {
  const s = settings.value;
  if (s.themePreset === "custom") {
    let rawBg = (s.backgroundColor || "#0f1419").trim();
    let rawTx = (s.textColor || "#e8eef7").trim();
    if (!rawBg.startsWith("#")) rawBg = "#" + rawBg;
    if (!rawTx.startsWith("#")) rawTx = "#" + rawTx;
    const okBg = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(rawBg);
    const okTx = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(rawTx);
    applyThemeVarsToDocument(
      deriveCustomTheme(
        okBg ? rawBg : "#0f1419",
        okTx ? rawTx : "#e8eef7",
      ),
    );
  } else {
    applyThemeVarsToDocument(
      presetVars(s.themePreset as Exclude<ThemePresetId, "custom">),
    );
  }
}
const tab = ref<"pre" | "users" | "treasury">("pre");

const captainHudOnly = ref(false);
function refreshDocTitle() {
  const suffix = FMZ_RELEASE_LABEL ? ` ${FMZ_RELEASE_LABEL}` : "";
  if (captainHudOnly.value) document.title = `金库看板${suffix}`;
  else document.title = `伐木训练营数据面板${suffix}`;
}

function syncCaptainHudHash() {
  captainHudOnly.value =
    typeof window !== "undefined" && window.location.hash === "#captain-hud";
  refreshDocTitle();
}

const clientConfig = computed(() => toClientConfig(settings.value));

const reactionsClient = computed(() => reactionsClientFromSettings(settings.value));
provide(FMZ_REACTIONS_CLIENT_KEY, reactionsClient);

watch(
  reactionsClient,
  (ctx) => {
    void loadMemberVotesFromServer(ctx);
  },
  { deep: true, immediate: true },
);

const preRef = ref<InstanceType<typeof PreliminaryPanel> | null>(null);
const usrRef = ref<InstanceType<typeof UsersPanel> | null>(null);
const treRef = ref<InstanceType<typeof TreasuryPanel> | null>(null);

function onApply() {
  if (tab.value === "pre") preRef.value?.load();
  if (tab.value === "users") usrRef.value?.reload();
  if (tab.value === "treasury") treRef.value?.reload();
}

onMounted(() => {
  syncCaptainHudHash();
  window.addEventListener("hashchange", syncCaptainHudHash);
  applyTheme();
  if (!captainHudOnly.value) preRef.value?.load();
});

onUnmounted(() => {
  window.removeEventListener("hashchange", syncCaptainHudHash);
});

watch(
  () => ({
    p: settings.value.themePreset,
    bg: settings.value.backgroundColor,
    tx: settings.value.textColor,
  }),
  () => applyTheme(),
  { deep: true },
);

watch(tab, (t) => {
  if (t === "users") usrRef.value?.reload();
  if (t === "treasury") treRef.value?.reload();
});
</script>

<template>
  <CaptainCornersHud
    v-if="captainHudOnly"
    class="standalone-hud"
    :config="clientConfig"
    :poll-ms="3500"
  />
  <template v-else>
  <SettingsBar v-model="settings" @apply="onApply" />
  <nav class="nav">
    <button :class="{ on: tab === 'pre' }" type="button" @click="tab = 'pre'">预赛数据</button>
    <button :class="{ on: tab === 'users' }" type="button" @click="tab = 'users'">用户积分</button>
    <button :class="{ on: tab === 'treasury' }" type="button" @click="tab = 'treasury'">团员金库</button>
  </nav>
  <main>
    <CaptainCornersHud
      v-if="tab === 'treasury'"
      class="treasury-hud"
      :config="clientConfig"
      :poll-ms="4000"
    />
    <PreliminaryPanel
      v-show="tab === 'pre'"
      ref="preRef"
      :config="clientConfig"
    />
    <UsersPanel
      v-show="tab === 'users'"
      ref="usrRef"
      :config="clientConfig"
    />
    <TreasuryPanel
      v-show="tab === 'treasury'"
      ref="treRef"
      :config="clientConfig"
    />
  </main>
  </template>
</template>

<style scoped>
.nav {
  display: flex;
  gap: 0.25rem;
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.nav button {
  padding: 0.5rem 1.1rem;
  border-radius: 10px 10px 0 0;
  border: 1px solid transparent;
  border-bottom: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-weight: 600;
}
.nav button.on {
  background: var(--surface);
  color: var(--primary);
  border-color: var(--border);
}
main {
  max-width: 1200px;
  margin: 0 auto;
}
.treasury-hud {
  margin: 0.75rem 1.25rem 0;
}
.standalone-hud {
  max-width: 520px;
  margin: 0.75rem auto;
  padding: 0 0.75rem;
}
</style>
