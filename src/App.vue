<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onMounted,
  onUnmounted,
  provide,
  ref,
  watch,
} from "vue";
import SettingsBar from "./components/SettingsBar.vue";
import PluginHost from "./components/PluginHost.vue";
import { FMZ_RELEASE_LABEL } from "./shared/buildInfo";
import {
  FMZ_REACTIONS_CLIENT_KEY,
  loadMemberVotesFromServer,
  reactionsClientFromSettings,
} from "./shared/memberLikes";
import { loadSettings, toClientConfig, type StoredSettings } from "./shared/settings";
import {
  applyThemeVarsToDocument,
  deriveCustomTheme,
  presetVars,
  type ThemePresetId,
} from "./shared/themePresets";
import {
  formatAppHash,
  parseAppHash,
  replaceAppHash,
  type MainTab,
  type PrePanelTab,
} from "./shared/appRoute";
import {
  formatBattleShowPath as _fmtBSP,
  loadBattleShowFromStorage as _loadBSS,
} from "./features/battle/battleShowRoute";
import {
  FMZ_TREASURY_AVATAR_KEY,
  type TreasuryAvatarBridge,
} from "./shared/treasuryAvatarOpen";

// --- Conditional async component imports based on feature flags ---
const CaptainCornersHud = __FEATURE_BATTLE__
  ? defineAsyncComponent(() => import("./features/battle/CaptainCornersHud.vue"))
  : null;
const PreliminaryPanel = __FEATURE_PRELIMINARY__
  ? defineAsyncComponent(() => import("./features/preliminary/PreliminaryPanel.vue"))
  : null;
const UsersPanel = __FEATURE_USERS__
  ? defineAsyncComponent(() => import("./features/users/UsersPanel.vue"))
  : null;
const TreasuryPanel = __FEATURE_TREASURY__
  ? defineAsyncComponent(() => import("./features/treasury/TreasuryPanel.vue"))
  : null;
const DefenseTowerPanel = __FEATURE_SANGUO__
  ? defineAsyncComponent(() => import("./features/sanguo/DefenseTowerPanel.vue"))
  : null;
const BilibiliSearchPanel = __FEATURE_BAOBAO__
  ? defineAsyncComponent(() => import("./features/baobao/BilibiliSearchPanel.vue"))
  : null;
const QuotaDashboardPanel = __FEATURE_QUOTA__
  ? defineAsyncComponent(() => import("./features/quota/QuotaDashboardPanel.vue"))
  : null;

// Feature flags exposed to template (Vite replaces these at build time)
const F_SANGUO = __FEATURE_SANGUO__;
const F_BAOBAO = __FEATURE_BAOBAO__;
const F_BATTLE = __FEATURE_BATTLE__;
const F_TREASURY = __FEATURE_TREASURY__;
const F_PRELIMINARY = __FEATURE_PRELIMINARY__;
const F_USERS = __FEATURE_USERS__;
const F_QUOTA = __FEATURE_QUOTA__;

// Battle show route — tree-shaken when __FEATURE_BATTLE__ is false
const formatBattleShowPath = __FEATURE_BATTLE__ ? _fmtBSP : (_?: any) => "";
const loadBattleShowFromStorage = __FEATURE_BATTLE__ ? _loadBSS : () => ({} as any);

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
// Computed: baobao tab visible = feature compiled in AND runtime toggle on
const showBaobao = computed(() => F_BAOBAO && settings.value.baobaoMode);

const tab = ref<MainTab>(__FEATURE_SANGUO__ ? "sanguo" : __FEATURE_BAOBAO__ ? "baobao" : "sanguo");
const prePanelTab = ref<PrePanelTab>("total");

/** 战斗爽展示筛选路径段（#/battle/<此段>），刷新后由 hash 或 localStorage 恢复 */
const battleShowPath = ref(formatBattleShowPath(loadBattleShowFromStorage()));

