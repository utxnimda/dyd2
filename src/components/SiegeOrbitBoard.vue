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
import type { WeeklyReport, DefenseAttackRow, PredictionData, PredictionCity, NextCityProb } from "../lib/defenseTowerApi";
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
  prediction: PredictionData | null;
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

/** 找到最适合的每行个数：必须是 total 的约数，优先选 6~15 范围内的 */
function bestColumnsForTotal(total: number): number {
  if (total <= 0) return 1;
  const divisors: number[] = [];
  for (let d = 1; d <= total; d++) {
    if (total % d === 0) divisors.push(d);
  }
  // 优先选 6~15 范围内的约数
  const preferred = divisors.filter((d) => d >= 6 && d <= 15);
  if (preferred.length > 0) return preferred[preferred.length - 1]!;
  // 其次选最接近 10 的
  divisors.sort((a, b) => Math.abs(a - 10) - Math.abs(b - 10));
  return divisors[0]!;
}

const gridColumns = computed(() => bestColumnsForTotal(dbMinuteRows.value.length));

const gridStyle = computed(() => ({
  display: "grid",
  gridTemplateColumns: `repeat(${gridColumns.value}, 1fr)`,
  gap: "6px",
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

/** 按时间维度分组统计各城市出现比例 */
const cityRatioStats = computed(() => {
  const now = Date.now();
  const windowMs = ratioMode.value === "hour"
    ? ratioValue.value * 60 * 60_000
    : ratioValue.value * 24 * 60 * 60_000;
  const cutoff = now - windowMs;
  const filtered = props.recentAttacks.filter((r) => r.attack_at >= cutoff);
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

/** 预警数据直接来自服务端 /api/prediction */
const cityAlerts = computed(() => {
  const cities = props.prediction?.cities ?? [];
  return cities.map((c) => ({
    ...c,
    accent: CITY_ACCENT[c.cityId] || "#69A7BF",
  }));
});

const smallCityStreak = computed(() => props.prediction?.smallCityStreak ?? 0);

const nextCityProbs = computed(() => {
  const ALL_CITY_IDS = ["1", "2", "3", "4", "5", "6", "7"];
  const serverProbs = props.prediction?.nextCityProbs ?? [];
  const probMap = new Map(serverProbs.map((p) => [p.cityId, p]));
  return ALL_CITY_IDS
    .map((cityId) => {
      const sp = probMap.get(cityId);
      return {
        cityId,
        cityName: sp?.cityName || DEFENSE_SIEGE_CITY_NAMES[cityId] || cityId,
        accent: CITY_ACCENT[cityId] || "#69A7BF",
        count: sp?.count ?? 0,
        prob: sp?.prob ?? 0,
        pct: sp?.pct ?? "0.0",
      };
    })
    .sort((a, b) => b.prob - a.prob);
});

const lastCityName = computed(() => props.prediction?.lastCityName ?? "—");

const secondsToSync = computed(() => props.secondsToSync);

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
      <!-- 高能预警（紧凑版） -->
      <div class="siege-mobile-alert">
        <div class="siege-mobile-alert-title">⚡ 高能预警</div>
        <div class="siege-mobile-alert-cards">
          <div
            v-for="a in cityAlerts"
            :key="'ma-' + a.cityId"
            class="siege-mobile-alert-card"
            :class="'siege-mobile-alert-card--' + a.level"
          >
            <span class="siege-mobile-alert-city" :style="{ color: a.accent }">{{ a.cityName }}</span>
            <span class="siege-mobile-alert-mid">
              <span v-if="a.justAppeared" class="siege-mobile-alert-tag">刚出</span>
              <template v-else-if="a.predictedTimes.length">
                <span v-if="a.level === 'high'">🔴</span>
                <span v-else-if="a.level === 'medium'">🟡</span>
                <span v-else-if="a.level === 'low'">🟢</span>
                <span v-else>⚪</span>
                <span class="siege-mobile-alert-times">{{ a.predictedTimes.slice(0, 2).join(', ') }}</span>
              </template>
              <template v-else><span>⚪</span></template>
            </span>
            <span v-if="a.sinceLastMin != null" class="siege-mobile-alert-since">{{ a.sinceLastMin }}分前</span>
          </div>
        </div>
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
        <div class="siege-mobile-section-title">下一城概率 <span class="siege-next-last-inline">当前: {{ lastCityName }}</span></div>
        <div v-for="p in nextCityProbs" :key="'mn-' + p.cityId" class="siege-next-row">
          <span class="siege-next-city" :style="{ color: p.accent }">{{ p.cityName }}</span>
          <div class="siege-next-bar-wrap">
            <div class="siege-next-bar" :style="{ width: p.pct + '%', backgroundColor: p.accent }" />
          </div>
          <span class="siege-next-pct">{{ p.pct }}%</span>
        </div>
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
        </div>
      </div>
    </div>

    <!-- ===== 桌面端布局 ===== -->
    <div class="siege-desktop-only">
    <div class="siege-orbit-row">
      <div class="siege-next-panel">
        <div class="siege-next-title">下一城概率</div>
        <div class="siege-next-last">当前: <strong>{{ lastCityName }}</strong></div>
        <div v-if="nextCityProbs.length === 0" class="siege-next-empty">数据不足</div>
        <div v-for="p in nextCityProbs" :key="p.cityId" class="siege-next-row">
          <span class="siege-next-city" :style="{ color: p.accent }">{{ p.cityName }}</span>
          <div class="siege-next-bar-wrap">
            <div class="siege-next-bar" :style="{ width: p.pct + '%', backgroundColor: p.accent }" />
          </div>
          <span class="siege-next-pct">{{ p.pct }}%</span>
        </div>
      </div>
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

    <div class="siege-ratio-panel">
      <div class="siege-ratio-header">
        <span class="siege-ratio-title">城市出现比例</span>
        <div class="siege-ratio-mode">
          <button
            type="button"
            class="siege-range-btn"
            :class="{ 'siege-range-btn--active': ratioMode === 'hour' }"
            @click="ratioMode = 'hour'; ratioValue = 1"
          >按小时</button>
          <button
            type="button"
            class="siege-range-btn"
            :class="{ 'siege-range-btn--active': ratioMode === 'day' }"
            @click="ratioMode = 'day'; ratioValue = 1"
          >按天</button>
        </div>
      </div>
      <div class="siege-ratio-controls">
        <label class="siege-ratio-select-wrap">
          最近
          <select v-model.number="ratioValue" class="siege-hour-select">
            <template v-if="ratioMode === 'hour'">
              <option v-for="h in RATIO_HOUR_OPTIONS" :key="h" :value="h">{{ h }}</option>
            </template>
            <template v-else>
              <option v-for="d in RATIO_DAY_OPTIONS" :key="d" :value="d">{{ d }}</option>
            </template>
          </select>
          {{ ratioMode === 'hour' ? '小时' : '天' }}
        </label>
        <span class="siege-ratio-actual">（实际 {{ ratioFilteredCount }} 条记录）</span>
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
    </div>

    <div class="siege-alert-section">
      <div class="siege-alert-title">⚡ 高能预警 — 洛阳 · 成都 · 建业 · 荆州</div>
      <div class="siege-alert-disclaimer">仅供参考，请勿盲目</div>
      <div v-if="smallCityStreak > 0" class="siege-alert-streak">
        小城连打中：已连续 {{ smallCityStreak }} 次小城
      </div>
      <div class="siege-alert-cards">
        <div
          v-for="a in cityAlerts"
          :key="a.cityId"
          class="siege-alert-card"
          :class="'siege-alert-card--' + a.level"
          :style="{ '--alert-accent': a.accent }"
        >
          <div class="siege-alert-city" :style="{ color: a.accent }">
            {{ a.cityName }}
            <span v-if="a.justAppeared" class="siege-alert-just">刚出</span>
          </div>
          <img
            v-if="skinMode === 'baby' && CITY_YUCE_IMG[a.cityId]"
            :src="CITY_YUCE_IMG[a.cityId]"
            :alt="a.cityName + '预测'"
            class="siege-alert-img"
          />
          <div class="siege-alert-eta">
            <template v-if="a.justAppeared">⚪ 刚出现，短期概率低</template>
            <template v-else-if="a.predictedTimes.length">
              <span v-if="a.level === 'high'">🔴</span>
              <span v-else-if="a.level === 'medium'">🟡</span>
              <span v-else-if="a.level === 'low'">🟢</span>
              <span v-else>⚪</span>
              预测 {{ a.predictedTimes.join(', ') }}
            </template>
            <template v-else>⚪ 暂无预警</template>
          </div>
          <div class="siege-alert-pity">
            <span class="siege-alert-pity-label">保底</span>
            <div class="siege-alert-pity-bar-wrap">
              <div
                class="siege-alert-pity-bar"
                :style="{ width: (a.pityProgress * 100) + '%', backgroundColor: a.accent }"
              />
            </div>
            <span class="siege-alert-pity-text">{{ a.sinceLastMin ?? 0 }}分</span>
          </div>
          <div class="siege-alert-detail">
            <span>5分内 {{ (a.prob5min * 100).toFixed(0) }}%</span>
            <span v-if="a.eta50 != null"> · 50%概率 {{ a.eta50 }}分后</span>
          </div>
          <div class="siege-alert-reason">{{ a.reason }}</div>
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
      <div class="siege-minute-grid" :style="gridStyle">
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

.siege-next-panel {
  flex: 0 0 auto;
  min-width: 11rem;
  max-width: 15rem;
}

.siege-next-title {
  font-size: 0.9rem;
  font-weight: 800;
  color: var(--text, #e8eef7);
  margin-bottom: 0.35rem;
}

.siege-next-last {
  font-size: 0.78rem;
  color: var(--muted, #8b9cb3);
  margin-bottom: 0.45rem;
}

.siege-next-last strong {
  color: var(--text, #e8eef7);
}

.siege-next-empty {
  font-size: 0.78rem;
  color: var(--muted, #8b9cb3);
}

.siege-next-row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-bottom: 0.3rem;
}

.siege-next-city {
  font-size: 0.82rem;
  font-weight: 800;
  min-width: 2.5rem;
  text-align: right;
}

.siege-next-bar-wrap {
  flex: 1;
  height: 0.6rem;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 3px;
  overflow: hidden;
}

.siege-next-bar {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s;
}

.siege-next-pct {
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--text, #e8eef7);
  min-width: 2.8rem;
  text-align: right;
}

.siege-ratio-panel {
  flex: 0 0 auto;
  min-width: 14rem;
  max-width: 18rem;
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
  height: 0.7rem;
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

.siege-alert-section {
  width: 100%;
}

.siege-alert-title {
  font-size: 1rem;
  font-weight: 800;
  text-align: center;
  margin-bottom: 0.5rem;
  color: var(--text, #e8eef7);
}

.siege-alert-cards {
  display: flex;
  gap: 0.75rem;
  justify-content: center;
  flex-wrap: wrap;
}

.siege-alert-card {
  flex: 1 1 0;
  min-width: 12rem;
  max-width: 18rem;
  padding: 0.6rem 0.8rem;
  border-radius: 10px;
  background: rgba(10, 16, 28, 0.6);
  border: 1.5px solid rgba(255, 255, 255, 0.08);
  transition: border-color 0.3s;
}

.siege-alert-card--high {
  border-color: color-mix(in srgb, var(--alert-accent) 70%, #ff4444);
  background: linear-gradient(160deg, rgba(255, 50, 50, 0.12), rgba(10, 16, 28, 0.7));
}

.siege-alert-card--medium {
  border-color: color-mix(in srgb, var(--alert-accent) 60%, #ffaa00);
  background: linear-gradient(160deg, rgba(255, 170, 0, 0.08), rgba(10, 16, 28, 0.7));
}

.siege-alert-card--low {
  border-color: color-mix(in srgb, var(--alert-accent) 40%, #44cc66);
}

.siege-alert-city {
  font-size: 1rem;
  font-weight: 900;
  margin-bottom: 0.25rem;
}

.siege-alert-img {
  width: 100%;
  aspect-ratio: 10 / 7;
  object-fit: cover;
  object-position: top;
  border-radius: 6px;
  margin-bottom: 0.3rem;
}

.siege-alert-eta {
  font-size: 0.88rem;
  font-weight: 700;
  color: var(--text, #e8eef7);
  margin-bottom: 0.2rem;
}

.siege-alert-detail {
  font-size: 0.72rem;
  color: var(--muted, #8b9cb3);
  margin-bottom: 0.15rem;
}

.siege-alert-upstream {
  font-size: 0.72rem;
  color: var(--muted, #8b9cb3);
  margin-bottom: 0.1rem;
}

.siege-alert-hot {
  font-size: 0.68rem;
  color: var(--muted, #8b9cb3);
  font-variant-numeric: tabular-nums;
}

.siege-alert-disclaimer {
  text-align: center;
  font-size: 0.75rem;
  color: var(--muted, #8b9cb3);
  margin-bottom: 0.3rem;
  opacity: 0.7;
}

.siege-alert-streak {
  text-align: center;
  font-size: 0.82rem;
  font-weight: 700;
  color: #ffaa00;
  margin-bottom: 0.4rem;
}

.siege-alert-just {
  font-size: 0.65rem;
  font-weight: 600;
  background: rgba(255, 255, 255, 0.12);
  padding: 1px 5px;
  border-radius: 4px;
  margin-left: 0.3rem;
  color: var(--muted, #8b9cb3);
}

.siege-alert-pity {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin: 0.25rem 0;
}

.siege-alert-pity-label {
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--muted, #8b9cb3);
  min-width: 1.8rem;
}

.siege-alert-pity-bar-wrap {
  flex: 1;
  height: 0.5rem;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 3px;
  overflow: hidden;
}

.siege-alert-pity-bar {
  height: 100%;
  border-radius: 3px;
  transition: width 0.5s;
}

.siege-alert-pity-text {
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--text, #e8eef7);
  min-width: 2.5rem;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.siege-alert-reason {
  font-size: 0.65rem;
  color: var(--muted, #8b9cb3);
  margin-top: 0.15rem;
  opacity: 0.8;
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

@media (max-width: 768px) {
  .siege-mobile-only { display: block; }
  .siege-desktop-only { display: none; }
}

/* === 移动端样式 === */
.siege-mobile-alert {
  margin-bottom: 8px;
}

.siege-mobile-alert-title {
  font-size: 0.78rem;
  font-weight: 800;
  text-align: center;
  margin-bottom: 4px;
  color: var(--text, #e8eef7);
}

.siege-mobile-alert-cards {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.siege-mobile-alert-card {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 0.72rem;
  font-weight: 700;
  background: rgba(10, 16, 28, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.siege-mobile-alert-card--high {
  border-color: rgba(255, 50, 50, 0.5);
  background: rgba(255, 50, 50, 0.1);
}

.siege-mobile-alert-card--medium {
  border-color: rgba(255, 170, 0, 0.4);
  background: rgba(255, 170, 0, 0.08);
}

.siege-mobile-alert-city {
  font-weight: 900;
  min-width: 2rem;
}

.siege-mobile-alert-mid {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 3px;
}

.siege-mobile-alert-tag {
  font-size: 0.6rem;
  color: var(--muted, #8b9cb3);
}

.siege-mobile-alert-times {
  font-size: 0.68rem;
  color: var(--text, #e8eef7);
  font-variant-numeric: tabular-nums;
}

.siege-mobile-alert-since {
  font-size: 0.6rem;
  color: var(--muted, #8b9cb3);
  text-align: right;
  min-width: 3rem;
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

.siege-next-last-inline {
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--muted, #8b9cb3);
  margin-left: 6px;
}
</style>
