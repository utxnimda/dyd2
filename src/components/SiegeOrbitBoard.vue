<script setup lang="ts">
import { computed, nextTick, ref, watch, watchEffect } from "vue";
import {
  ORBIT_SECTOR_PANEL,
  orbitSectorPanelCssVars,
} from "../lib/orbitSectorPanel";
import {
  orbitArcMidDeg,
  sectorClipPathForArc,
  sectorRadiiPctFromRem,
} from "../lib/orbitSectorGeometry";
import type { WeeklyReport, DefenseAttackRow } from "../lib/defenseTowerApi";
import { DEFENSE_SIEGE_CITY_NAMES } from "../lib/defenseTowerApi";
import {
  SIEGE_CITY_INNER_OFFSET_REM,
  SIEGE_CITY_OUTER_EXTRA_REM,
  buildSectorsFromAttackRows,
  sectorsBoardMaxRadius,
  type SiegeInnerCitySector,
} from "../lib/siegeCityOrbit";

/** 页面 logo */
const LOGO_SRC = "/image/baokemeng.jpg";

/** 城市 ID -> 预测图路径 */
const CITY_YUCE_IMG: Record<string, string> = {
  "1": "/image/yuce/luoyang.jpg",
  "2": "/image/yuce/chengdu.jpg",
  "3": "/image/yuce/jianye.jpg",
  "4": "/image/yuce/jingzhou.jpg",
  "5": "/image/yuce/changan.jpg",
  "6": "/image/yuce/xuchang.jpg",
  "7": "/image/yuce/hanzhong.jpg",
};

/** 城市 ID -> accent 颜色 */
const CITY_ACCENT: Record<string, string> = {
  "1": "#F7B52A",
  "2": "#8F42A2",
  "3": "#F17EDF",
  "4": "#3B9E95",
  "5": "#477FBE",
  "6": "#61A0C5",
  "7": "#69A7BF",
};

/** 颜色图例 */
const CITY_LEGEND = [
  { id: "1", name: "洛阳", accent: "#F7B52A" },
  { id: "2", name: "成都", accent: "#8F42A2" },
  { id: "3", name: "建业", accent: "#F17EDF" },
  { id: "4", name: "荆州", accent: "#3B9E95" },
  { id: "5", name: "长安", accent: "#477FBE" },
  { id: "6", name: "许昌", accent: "#61A0C5" },
  { id: "7", name: "汉中", accent: "#69A7BF" },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i + 1);

const selectedHours = ref(2);
const selectedRange = computed(() => selectedHours.value * 60);

type SkinMode = "pure" | "baby";
const SKIN_LABELS: Record<SkinMode, string> = { pure: "纯净版", baby: "宝宝版" };
const BABY_KEYS = ["lsy", "宝宝", "电饭宝", "梁诗颖"];
const STORAGE_UNLOCKED = "siege-skin-unlocked";
const STORAGE_CURRENT = "siege-skin-current";

function loadUnlocked(): Set<SkinMode> {
  try {
    const raw = localStorage.getItem(STORAGE_UNLOCKED);
    if (raw) return new Set(JSON.parse(raw) as SkinMode[]);
  } catch { /* ignore */ }
  return new Set<SkinMode>(["pure"]);
}

function saveUnlocked(s: Set<SkinMode>) {
  localStorage.setItem(STORAGE_UNLOCKED, JSON.stringify([...s]));
}

function loadCurrentSkin(): SkinMode {
  try {
    const raw = localStorage.getItem(STORAGE_CURRENT) as SkinMode | null;
    if (raw && loadUnlocked().has(raw)) return raw;
  } catch { /* ignore */ }
  return "pure";
}

const unlockedSkins = ref(loadUnlocked());
const skinMode = ref<SkinMode>(loadCurrentSkin());
const skinInput = ref("");

function onSkinInput() {
  const val = skinInput.value.trim().toLowerCase();
  if (BABY_KEYS.some((k) => k.toLowerCase() === val)) {
    unlockedSkins.value.add("baby");
    saveUnlocked(unlockedSkins.value);
    skinMode.value = "baby";
    localStorage.setItem(STORAGE_CURRENT, "baby");
    skinInput.value = "";
  }
}

function onSkinSelect(e: Event) {
  const val = (e.target as HTMLSelectElement).value as SkinMode;
  skinMode.value = val;
  localStorage.setItem(STORAGE_CURRENT, val);
}

const props = defineProps<{
  report: WeeklyReport | null | undefined;
  secondsToSync: number;
  clock: number;
  recentAttacks: DefenseAttackRow[];
}>();

const minuteWindow = 60;
const orbitBoardEl = ref<HTMLElement | null>(null);
const orbitScale = ref(1);

/** 按选中的时间窗口截取本地数据库记录 */
const dbMinuteRows = computed(() =>
  props.recentAttacks.slice(0, selectedRange.value).map((row) => ({
    timeLabel: row.attack_time_label,
    cityName: row.city_name || DEFENSE_SIEGE_CITY_NAMES[row.city_id] || row.city_id,
    accent: CITY_ACCENT[row.city_id] || "#69A7BF",
  })),
);

/** 圆盘：固定1圈6个 */
const citySectors = computed(() =>
  buildSectorsFromAttackRows(props.recentAttacks, 1),
);

const orbitBoardSideRem = computed(() => {
  const maxR = sectorsBoardMaxRadius(1);
  return Math.max(2 * maxR + 1.7, 16.8);
});

const orbitBoardInlineStyle = computed(() => ({
  "--orbit-side": `${orbitBoardSideRem.value}rem`,
  ...orbitSectorPanelCssVars(),
}));

