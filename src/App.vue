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
const DefenseTowerPanel = __FEATURE_SANGUO_UI__
  ? defineAsyncComponent(() => import("./features/sanguo/DefenseTowerPanel.vue"))
  : null;
const BilibiliSearchPanel = __FEATURE_BAOBAO__
  ? defineAsyncComponent(() => import("./features/baobao/BilibiliSearchPanel.vue"))
  : null;
const DouyuReplayPanel = __FEATURE_BAOBAO__
  ? defineAsyncComponent(() => import("./features/douyu/DouyuReplayPanel.vue"))
  : null;
const QuotaDashboardPanel = __FEATURE_QUOTA__
  ? defineAsyncComponent(() => import("./features/quota/QuotaDashboardPanel.vue"))
  : null;
const SongLibraryPanel = __FEATURE_AUDIO__
  ? defineAsyncComponent(() => import("./features/audio/SongLibraryPanel.vue"))
  : null;
const GlobalAudioPlayer = __FEATURE_AUDIO__
  ? defineAsyncComponent(() => import("./features/audio/GlobalAudioPlayer.vue"))
  : null;
const CrimesPanel = __FEATURE_CRIMES__
  ? defineAsyncComponent(() => import("./features/crimes/CrimesPanel.vue"))
  : null;
const DouyuDanmakuPanel = __FEATURE_DOUYU_DANMAKU__
  ? defineAsyncComponent(() => import("./features/danmaku/DouyuDanmakuPanel.vue"))
  : null;

// Feature flags exposed to template (Vite replaces these at build time)
/** 夜观星象 Tab（可与后台采集分离：__FEATURE_SANGUO__ 仍为 true） */
const F_SANGUO_UI = __FEATURE_SANGUO_UI__;
const F_BAOBAO = __FEATURE_BAOBAO__;
const F_BATTLE = __FEATURE_BATTLE__;
const F_TREASURY = __FEATURE_TREASURY__;
const F_PRELIMINARY = __FEATURE_PRELIMINARY__;
const F_USERS = __FEATURE_USERS__;
const F_QUOTA = __FEATURE_QUOTA__;
const F_AUDIO = __FEATURE_AUDIO__;
const F_CRIMES = __FEATURE_CRIMES__;
const F_DOUYU_DANMAKU = __FEATURE_DOUYU_DANMAKU__;

// Battle show route — tree-shaken when __FEATURE_BATTLE__ is false
const formatBattleShowPath = __FEATURE_BATTLE__ ? _fmtBSP : (_?: any) => "";
const loadBattleShowFromStorage = __FEATURE_BATTLE__ ? _loadBSS : () => ({} as any);

const settings = ref<StoredSettings>(loadSettings());

