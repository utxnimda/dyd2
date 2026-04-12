<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  provide,
  ref,
  watch,
} from "vue";
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
import {
  formatAppHash,
  parseAppHash,
  replaceAppHash,
  type MainTab,
  type PrePanelTab,
} from "./lib/appRoute";
import {
  formatBattleShowPath,
  loadBattleShowFromStorage,
} from "./lib/battleShowRoute";
import {
  FMZ_TREASURY_AVATAR_KEY,
  type TreasuryAvatarBridge,
} from "./lib/treasuryAvatarOpen";

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
const tab = ref<MainTab>("pre");
const prePanelTab = ref<PrePanelTab>("total");

/** 战斗爽展示筛选路径段（#/battle/<此段>），刷新后由 hash 或 localStorage 恢复 */
const battleShowPath = ref(formatBattleShowPath(loadBattleShowFromStorage()));

const captainHudOnly = ref(false);
function refreshDocTitle() {
  const suffix = FMZ_RELEASE_LABEL ? ` ${FMZ_RELEASE_LABEL}` : "";
  if (captainHudOnly.value) document.title = `战斗爽${suffix}`;
  else document.title = `伐木训练营数据面板${suffix}`;
}

function applyHashToState() {
  if (typeof window === "undefined") return;
  const parsed = parseAppHash(window.location.hash);
  if (parsed.kind === "captain-hud") {
    captainHudOnly.value = true;
  } else {
    captainHudOnly.value = false;
    tab.value = parsed.tab;
    prePanelTab.value = parsed.prePanel;
    if (parsed.tab === "battle") {
      let seg = parsed.battleShowPath;
      if (!seg) {
        seg = formatBattleShowPath(loadBattleShowFromStorage());
        replaceAppHash(formatAppHash(false, "battle", "total", seg));
      }
      battleShowPath.value = seg;
    }
  }
  refreshDocTitle();
}

function syncHashFromState() {
  if (typeof window === "undefined") return;
  replaceAppHash(
    formatAppHash(
      captainHudOnly.value,
      tab.value,
      prePanelTab.value,
      tab.value === "battle" ? battleShowPath.value : null,
    ),
  );
}

function onBattleShowPath(next: string) {
  battleShowPath.value = next;
  if (tab.value === "battle") syncHashFromState();
}

function selectTab(next: MainTab) {
  captainHudOnly.value = false;
  tab.value = next;
  syncHashFromState();
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
const battleRef = ref<InstanceType<typeof CaptainCornersHud> | null>(null);
const treRef = ref<InstanceType<typeof TreasuryPanel> | null>(null);

async function openTreasuryDetailFromAvatar(memberId: string | number | null | undefined) {
  if (memberId == null || String(memberId).trim() === "") return;
  let tre = treRef.value;
  if (!tre) return;
  if (!tre.isTreasuryMember(memberId)) {
    await tre.reload();
    await nextTick();
    tre = treRef.value;
  }
  if (!tre?.isTreasuryMember?.(memberId)) return;
  await tre.openCard(memberId);
}

const treasuryAvatarBridge: TreasuryAvatarBridge = {
  openIfMember(memberId) {
    void openTreasuryDetailFromAvatar(memberId);
  },
};
provide(FMZ_TREASURY_AVATAR_KEY, treasuryAvatarBridge);

function onApply() {
  if (tab.value === "pre") preRef.value?.load();
  if (tab.value === "users") usrRef.value?.reload();
  if (tab.value === "battle") battleRef.value?.reload();
  if (tab.value === "treasury") treRef.value?.reload();
}

function loadActivePanel() {
  if (captainHudOnly.value) return;
  if (tab.value === "pre") preRef.value?.load();
  if (tab.value === "users") usrRef.value?.reload();
  if (tab.value === "battle") battleRef.value?.reload();
  if (tab.value === "treasury") treRef.value?.reload();
}

function onWindowHashChange() {
  applyHashToState();
  loadActivePanel();
}

onMounted(() => {
  applyHashToState();
  if (
    typeof window !== "undefined" &&
    !captainHudOnly.value &&
    (!window.location.hash || window.location.hash === "#")
  ) {
    replaceAppHash(
      formatAppHash(
        false,
        tab.value,
        prePanelTab.value,
        tab.value === "battle" ? battleShowPath.value : null,
      ),
    );
  }
  window.addEventListener("hashchange", onWindowHashChange);
  applyTheme();
  loadActivePanel();
});

onUnmounted(() => {
  window.removeEventListener("hashchange", onWindowHashChange);
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

watch(tab, (t, prev) => {
  if (captainHudOnly.value) return;
  if (t === "users") usrRef.value?.reload();
  if (t === "battle") battleRef.value?.reload();
  if (t === "treasury") treRef.value?.reload();
  if (t === "pre" && prev !== "pre") preRef.value?.load();
  syncHashFromState();
});

watch(prePanelTab, () => {
  if (captainHudOnly.value || tab.value !== "pre") return;
  syncHashFromState();
});
</script>

<template>
  <CaptainCornersHud
    v-if="captainHudOnly"
    class="standalone-hud"
    :config="clientConfig"
    :poll-ms="3500"
    :sync-battle-show-to-hash="false"
  />
  <template v-else>
  <SettingsBar v-model="settings" @apply="onApply" />
  <nav class="nav">
    <button :class="{ on: tab === 'pre' }" type="button" @click="selectTab('pre')">预赛数据</button>
    <button :class="{ on: tab === 'users' }" type="button" @click="selectTab('users')">用户积分</button>
    <button :class="{ on: tab === 'treasury' }" type="button" @click="selectTab('treasury')">团员金库</button>
    <button :class="{ on: tab === 'battle' }" type="button" @click="selectTab('battle')">战斗爽</button>
  </nav>
  <main>
    <PreliminaryPanel
      v-show="tab === 'pre'"
      ref="preRef"
      v-model:panel-tab="prePanelTab"
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
    <CaptainCornersHud
      v-if="tab === 'battle'"
      ref="battleRef"
      class="panel-hud"
      :config="clientConfig"
      :poll-ms="4000"
      :battle-show-path="battleShowPath"
      @update:battle-show-path="onBattleShowPath"
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
.panel-hud {
  margin: 0.75rem 1.25rem 0;
}
.standalone-hud {
  max-width: 520px;
  margin: 0.75rem auto;
  padding: 0 0.75rem;
}
</style>