function updateOrbitScale() {
  const el = orbitBoardEl.value;
  if (!el) return;
  const w = el.getBoundingClientRect().width;
  const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const designW = orbitBoardSideRem.value * remPx;
  orbitScale.value = designW > 0 ? Math.min(1, w / designW) : 1;
}

watchEffect((onCleanup) => {
  const el = orbitBoardEl.value;
  if (!el) return;
  updateOrbitScale();
  const ro = new ResizeObserver(updateOrbitScale);
  ro.observe(el);
  onCleanup(() => ro.disconnect());
});

watch(orbitBoardSideRem, () => nextTick(updateOrbitScale));

const orbitScalerStyle = computed(() => ({
  transform: `scale(${orbitScale.value})`,
  transformOrigin: "center center",
}));

function innerCitySectorStyle(s: SiegeInnerCitySector): Record<string, string> {
  const side = orbitBoardSideRem.value;
  const { innerPct, outerPct } = sectorRadiiPctFromRem(
    s.innerRem,
    s.outerRem,
    side,
  );
  const clip = sectorClipPathForArc(s.a0, s.a1, innerPct, outerPct);
  // 扇形底色偏实，减少透出背景
  const op = 0.95 * (s.opacityScale ?? 1);
  return {
    clipPath: clip,
    WebkitClipPath: clip,
    opacity: String(op),
    "--sector-accent": s.accent,
    "--sector-glow": s.isLatest ? s.accent : "transparent",
  };
}

function labelSlotStyle(s: SiegeInnerCitySector): Record<string, string> {
  const mid = orbitArcMidDeg(s.a0, s.a1);
  return {
    "--orbit-a": `${mid}deg`,
    "--orbit-r": `${s.labelRem}rem`,
    "--c": s.accent,
  };
}

/** 获取 total 的所有约数 */
function getDivisors(total: number): number[] {
  if (total <= 0) return [1];
  const divs: number[] = [];
  for (let d = 1; d <= total; d++) {
    if (total % d === 0) divs.push(d);
  }
  return divs;
}

/** 桌面端格子固定宽度（含 gap） */
const CELL_WIDTH_PX = 90;
const CELL_GAP_PX = 6;

const minuteGridEl = ref<HTMLElement | null>(null);
const gridContainerWidth = ref(1200);

watchEffect((onCleanup) => {
  const el = minuteGridEl.value;
  if (!el) return;
  gridContainerWidth.value = el.getBoundingClientRect().width;
  const ro = new ResizeObserver((entries) => {
    gridContainerWidth.value = entries[0]?.contentRect.width ?? 1200;
  });
  ro.observe(el);
  onCleanup(() => ro.disconnect());
});

const gridColumns = computed(() => {
  const total = dbMinuteRows.value.length;
  if (total <= 0) return 1;
  const maxFit = Math.max(1, Math.floor((gridContainerWidth.value + CELL_GAP_PX) / (CELL_WIDTH_PX + CELL_GAP_PX)));
  const divs = getDivisors(total);
  // 取不超过 maxFit 的最大约数
  let best = 1;
  for (const d of divs) {
    if (d <= maxFit) best = d;
  }
  return best;
});

const gridStyle = computed(() => ({
  display: "grid",
  gridTemplateColumns: `repeat(${gridColumns.value}, minmax(0, 1fr))`,
  gap: `${CELL_GAP_PX}px`,
}));

/** 移动端色块网格：列数必须是总数的约数，偏好 10~20 */
function bestMobileColumns(total: number): number {
  if (total <= 0) return 1;
  const divisors: number[] = [];
  for (let d = 1; d <= total; d++) {
    if (total % d === 0) divisors.push(d);
  }
  const preferred = divisors.filter((d) => d >= 10 && d <= 20);
  if (preferred.length > 0) return preferred[preferred.length - 1]!;
  // 其次选最接近 15 的
  divisors.sort((a, b) => Math.abs(a - 15) - Math.abs(b - 15));
  return divisors[0]!;
}

const mobileGridCols = computed(() => bestMobileColumns(dbMinuteRows.value.length));
const mobileGridStyle = computed(() => ({
  display: "grid",
  gridTemplateColumns: `repeat(${mobileGridCols.value}, 1fr)`,
  gap: "2px",
}));

/** 比例统计时间维度 */
type RatioMode = "hour" | "day";
const ratioMode = ref<RatioMode>("hour");
const ratioValue = ref(1); // 几小时 或 几天
const RATIO_HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i + 1);
const RATIO_DAY_OPTIONS = Array.from({ length: 7 }, (_, i) => i + 1);

/** 实际参与统计的记录数 */
const ratioFilteredCount = ref(0);

/** 按条数统计各城市出现比例（1小时=60条，1天=1440条） */
const cityRatioStats = computed(() => {
  const takeCount = ratioMode.value === "hour"
    ? ratioValue.value * 60
    : ratioValue.value * 1440;
  const filtered = props.recentAttacks.slice(0, takeCount);
  ratioFilteredCount.value = filtered.length;
  const total = filtered.length;

  const countMap = new Map<string, number>();
  for (const r of filtered) {
    countMap.set(r.city_id, (countMap.get(r.city_id) ?? 0) + 1);
  }

  // 所有7个城市都列出，没出现的显示 0%
  const ALL_CITY_IDS = ["1", "2", "3", "4", "5", "6", "7"];
  return ALL_CITY_IDS
    .map((cityId) => {
      const count = countMap.get(cityId) ?? 0;
      return {
        cityId,
        cityName: DEFENSE_SIEGE_CITY_NAMES[cityId] || cityId,
        accent: CITY_ACCENT[cityId] || "#69A7BF",
        count,
        ratio: total > 0 ? count / total : 0,
        pct: total > 0 ? ((count / total) * 100).toFixed(1) : "0.0",
      };
    })
    .sort((a, b) => b.count - a.count);
});