const captainHudOnly = ref(false);
function refreshDocTitle() {
  const suffix = FMZ_RELEASE_LABEL ? ` ${FMZ_RELEASE_LABEL}` : "";
  if (captainHudOnly.value) document.title = `战斗爽${suffix}`;
  else document.title = `机器猫的百宝箱${suffix}`;
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

if (__FEATURE_BATTLE__ || __FEATURE_TREASURY__ || __FEATURE_USERS__ || __FEATURE_PRELIMINARY__) {
  watch(
    reactionsClient,
    (ctx) => {
      void loadMemberVotesFromServer(ctx);
    },
    { deep: true, immediate: true },
  );
}

const preRef = ref<any>(null);
const usrRef = ref<any>(null);
const battleRef = ref<any>(null);
const treRef = ref<any>(null);
const sanguoRef = ref<any>(null);
const quotaRef = ref<any>(null);

/** Reload the currently active panel (shared by onApply / loadActivePanel / tab-switch). */
function reloadPanel(t: MainTab) {
  if (__FEATURE_PRELIMINARY__ && t === "pre") preRef.value?.load();
  if (__FEATURE_USERS__ && t === "users") usrRef.value?.reload();
  if (__FEATURE_BATTLE__ && t === "battle") battleRef.value?.reload();
  if (__FEATURE_TREASURY__ && t === "treasury") treRef.value?.reload();
  if (__FEATURE_SANGUO__ && t === "sanguo") sanguoRef.value?.reload();
  if (__FEATURE_QUOTA__ && t === "quota") quotaRef.value?.reload();
}

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
  reloadPanel(tab.value);
}

function loadActivePanel() {
  if (captainHudOnly.value) return;
  reloadPanel(tab.value);
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
  if (__FEATURE_TREASURY__ && t !== "treasury") treRef.value?.closeDlg?.();
  // Skip re-loading preliminary if already on that tab (it uses load() not reload())
  if (t === "pre" && prev === "pre") { /* noop */ }
  else reloadPanel(t);
  syncHashFromState();
});

watch(prePanelTab, () => {
  if (captainHudOnly.value || tab.value !== "pre") return;
  syncHashFromState();
});

// When baobao mode is toggled off while on the baobao tab, switch to default tab
watch(showBaobao, (visible) => {
  if (!visible && tab.value === "baobao") {
    selectTab(__FEATURE_SANGUO__ ? "sanguo" : "sanguo");
  }
});
</script>

<template>
  <CaptainCornersHud
    v-if="captainHudOnly && CaptainCornersHud"
    class="standalone-hud"
    :config="clientConfig"
    :poll-ms="3500"
    :sync-battle-show-to-hash="false"
  />
  <template v-else>
  <SettingsBar v-model="settings" @apply="onApply">
    <template #extra-actions>
      <PluginHost />
    </template>
  </SettingsBar>
  <nav class="nav" aria-label="主导航">
    <button v-if="F_PRELIMINARY" :class="{ on: tab === 'pre' }" type="button" @click="selectTab('pre')">预赛数据</button>
    <button v-if="F_USERS" :class="{ on: tab === 'users' }" type="button" @click="selectTab('users')">用户积分</button>
    <button v-if="F_TREASURY" :class="{ on: tab === 'treasury' }" type="button" @click="selectTab('treasury')">团员金库</button>
    <button v-if="F_BATTLE" :class="{ on: tab === 'battle' }" type="button" @click="selectTab('battle')">战斗爽</button>
    <button v-if="F_SANGUO" :class="{ on: tab === 'sanguo' }" type="button" @click="selectTab('sanguo')">夜观星象</button>
    <button v-if="showBaobao" :class="{ on: tab === 'baobao' }" type="button" @click="selectTab('baobao')">宝宝魅力时刻</button>
    <button v-if="F_QUOTA" :class="{ on: tab === 'quota' }" type="button" @click="selectTab('quota')">用量看板</button>
  </nav>
  <main>
    <PreliminaryPanel
      v-if="F_PRELIMINARY && PreliminaryPanel && tab === 'pre'"
      ref="preRef"
      v-model:panel-tab="prePanelTab"
      :config="clientConfig"
    />
    <UsersPanel
      v-if="F_USERS && UsersPanel && tab === 'users'"
      ref="usrRef"
      :config="clientConfig"
    />
    <TreasuryPanel
      v-if="F_TREASURY && TreasuryPanel"
      v-show="tab === 'treasury'"
      ref="treRef"
      :config="clientConfig"
    />
    <CaptainCornersHud
      v-if="F_BATTLE && CaptainCornersHud && tab === 'battle'"
      ref="battleRef"
      class="panel-hud"
      :config="clientConfig"
      :poll-ms="4000"
      :battle-show-path="battleShowPath"
      @update:battle-show-path="onBattleShowPath"
    />
    <DefenseTowerPanel
      v-if="F_SANGUO && DefenseTowerPanel && tab === 'sanguo'"
      ref="sanguoRef"
    />
    <BilibiliSearchPanel
      v-if="showBaobao && BilibiliSearchPanel && tab === 'baobao'"
    />
    <QuotaDashboardPanel
      v-if="F_QUOTA && QuotaDashboardPanel && tab === 'quota'"
      ref="quotaRef"
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