function applyTheme() {
  const s = settings.value;
  if (s.themePreset === "custom") {
    let rawBg = (s.backgroundColor || "#f6f7f8").trim();
    let rawTx = (s.textColor || "#18191c").trim();
    if (!rawBg.startsWith("#")) rawBg = "#" + rawBg;
    if (!rawTx.startsWith("#")) rawTx = "#" + rawTx;
    const okBg = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(rawBg);
    const okTx = /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(rawTx);
    applyThemeVarsToDocument(
      deriveCustomTheme(
        okBg ? rawBg : "#f6f7f8",
        okTx ? rawTx : "#18191c",
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

/** 与主导航按钮顺序一致，用于默认 Tab / 隐藏某一栏后的回退 */
const NAV_TAB_ORDER: MainTab[] = [
  "pre",
  "users",
  "treasury",
  "battle",
  "sanguo",
  "baobao",
  "douyu",
  "quota",
  "songs",
  "crimes",
  "danmaku",
];

function isTabAvailable(t: MainTab): boolean {
  switch (t) {
    case "pre":
      return __FEATURE_PRELIMINARY__;
    case "users":
      return __FEATURE_USERS__;
    case "treasury":
      return __FEATURE_TREASURY__;
    case "battle":
      return __FEATURE_BATTLE__;
    case "sanguo":
      return F_SANGUO_UI;
    case "baobao":
      return showBaobao.value;
    case "douyu":
      return showBaobao.value;
    case "quota":
      return __FEATURE_QUOTA__;
    case "songs":
      return __FEATURE_AUDIO__;
    case "crimes":
      return __FEATURE_CRIMES__;
    case "danmaku":
      return __FEATURE_DOUYU_DANMAKU__;
    default:
      return false;
  }
}

function firstAvailableMainTab(): MainTab {
  for (const t of NAV_TAB_ORDER) {
    if (isTabAvailable(t)) return t;
  }
  return "baobao";
}

const tab = ref<MainTab>(firstAvailableMainTab());
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
    let nextTab = parsed.tab;
    if (!F_SANGUO_UI && nextTab === "sanguo") nextTab = firstAvailableMainTab();
    tab.value = nextTab;
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
const songsRef = ref<any>(null);
const douyuRef = ref<any>(null);
const crimesRef = ref<any>(null);
const danmakuRef = ref<any>(null);

/** PluginHost ref to access side panel state */
const pluginHostRef = ref<InstanceType<typeof PluginHost> | null>(null);
/** 当前侧栏内显示的插件（用户点「AI」收起侧栏时为空，插件仍为开启） */
const visibleSidePlugin = computed(() => pluginHostRef.value?.visibleSidePlugin ?? null);
function closeSidePlugin() {
  const docked = pluginHostRef.value?.activeSidePlugin ?? null;
  if (docked) pluginHostRef.value?.closePlugin(docked.id);
}

/* ---- Side panel resize drag ---- */
const sidePanelWidth = ref(420);
const isResizing = ref(false);

/** AI 侧栏宽度（刷新后保留） */
const LS_AI_SIDE_PANEL_W = "fmz_ai_side_panel_width";

function hydrateSidePanelWidth(): void {
  try {
    const n = parseInt(localStorage.getItem(LS_AI_SIDE_PANEL_W) || "", 10);
    if (!Number.isFinite(n)) return;
    sidePanelWidth.value = Math.max(280, Math.min(n, 800));
  } catch {
    /* ignore */
  }
}

let sidePanelWidthSaveTimer: ReturnType<typeof setTimeout> | null = null;
watch(sidePanelWidth, (w) => {
  if (sidePanelWidthSaveTimer != null) clearTimeout(sidePanelWidthSaveTimer);
  sidePanelWidthSaveTimer = setTimeout(() => {
    sidePanelWidthSaveTimer = null;
    try {
      localStorage.setItem(LS_AI_SIDE_PANEL_W, String(w));
    } catch {
      /* ignore */
    }
  }, 200);
});

function onResizeStart(e: MouseEvent) {
  e.preventDefault();
  isResizing.value = true;
  const startX = e.clientX;
  const startW = sidePanelWidth.value;

  function onMove(ev: MouseEvent) {
    // Dragging left increases width, dragging right decreases
    const delta = startX - ev.clientX;
    sidePanelWidth.value = Math.max(280, Math.min(startW + delta, 800));
  }
  function onUp() {
    isResizing.value = false;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

/** Reload the currently active panel (shared by onApply / loadActivePanel / tab-switch). */
function reloadPanel(t: MainTab) {
  if (__FEATURE_PRELIMINARY__ && t === "pre") preRef.value?.load();
  if (__FEATURE_USERS__ && t === "users") usrRef.value?.reload();
  if (__FEATURE_BATTLE__ && t === "battle") battleRef.value?.reload();
  if (__FEATURE_TREASURY__ && t === "treasury") treRef.value?.reload();
  if (F_SANGUO_UI && t === "sanguo") sanguoRef.value?.reload();
  if (__FEATURE_QUOTA__ && t === "quota") quotaRef.value?.reload();
  if (__FEATURE_AUDIO__ && t === "songs") songsRef.value?.reload();
  if (__FEATURE_BAOBAO__ && t === "douyu") douyuRef.value?.reload();
  if (__FEATURE_CRIMES__ && t === "crimes") crimesRef.value?.reload();
  if (__FEATURE_DOUYU_DANMAKU__ && t === "danmaku") danmakuRef.value?.reload();
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
  hydrateSidePanelWidth();
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
  if (sidePanelWidthSaveTimer != null) {
    clearTimeout(sidePanelWidthSaveTimer);
    sidePanelWidthSaveTimer = null;
  }
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

// 宝宝版关闭时若正在 B 站/斗鱼 Tab，退回默认可用 Tab
watch(showBaobao, (visible) => {
  if (!visible && (tab.value === "baobao" || tab.value === "douyu")) {
    selectTab(firstAvailableMainTab());
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
      <PluginHost ref="pluginHostRef" />
    </template>
  </SettingsBar>
  <div class="app-body" :class="{ 'has-side-panel': !!visibleSidePlugin, 'is-resizing': isResizing }">
  <div
    class="app-main"
    :class="{ 'app-main--danmaku-fill': tab === 'danmaku' && F_DOUYU_DANMAKU }"
  >
  <nav class="nav" aria-label="主导航">
    <button v-if="F_PRELIMINARY" :class="{ on: tab === 'pre' }" type="button" @click="selectTab('pre')">预赛数据</button>
    <button v-if="F_USERS" :class="{ on: tab === 'users' }" type="button" @click="selectTab('users')">用户积分</button>
    <button v-if="F_TREASURY" :class="{ on: tab === 'treasury' }" type="button" @click="selectTab('treasury')">团员金库</button>
    <button v-if="F_BATTLE" :class="{ on: tab === 'battle' }" type="button" @click="selectTab('battle')">战斗爽</button>
    <button v-if="F_SANGUO_UI" :class="{ on: tab === 'sanguo' }" type="button" @click="selectTab('sanguo')">夜观星象</button>
    <button v-if="showBaobao" :class="{ on: tab === 'baobao' }" type="button" @click="selectTab('baobao')">拾观宝片</button>
    <button v-if="showBaobao" :class="{ on: tab === 'douyu' }" type="button" @click="selectTab('douyu')">遥忆宝章</button>
    <button v-if="F_QUOTA" :class="{ on: tab === 'quota' }" type="button" @click="selectTab('quota')">用量看板</button>
    <button v-if="F_AUDIO" :class="{ on: tab === 'songs' }" type="button" @click="selectTab('songs')">忽闻宝声</button>
    <button v-if="F_CRIMES" :class="{ on: tab === 'crimes' }" type="button" @click="selectTab('crimes')">细数宝罪</button>
    <button v-if="F_DOUYU_DANMAKU" :class="{ on: tab === 'danmaku' }" type="button" @click="selectTab('danmaku')">窃听宝语</button>
  </nav>
  <main :class="{ 'main--danmaku-fill': tab === 'danmaku' && F_DOUYU_DANMAKU }">
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
      v-if="F_SANGUO_UI && DefenseTowerPanel && tab === 'sanguo'"
      ref="sanguoRef"
    />
    <BilibiliSearchPanel
      v-if="showBaobao && BilibiliSearchPanel && tab === 'baobao'"
    />
    <DouyuReplayPanel
      v-if="showBaobao && DouyuReplayPanel && tab === 'douyu'"
      ref="douyuRef"
    />
    <QuotaDashboardPanel
      v-if="F_QUOTA && QuotaDashboardPanel && tab === 'quota'"
      ref="quotaRef"
    />
    <SongLibraryPanel
      v-if="F_AUDIO && SongLibraryPanel && tab === 'songs'"
      ref="songsRef"
    />
    <CrimesPanel
      v-if="F_CRIMES && CrimesPanel && tab === 'crimes'"
      ref="crimesRef"
    />
    <DouyuDanmakuPanel
      v-if="F_DOUYU_DANMAKU && DouyuDanmakuPanel && tab === 'danmaku'"
      ref="danmakuRef"
    />
  </main>
  <!-- Global floating audio player (always available when audio feature is on) -->
  <GlobalAudioPlayer v-if="F_AUDIO && GlobalAudioPlayer" />
  </div><!-- /.app-main -->

  <!-- Side panel (inline, same level as main content) -->
  <Transition name="side-slide">
    <aside v-if="visibleSidePlugin" class="app-side-panel" :style="{ width: sidePanelWidth + 'px', minWidth: sidePanelWidth + 'px' }">
      <div class="side-panel-resize-handle" @mousedown="onResizeStart" />
      <div class="side-panel-body">
        <component :is="visibleSidePlugin.component!" />
      </div>
    </aside>
  </Transition>
  </div><!-- /.app-body -->
  </template>
</template>

<style scoped>
/* ---- Flex layout: main + side panel ---- */
.app-body {
  display: flex;
  height: calc(100vh - 60px); /* subtract header height */
  overflow: hidden;
}
.app-body.is-resizing {
  user-select: none;
  cursor: col-resize;
}
.app-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
}
/* 侧栏展开时避免出现「整块主列 + 侧栏」双滚动轴：仅在主内容区滚动 */
.app-body.has-side-panel .app-main {
  overflow: hidden;
}
/* 侧栏展开时：非窃听宝语 Tab 在主区域纵向滚动（按需出现滚动条） */
.app-body.has-side-panel .app-main > main:not(.main--danmaku-fill) {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}
/* ---- 桌面端窃听宝语（≥601px）：主列为 flex，main 仅在内容超高时出现滚动条；手机端不套用 ---- */
@media (min-width: 601px) {
  .app-main.app-main--danmaku-fill {
    overflow-y: hidden;
  }
  .app-main.app-main--danmaku-fill > main.main--danmaku-fill {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-x: hidden;
    overflow-y: auto;
    max-width: none;
    margin: 0 auto;
    width: 100%;
  }
  /* 侧栏 + 弹幕：同样在 main 按需滚动，不出现「禁滚」 */
  .app-body.has-side-panel .app-main > main.main--danmaku-fill {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-x: hidden;
    overflow-y: auto;
    max-width: none;
    margin: 0 auto;
    width: 100%;
  }
}
@media (max-width: 600px) {
  .app-body.has-side-panel .app-main > main.main--danmaku-fill {
    flex: 1;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }
}

/* ---- Side panel (same level as main) ---- */
.app-side-panel {
  height: 100%;
  display: flex;
  flex-direction: row;
  background: var(--surface);
  overflow: hidden;
  position: relative;
}
.side-panel-resize-handle {
  width: 4px;
  cursor: col-resize;
  background: var(--border);
  flex-shrink: 0;
  transition: background 0.15s;
}
.side-panel-resize-handle:hover,
.side-panel-resize-handle:active {
  background: var(--primary);
}
.side-panel-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* Side panel slide transition */
.side-slide-enter-active {
  transition: width 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease;
}
.side-slide-leave-active {
  transition: width 0.2s ease, opacity 0.2s ease;
}
.side-slide-enter-from,
.side-slide-leave-to {
  width: 0;
  min-width: 0;
  opacity: 0;
}

/* ---- Nav ---- */
.nav {
  display: flex;
  gap: 0.25rem;
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  flex-shrink: 0;
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
.panel-hud {
  margin: 0.75rem 1.25rem 0;
}
.standalone-hud {
  max-width: 520px;
  margin: 0.75rem auto;
  padding: 0 0.75rem;
}
</style>