const secondsToSync = computed(() => props.secondsToSync);

/** Current time string (UTC+8), refreshed every tick */
const currentTime = computed(() => {
  void props.clock; // reactivity driver
  const now = new Date();
  const utc8 = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60_000);
  return `${String(utc8.getHours()).padStart(2, "0")}:${String(utc8.getMinutes()).padStart(2, "0")}:${String(utc8.getSeconds()).padStart(2, "0")}`;
});

/** 移动端顶栏：距下次 :50 同步的剩余秒数占满一格（60s）的进度，风格接近源站细条 */
const syncBarFillPct = computed(() => {
  const rem = secondsToSync.value;
  return Math.min(100, Math.max(0, (rem / 60) * 100));
});

/** 检测 --bg 亮度，浅色背景用洛阳金黄，深色用白色 */
const countdownColor = ref("#fff");
function updateCountdownColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  if (!bg) return;
  const m = bg.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
    || bg.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (!m) return;
  const r = parseInt(m[1]!.length === 1 ? m[1]! + m[1]! : m[1]!, 16);
  const g = parseInt(m[2]!.length === 1 ? m[2]! + m[2]! : m[2]!, 16);
  const b = parseInt(m[3]!.length === 1 ? m[3]! + m[3]! : m[3]!, 16);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  countdownColor.value = skinMode.value === "baby"
    ? "#F7B52A"
    : luma > 128 ? "#F7B52A" : "#fff";
}

const wrapStyle = computed(() => ({
  "--siege-countdown-color": countdownColor.value,
}));

watchEffect(() => {
  void props.clock; // 每秒触发检测
  updateCountdownColor();
});
</script>

<template>
  <div class="siege-orbit-wrap" :style="wrapStyle">
    <div class="siege-skin-toggle">
      <select
        :value="skinMode"
        class="siege-skin-select"
        @change="onSkinSelect"
      >
        <option
          v-for="mode in [...unlockedSkins]"
          :key="mode"
          :value="mode"
        >{{ SKIN_LABELS[mode] }}</option>
      </select>
      <input
        v-model="skinInput"
        type="text"
        class="siege-skin-input"
        placeholder="口令"
        autocomplete="off"
        maxlength="10"
        @input="onSkinInput"
      />
    </div>

    <!-- ===== 移动端竖屏布局 ===== -->
    <div class="siege-mobile-only">
      <div
        class="siege-mobile-sync-row"
        :class="[
          { 'siege-mobile-sync-row--baby': skinMode === 'baby' },
          secondsToSync <= 10 ? 'siege-sync-row--urgent' : ''
        ]"
        aria-label="距下次数据同步"
      >
        <div class="siege-sync-clock">{{ currentTime }}</div>
        <div class="siege-mobile-sync-track">
          <div
            class="siege-mobile-sync-fill"
            :style="{ width: syncBarFillPct + '%' }"
          >
            <div class="siege-sync-fill-glow" />
          </div>
        </div>
        <div class="siege-sync-num" :class="{ 'siege-sync-num--urgent': secondsToSync <= 10 }">{{ secondsToSync }}s</div>
      </div>

      <div class="siege-mobile-legend">
        <span
          v-for="c in CITY_LEGEND"
          :key="c.id"
          class="siege-mobile-legend-item"
        >
          <span class="siege-mobile-legend-dot" :style="{ backgroundColor: c.accent }" />
          <span class="siege-mobile-legend-name">{{ c.name }}</span>
        </span>
      </div>

      <div class="siege-mobile-minute-header">
        <span class="siege-mobile-section-title">近 {{ dbMinuteRows.length }} 次</span>
        <label class="siege-hour-select-wrap">
          <select v-model.number="selectedHours" class="siege-hour-select">
            <option v-for="h in HOUR_OPTIONS" :key="h" :value="h">{{ h }}h</option>
          </select>
        </label>
      </div>
      <div class="siege-mobile-grid" :style="mobileGridStyle">
        <div
          v-for="(row, i) in dbMinuteRows"
          :key="'m-' + i"
          class="siege-mobile-cell"
          :class="{ 'siege-mobile-cell--flash': i === 0 }"
          :style="{ backgroundColor: row.accent }"
          :title="row.timeLabel + ' ' + row.cityName"
        >{{ row.cityName[0] }}</div>
      </div>

      <div class="siege-mobile-section">
        <div class="siege-mobile-ratio-header">
          <span class="siege-mobile-section-title">城市出现比例</span>
          <div class="siege-ratio-mode">
            <button type="button" class="siege-range-btn" :class="{ 'siege-range-btn--active': ratioMode === 'hour' }" @click="ratioMode = 'hour'; ratioValue = 1">时</button>
            <button type="button" class="siege-range-btn" :class="{ 'siege-range-btn--active': ratioMode === 'day' }" @click="ratioMode = 'day'; ratioValue = 1">天</button>
          </div>
          <select v-model.number="ratioValue" class="siege-hour-select">
            <template v-if="ratioMode === 'hour'">
              <option v-for="h in RATIO_HOUR_OPTIONS" :key="h" :value="h">{{ h }}</option>
            </template>
            <template v-else>
              <option v-for="d in RATIO_DAY_OPTIONS" :key="d" :value="d">{{ d }}</option>
            </template>
          </select>
          <span class="siege-ratio-actual">({{ ratioFilteredCount }}条)</span>
        </div>
        <div v-for="s in cityRatioStats" :key="'mr-' + s.cityId" class="siege-ratio-row">
          <span class="siege-ratio-city" :style="{ color: s.accent }">{{ s.cityName }}</span>
          <div class="siege-ratio-bar-wrap">
            <div class="siege-ratio-bar" :style="{ width: s.pct + '%', backgroundColor: s.accent }" />
          </div>
          <span class="siege-ratio-pct">{{ s.pct }}%</span>
          <span class="siege-ratio-count">({{ s.count }})</span>
        </div>
      </div>
    </div>

    <!-- ===== 桌面端布局 ===== -->
    <div class="siege-desktop-only">
    <div class="siege-cities-layout">
      <!-- Row 1: A B C D E (5 cities) -->
      <div v-if="skinMode === 'baby'" class="siege-cities-row1">
        <div v-for="id in ['2','7','5','6','1']" :key="'r1-' + id" class="siege-city-item">
          <img :src="CITY_YUCE_IMG[id]" :alt="DEFENSE_SIEGE_CITY_NAMES[id]" class="siege-city-img siege-city-img--tall" :style="{ '--city-accent': CITY_ACCENT[id] }" />
        </div>
      </div>
      <!-- Row 2: F + ratio panel + G -->
      <div class="siege-cities-row2">
        <div v-if="skinMode === 'baby'" class="siege-city-item siege-city-item--side">
          <img :src="CITY_YUCE_IMG['4']" :alt="DEFENSE_SIEGE_CITY_NAMES['4']" class="siege-city-img siege-city-img--tall" :style="{ '--city-accent': CITY_ACCENT['4'] }" />
        </div>
        <div class="siege-ratio-panel siege-ratio-panel--inline">
          <div class="siege-ratio-header">
            <span class="siege-ratio-title">城市出现比例</span>
            <div class="siege-ratio-mode">
              <button type="button" class="siege-range-btn" :class="{ 'siege-range-btn--active': ratioMode === 'hour' }" @click="ratioMode = 'hour'; ratioValue = 1">时</button>
              <button type="button" class="siege-range-btn" :class="{ 'siege-range-btn--active': ratioMode === 'day' }" @click="ratioMode = 'day'; ratioValue = 1">天</button>
            </div>
            <select v-model.number="ratioValue" class="siege-hour-select">
              <template v-if="ratioMode === 'hour'">
                <option v-for="h in RATIO_HOUR_OPTIONS" :key="h" :value="h">{{ h }}</option>
              </template>
              <template v-else>
                <option v-for="d in RATIO_DAY_OPTIONS" :key="d" :value="d">{{ d }}</option>
              </template>
            </select>
            <span class="siege-ratio-actual">({{ ratioFilteredCount }}条)</span>
          </div>
          <div v-if="cityRatioStats.length === 0" class="siege-ratio-empty">暂无数据</div>
          <div v-for="s in cityRatioStats" :key="s.cityId" class="siege-ratio-row">
            <span class="siege-ratio-city" :style="{ color: s.accent }">{{ s.cityName }}</span>
            <div class="siege-ratio-bar-wrap">
              <div class="siege-ratio-bar" :style="{ width: s.pct + '%', backgroundColor: s.accent }" />
            </div>
            <span class="siege-ratio-pct">{{ s.pct }}%</span>
            <span class="siege-ratio-count">({{ s.count }})</span>
          </div>
        </div>
        <div v-if="skinMode === 'baby'" class="siege-city-item siege-city-item--side">
          <img :src="CITY_YUCE_IMG['3']" :alt="DEFENSE_SIEGE_CITY_NAMES['3']" class="siege-city-img siege-city-img--tall" :style="{ '--city-accent': CITY_ACCENT['3'] }" />
        </div>
      </div>
    </div>
    <div
      class="siege-desktop-sync-row"
      :class="[
        { 'siege-desktop-sync-row--baby': skinMode === 'baby' },
        secondsToSync <= 10 ? 'siege-sync-row--urgent' : ''
      ]"
      aria-label="距下次数据同步"
    >
      <div class="siege-sync-clock">{{ currentTime }}</div>
      <div class="siege-desktop-sync-track">
        <div
          class="siege-desktop-sync-fill"
          :style="{ width: syncBarFillPct + '%' }"
        >
          <div class="siege-sync-fill-glow" />
        </div>
      </div>
      <div class="siege-sync-num" :class="{ 'siege-sync-num--urgent': secondsToSync <= 10 }">{{ secondsToSync }}s</div>
    </div>
    <div v-show="false" class="siege-orbit-row">
      <div
        ref="orbitBoardEl"
        class="orbit-board"
        :style="orbitBoardInlineStyle"
      >
      <div class="orbit-board-scaler" :style="orbitScalerStyle">
        <div class="orbit-sectors siege-city-sectors" aria-hidden="true">
          <div
            v-for="s in citySectors"
            :key="'sec-' + s.slotIndex"
            class="orbit-sector siege-city-sector"
            :class="{ 'siege-city-sector--latest': s.isLatest }"
            :style="innerCitySectorStyle(s)"
          />
        </div>

        <div class="orbit-hub attack-hub-bh" aria-hidden="true">
          <template v-if="skinMode === 'baby'">
            <img :src="LOGO_SRC" alt="" class="siege-hub-logo" />
          </template>
          <template v-else>
            <div class="attack-hub-taiji-wrap">
              <div class="attack-hub-taiji-water" aria-hidden="true" />
              <svg
                class="attack-hub-taiji-svg"
                viewBox="0 0 100 100"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <g class="attack-hub-taiji-fill">
                  <path
                    class="attack-hub-taiji-fill--member"
                    fill="var(--attack-hub-taiji-member, #5eb0e8)"
                    d="M50,0 A50,50 0 0,1 50,100 A25,25 0 0,1 50,50 A25,25 0 0,0 50,0"
                  />
                  <path
                    class="attack-hub-taiji-fill--other"
                    fill="var(--attack-hub-taiji-other, #e9b949)"
                    d="M50,0 A25,25 0 0,1 50,50 A25,25 0 0,0 50,100 A50,50 0 0,0 50,0"
                  />
                </g>
                <g
                  class="attack-hub-taiji-edge"
                  fill="none"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path
                    class="attack-hub-taiji-edge--member"
                    stroke="var(--attack-hub-taiji-member, #5eb0e8)"
                    stroke-width="1.35"
                    d="M50,0 A50,50 0 0,1 50,100 A25,25 0 0,1 50,50 A25,25 0 0,0 50,0"
                  />
                  <path
                    class="attack-hub-taiji-edge--other"
                    stroke="var(--attack-hub-taiji-other, #e9b949)"
                    stroke-width="1.35"
                    d="M50,0 A25,25 0 0,1 50,50 A25,25 0 0,0 50,100 A50,50 0 0,0 50,0"
                  />
                </g>
                <g class="attack-hub-taiji-dots">
                  <circle
                    class="attack-hub-taiji-dots--other"
                    cx="50"
                    cy="25"
                    r="8"
                    fill="var(--attack-hub-taiji-other, #e9b949)"
                  />
                  <circle
                    class="attack-hub-taiji-dots--member"
                    cx="50"
                    cy="75"
                    r="8"
                    fill="var(--attack-hub-taiji-member, #5eb0e8)"
                  />
                </g>
              </svg>
            </div>
          </template>
          <div class="siege-hub-countdown">
            <div class="siege-hub-num">{{ secondsToSync }}</div>
          </div>
        </div>

        <div
          v-for="s in citySectors"
          :key="'lbl-' + s.slotIndex"
          class="orbit-slot siege-city-label-slot"
          :class="{ 'siege-city-label-slot--latest': s.isLatest }"
          :style="labelSlotStyle(s)"
        >
          <div class="orbit-slot-pin siege-city-label-pin">
            <div
              class="siege-city-copy"
              :class="{
                'siege-city-copy--latest': s.isLatest,
                'siege-city-copy--idle': s.latestMinuteIndex == null,
              }"
            >
              <span class="siege-city-name">{{ s.name }}</span>
              <span class="siege-city-time">{{ s.latestTimeLabel }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    </div>

    <div class="siege-minute-section">
      <div class="siege-minute-header">
        <span class="siege-minute-list-title">近 {{ dbMinuteRows.length }} 次记录</span>
        <label class="siege-hour-select-wrap">
          展示
          <select v-model.number="selectedHours" class="siege-hour-select">
            <option v-for="h in HOUR_OPTIONS" :key="h" :value="h">{{ h }} 小时</option>
          </select>
        </label>
      </div>
      <div ref="minuteGridEl" class="siege-minute-grid" :style="gridStyle">
        <div
          v-for="(row, i) in dbMinuteRows"
          :key="i"
          class="siege-minute-row"
          :style="{ backgroundColor: row.accent }"
        >
          {{ row.timeLabel }} {{ row.cityName }}
        </div>
      </div>
    </div>
    </div>
  </div>
</template>

<style scoped>
.siege-orbit-wrap {
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}

.siege-skin-toggle {
  display: flex;
  justify-content: center;
  gap: 6px;
  align-items: center;
}

.siege-skin-select {
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid var(--border, #2d3a4d);
  background: var(--surface, #1a2332);
  color: var(--text, #e8eef7);
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}

.siege-skin-input {
  width: 6rem;
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid var(--border, #2d3a4d);
  background: var(--surface, #1a2332);
  color: var(--text, #e8eef7);
  font-size: 0.78rem;
  text-align: center;
}

.siege-skin-input::placeholder {
  color: var(--muted, #8b9cb3);
  opacity: 0.6;
}

.siege-logo-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.siege-logo {
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid rgba(255, 255, 255, 0.15);
}

.siege-logo-text {
  font-size: 1.4rem;
  font-weight: 900;
  background: linear-gradient(135deg, #e9b949, #5eb0e8);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.siege-orbit-row {
  display: flex;
  align-items: flex-start;
  gap: 1.5rem;
  width: 100%;
  justify-content: center;
}

.siege-ring-selector {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
}

.siege-ring-label {
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--text, #e8eef7);
  margin-right: 4px;
}

.siege-minute-section {
  width: 100%;
  padding-bottom: 3rem;
}

.siege-minute-header {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.siege-minute-list-title {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text, #e8eef7);
}

.siege-hour-select-wrap {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text, #e8eef7);
}

.siege-hour-select {
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid var(--border, #2d3a4d);
  background: var(--surface, #1a2332);
  color: var(--text, #e8eef7);
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}

.siege-range-btn {
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid var(--border, #2d3a4d);
  background: var(--surface, #1a2332);
  color: var(--muted, #8b9cb3);
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.siege-range-btn--active {
  background: var(--primary, #5b9cff);
  color: #fff;
  border-color: var(--primary, #5b9cff);
}

.siege-ratio-panel {
  margin: 0 auto 12px;
  max-width: 36rem;
  width: 100%;
}

.siege-ratio-header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.5rem;
  flex-wrap: wrap;
}

.siege-ratio-title {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--text, #e8eef7);
}

.siege-ratio-mode {
  display: flex;
  gap: 4px;
}

.siege-ratio-empty {
  font-size: 0.82rem;
  color: var(--muted, #8b9cb3);
}

.siege-ratio-controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  flex-wrap: wrap;
}

.siege-ratio-select-wrap {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text, #e8eef7);
}

.siege-ratio-actual {
  font-size: 0.72rem;
  color: var(--muted, #8b9cb3);
}

.siege-ratio-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.35rem;
}

.siege-ratio-city {
  font-size: 0.82rem;
  font-weight: 800;
  min-width: 2.5rem;
  text-align: right;
}

.siege-ratio-bar-wrap {
  flex: 1;
  height: 8px;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  overflow: hidden;
}

.siege-ratio-bar {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s;
}

.siege-ratio-pct {
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--text, #e8eef7);
  min-width: 3rem;
  text-align: right;
}

.siege-ratio-count {
  font-size: 0.72rem;
  color: var(--muted, #8b9cb3);
  min-width: 2.2rem;
}

.siege-minute-grid {
  display: grid;
  gap: 6px;
}

.siege-minute-row {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 4px 8px;
  color: #fff;
  font-size: 0.82rem;
  font-weight: 700;
  border-radius: 4px;
  text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.siege-minute-row:hover {
  filter: brightness(1.2);
}

.siege-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
  margin-bottom: 0.35rem;
}

.siege-toolbar-lbl {
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--muted);
}

.siege-select-wrap {
  display: inline-flex;
  align-items: center;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.siege-select {
  padding: 0.35rem 0.55rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 0.82rem;
  font-weight: 600;
}

.siege-orbit-legend {
  margin: 0 0 0.5rem;
  font-size: 0.82rem;
  color: var(--muted);
  line-height: 1.45;
  max-width: 56rem;
}

.orbit-board {
  position: relative;
  width: min(100%, var(--orbit-side, 28rem));
  aspect-ratio: 1;
  margin-inline: auto;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}

.orbit-board-scaler {
  position: relative;
  width: var(--orbit-side, 28rem);
  height: var(--orbit-side, 28rem);
  aspect-ratio: 1;
  flex-shrink: 0;
}



.orbit-sectors {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  border-radius: 50%;
}

.siege-city-sectors {
  z-index: 1;
}

.orbit-sector {
  position: absolute;
  inset: 0;
}

.siege-city-sector {
  opacity: 1;
  background: var(--sector-accent);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--sector-accent) 40%, var(--border)),
    inset 0 0 1rem color-mix(in srgb, var(--sector-accent) 10%, transparent);
  filter: drop-shadow(0 0 0.5rem color-mix(in srgb, var(--sector-glow) 16%, transparent));
}

.siege-city-sector--latest {
  z-index: 2;
}

.orbit-hub {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 2;
  /* 勿用独立属性 translate：部分手机 WebKit 支持不完整，会忽略导致太极左上角顶在圆心、整体偏位 */
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.attack-hub-bh {
  --attack-hub-taiji-member: #5eb0e8;
  --attack-hub-taiji-other: #e9b949;
  width: min(100%, 5.25rem);
  min-width: 3.5rem;
  min-height: 3.5rem;
  aspect-ratio: 1;
  max-width: 5.25rem;
  max-height: 5.25rem;
  border-radius: 50%;
  position: relative;
  border: none;
  outline: none;
  background: transparent;
  box-sizing: border-box;
  overflow: visible;
  flex-shrink: 0;
  filter: drop-shadow(0 0 10px color-mix(in srgb, var(--primary, #5b9cff) 32%, transparent))
    drop-shadow(0 0 20px rgba(140, 100, 255, 0.14));
}

.attack-hub-taiji-wrap {
  position: absolute;
  left: 10%;
  top: 10%;
  width: 80%;
  height: 80%;
  z-index: 2;
  pointer-events: none;
  border-radius: 50%;
  overflow: visible;
  transform-origin: 50% 50%;
  will-change: transform;
  animation: attack-hub-taiji-spin-ccw 48s linear infinite;
}

@keyframes attack-hub-taiji-spin-ccw {
  to {
    transform: rotate(-360deg);
  }
}

.attack-hub-taiji-water {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  z-index: 0;
  opacity: 0.52;
  mix-blend-mode: soft-light;
  background:
    linear-gradient(
      118deg,
      transparent 0%,
      rgba(160, 230, 255, 0.45) 22%,
      transparent 38%,
      rgba(255, 255, 255, 0.28) 48%,
      transparent 56%,
      rgba(200, 245, 255, 0.35) 72%,
      transparent 88%
    ),
    radial-gradient(
      ellipse 85% 75% at 45% 48%,
      rgba(120, 200, 255, 0.22) 0%,
      transparent 58%
    );
  background-size: 300% 300%, 100% 100%;
  animation: attack-hub-taiji-water 6.5s ease-in-out infinite;
}

@keyframes attack-hub-taiji-water {
  0%,
  100% {
    background-position: 8% 22%, 50% 50%;
  }
  50% {
    background-position: 92% 78%, 50% 50%;
  }
}

.attack-hub-taiji-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 1;
}

.attack-hub-taiji-fill {
  -webkit-mask-image: radial-gradient(
    circle at 50% 50%,
    rgba(0, 0, 0, 0.9) 0%,
    rgba(0, 0, 0, 0.65) 38%,
    rgba(0, 0, 0, 0.38) 62%,
    rgba(0, 0, 0, 0.18) 80%,
    transparent 100%
  );
  mask-image: radial-gradient(
    circle at 50% 50%,
    rgba(0, 0, 0, 0.9) 0%,
    rgba(0, 0, 0, 0.65) 38%,
    rgba(0, 0, 0, 0.38) 62%,
    rgba(0, 0, 0, 0.18) 80%,
    transparent 100%
  );
}

.attack-hub-taiji-fill path.attack-hub-taiji-fill--member {
  fill-opacity: 1;
}

.attack-hub-taiji-fill path.attack-hub-taiji-fill--other {
  fill-opacity: 0.4;
}

.attack-hub-taiji-edge path {
  paint-order: stroke fill;
}

.attack-hub-taiji-edge path.attack-hub-taiji-edge--member {
  stroke-opacity: 0.88;
}

.attack-hub-taiji-edge path.attack-hub-taiji-edge--other {
  stroke-opacity: calc(0.88 * 0.4);
}

.attack-hub-taiji-dots circle {
  filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.35));
}

.attack-hub-taiji-dots circle.attack-hub-taiji-dots--member {
  fill-opacity: 0.92;
}

.attack-hub-taiji-dots circle.attack-hub-taiji-dots--other {
  fill-opacity: calc(0.92 * 0.4);
}

.siege-hub-countdown {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.siege-hub-logo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
  z-index: 2;
}

.siege-hub-num {
  font-size: 1.55rem;
  font-weight: 900;
  color: var(--siege-countdown-color, #fff);
  text-shadow:
    0 0 12px rgba(0, 0, 0, 0.6),
    0 1px 4px rgba(0, 0, 0, 0.8);
  line-height: 1;
}

.orbit-slot {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  z-index: 4;
  overflow: visible;
  pointer-events: none;
}

.siege-city-label-slot--latest {
  z-index: 5;
}

.orbit-slot-pin {
  width: fit-content;
  min-width: 0;
  max-width: none;
  display: flex;
  justify-content: center;
  transform: translate(-50%, -50%) rotate(var(--orbit-a)) translateY(calc(-1 * var(--orbit-r)))
    rotate(calc(-1 * var(--orbit-a)));
  transform-origin: 50% 50%;
}

.siege-city-label-pin {
  pointer-events: none;
}

.siege-city-copy {
  width: 2.72rem;
  max-width: 2.72rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.05rem;
  padding: 0.08rem 0.12rem;
  border-radius: 0.78rem;
  background: linear-gradient(
    180deg,
    rgba(10, 16, 28, 0.55),
    rgba(10, 16, 28, 0.72)
  );
  backdrop-filter: blur(1.2px);
}

.siege-city-copy--latest {
  transform: scale(1.05);
}

.siege-city-copy--idle {
  opacity: 0.58;
}

.siege-city-name {
  font-size: 0.58rem;
  line-height: 1.02;
  font-weight: 800;
  color: #fff;
  text-align: center;
  text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.5);
}

.siege-city-time {
  font-size: 0.5rem;
  line-height: 1;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: #fff;
  letter-spacing: 0.01em;
  text-align: center;
  text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.5);
}

@media (prefers-reduced-motion: reduce) {
  .attack-hub-taiji-wrap {
    animation: none;
  }

  .attack-hub-taiji-water {
    animation: none;
  }
}

/* === 移动端/桌面端切换 === */
.siege-mobile-only { display: none; }
.siege-desktop-only { display: contents; }

/* === Countdown bar animations === */
@keyframes siege-pulse-glow {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
@keyframes siege-urgent-flash {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@keyframes siege-shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(200%); }
}

/* === 桌面端倒计时条 === */
.siege-desktop-sync-row {
  --siege-sync-h: 6px;
  --siege-accent: rgba(92, 158, 255, 0.85);
  --siege-accent-dim: rgba(61, 111, 168, 0.55);
  --siege-glow: rgba(92, 158, 255, 0.35);
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 auto 12px;
  max-width: 36rem;
  width: 100%;
}

.siege-desktop-sync-track {
  flex: 1;
  min-width: 0;
  height: var(--siege-sync-h);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  box-shadow:
    inset 0 1px 2px rgba(0, 0, 0, 0.3),
    0 0 0 1px rgba(255, 255, 255, 0.04);
  overflow: hidden;
  position: relative;
}

.siege-desktop-sync-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--siege-accent-dim), var(--siege-accent));
  box-shadow:
    0 0 8px var(--siege-glow),
    0 0 2px var(--siege-accent);
  transition: width 1s linear;
  position: relative;
  overflow: hidden;
}

.siege-desktop-sync-fill .siege-sync-fill-glow {
  position: absolute;
  top: 0; right: 0;
  width: 20px;
  height: 100%;
  background: radial-gradient(ellipse at right center, rgba(255,255,255,0.6), transparent 70%);
  animation: siege-pulse-glow 2s ease-in-out infinite;
}

.siege-desktop-sync-row--baby {
  --siege-accent: rgba(247, 181, 42, 0.85);
  --siege-accent-dim: rgba(201, 138, 30, 0.55);
  --siege-glow: rgba(247, 181, 42, 0.35);
}

/* === Shared countdown number === */
.siege-sync-num {
  flex-shrink: 0;
  min-width: 2.2rem;
  padding: 2px 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  font-size: 0.72rem;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  font-family: "Menlo", "Consolas", "Courier New", monospace;
  line-height: 1;
  letter-spacing: 0.02em;
  color: var(--siege-countdown-color, #fff);
  text-shadow: 0 0 6px var(--siege-glow, rgba(92,158,255,0.4)), 0 1px 2px rgba(0,0,0,0.5);
  background: rgba(10, 16, 28, 0.5);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.08),
    0 0 8px rgba(0, 0, 0, 0.2);
  transition: color 0.3s, text-shadow 0.3s, background 0.3s;
}

.siege-sync-num--urgent {
  color: #ff6b6b;
  text-shadow: 0 0 10px rgba(255, 80, 80, 0.7), 0 0 20px rgba(255, 80, 80, 0.3);
  background: rgba(40, 10, 10, 0.55);
  animation: siege-urgent-flash 1s ease-in-out infinite;
}

/* === Shared clock === */
.siege-sync-clock {
  flex-shrink: 0;
  padding: 2px 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  font-size: 0.68rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  font-family: "Menlo", "Consolas", "Courier New", monospace;
  line-height: 1;
  letter-spacing: 0.05em;
  color: var(--siege-countdown-color, #fff);
  opacity: 0.55;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  white-space: nowrap;
  transition: opacity 0.3s;
}
.siege-sync-clock:hover {
  opacity: 0.85;
}

/* === Urgent row glow === */
.siege-sync-row--urgent .siege-desktop-sync-track,
.siege-sync-row--urgent .siege-mobile-sync-track {
  box-shadow:
    inset 0 1px 2px rgba(0, 0, 0, 0.3),
    0 0 6px rgba(255, 80, 80, 0.2);
}
.siege-sync-row--urgent .siege-desktop-sync-fill,
.siege-sync-row--urgent .siege-mobile-sync-fill {
  background: linear-gradient(90deg, rgba(168, 61, 61, 0.55), rgba(255, 100, 100, 0.8));
  box-shadow: 0 0 10px rgba(255, 80, 80, 0.4), 0 0 3px rgba(255, 100, 100, 0.6);
}

@media (max-width: 768px) {
  .siege-mobile-only { display: block; }
  .siege-desktop-only { display: none; }
}

/* === 移动端样式 === */
.siege-mobile-sync-row {
  --siege-sync-h: 6px;
  --siege-accent: rgba(92, 158, 255, 0.85);
  --siege-accent-dim: rgba(61, 111, 168, 0.55);
  --siege-glow: rgba(92, 158, 255, 0.35);
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 4px 10px;
}

.siege-mobile-sync-track {
  flex: 1;
  min-width: 0;
  height: var(--siege-sync-h);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  box-shadow:
    inset 0 1px 2px rgba(0, 0, 0, 0.3),
    0 0 0 1px rgba(255, 255, 255, 0.04);
  overflow: hidden;
  position: relative;
}

.siege-mobile-sync-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--siege-accent-dim), var(--siege-accent));
  box-shadow:
    0 0 8px var(--siege-glow),
    0 0 2px var(--siege-accent);
  transition: width 1s linear;
  position: relative;
  overflow: hidden;
}

.siege-mobile-sync-fill .siege-sync-fill-glow {
  position: absolute;
  top: 0; right: 0;
  width: 16px;
  height: 100%;
  background: radial-gradient(ellipse at right center, rgba(255,255,255,0.6), transparent 70%);
  animation: siege-pulse-glow 2s ease-in-out infinite;
}

.siege-mobile-sync-row--baby {
  --siege-accent: rgba(247, 181, 42, 0.85);
  --siege-accent-dim: rgba(201, 138, 30, 0.55);
  --siege-glow: rgba(247, 181, 42, 0.35);
}

.siege-mobile-legend {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px 12px;
  margin-bottom: 8px;
}

.siege-mobile-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.72rem;
  font-weight: 700;
}

.siege-mobile-legend-dot {
  width: 12px;
  height: 12px;
  border-radius: 2px;
  flex-shrink: 0;
}

.siege-mobile-legend-name {
  color: var(--text, #e8eef7);
}

.siege-mobile-minute-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  padding: 0 4px;
}

.siege-mobile-section-title {
  font-size: 0.88rem;
  font-weight: 800;
  color: var(--text, #e8eef7);
}

.siege-mobile-section {
  margin-bottom: 12px;
  padding: 0 4px;
}

.siege-mobile-ratio-header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.siege-mobile-grid {
  margin-bottom: 12px;
  padding: 0 4px;
}

.siege-mobile-cell {
  aspect-ratio: 1;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.55rem;
  font-weight: 900;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  line-height: 1;
}

.siege-mobile-cell--flash {
  animation: siege-cell-flash 0.6s ease-in-out 4;
}

@keyframes siege-cell-flash {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* === Cities layout: 2 rows above countdown === */
.siege-cities-layout {
  width: 100%;
  margin-bottom: 0.6rem;
}

/* Row 1: 5 cities (A B C D E), aligned with minute-section edges */
.siege-cities-row1 {
  display: flex;
  justify-content: space-between;
  align-items: stretch;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

/* Row 2: F + ratio panel + G */
.siege-cities-row2 {
  display: flex;
  align-items: stretch;
  gap: 0.5rem;
}

.siege-city-item {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.siege-city-item--side {
  /* Same width as row1 items: 1/5 of container */
  width: calc((100% - 2rem) / 5);
  align-items: stretch;
}

.siege-cities-row1 .siege-city-item {
  width: calc((100% - 2rem) / 5);
  min-width: 0;
  flex: 0 0 auto;
}

.siege-ratio-panel--inline {
  flex: 1;
  min-width: 0;
  max-width: none;
  margin: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.siege-city-img {
  border-radius: 8px;
  border: 3px solid var(--city-accent, rgba(212, 175, 55, 0.6));
  box-shadow: 0 0 10px color-mix(in srgb, var(--city-accent, #d4af37) 50%, transparent), 0 2px 6px rgba(0, 0, 0, 0.3);
  object-fit: cover;
}

/* F / G tall images: fill the full height of row2 */
.siege-city-img--tall {
  aspect-ratio: auto;
  max-width: none;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
