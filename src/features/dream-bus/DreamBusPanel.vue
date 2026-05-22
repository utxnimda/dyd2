<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import DreamBusRouteBoard from "./DreamBusRouteBoard.vue";
import DreamBusStationIcon from "./DreamBusStationIcon.vue";
import { DREAM_BUS_LABEL_PRESETS } from "./dreamBusStationLabelLayout";
import {
  fetchDreamBusConfig,
  fetchDreamBusLive,
  fetchDreamBusRecords,
  dreamBusArrivalClock,
  dreamBusStationAccent,
  dreamBusStationName,
  type DreamBusConfig,
  type DreamBusLive,
  type DreamBusRecord,
  type DreamBusStation,
} from "./dreamBusApi";
import { dreamBusValueTier } from "./dreamBusMapLayout";
import { prefetchDreamBusVoices } from "./dreamBusArrivalVoice";

const config = ref<DreamBusConfig | null>(null);
const live = ref<DreamBusLive | null>(null);
const records = ref<DreamBusRecord[]>([]);
const tick = ref(0);
let tickTimer: ReturnType<typeof setInterval> | null = null;
let eventSource: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const selectedHours = ref(2);
const selectedRange = computed(() => selectedHours.value * 60);
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i + 1);

type RatioMode = "hour" | "day";
const ratioMode = ref<RatioMode>("hour");
const ratioValue = ref(1);
const RATIO_HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i + 1);
const RATIO_DAY_OPTIONS = Array.from({ length: 7 }, (_, i) => i + 1);

const stations = computed<DreamBusStation[]>(() =>
  [...(config.value?.stations ?? [])].sort((a, b) => a.stationId - b.stationId),
);

const minuteRows = computed(() =>
  records.value.slice(0, selectedRange.value).map((row) => {
    const st = stations.value.find((s) => s.stationId === row.hitStation);
    return {
      arrivalClock: dreamBusArrivalClock(row.sessionId, row.createTime, row.timeLabel),
      stationId: row.hitStation,
      stationName: dreamBusStationName(stations.value, row.hitStation),
      multiple: st?.multiple,
      accent: dreamBusStationAccent(row.hitStation),
    };
  }),
);

const stationRatioStats = computed(() => {
  const takeCount =
    ratioMode.value === "hour"
      ? ratioValue.value * 60
      : ratioValue.value * 1440;
  const filtered = records.value.slice(0, takeCount);
  const total = filtered.length;
  const countMap = new Map<number, number>();
  for (const r of filtered) {
    countMap.set(r.hitStation, (countMap.get(r.hitStation) ?? 0) + 1);
  }
  const ids = stations.value.length
    ? stations.value.map((s) => s.stationId)
    : Array.from({ length: 12 }, (_, i) => i + 1);
  return ids
    .map((stationId) => {
      const count = countMap.get(stationId) ?? 0;
      const st = stations.value.find((s) => s.stationId === stationId);
      return {
        stationId,
        stationName: st?.stationName ?? `站${stationId}`,
        multiple: st?.multiple,
        accent: dreamBusStationAccent(stationId),
        configRate: st?.rate ?? 0,
        count,
        pct: total > 0 ? ((count / total) * 100).toFixed(1) : "0.0",
      };
    })
    .sort((a, b) => b.count - a.count);
});

function formatSessionLabel(sessionId: string): string {
  const s = String(sessionId || "");
  if (s.length >= 12) return `${s.slice(8, 10)}:${s.slice(10, 12)}`;
  return s;
}

async function loadConfig() {
  config.value = await fetchDreamBusConfig();
}

async function loadLive() {
  live.value = await fetchDreamBusLive();
}

async function loadRecords() {
  records.value = await fetchDreamBusRecords(1440);
}

async function reload() {
  await Promise.all([loadConfig(), loadLive(), loadRecords()]);
}

function connectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  const es = new EventSource("/__fmz_danmaku/events");
  es.addEventListener("dream-bus", (e) => {
    try {
      const d = JSON.parse(e.data) as {
        live?: DreamBusLive;
        record?: DreamBusRecord | null;
      };
      if (d.live) live.value = d.live;
      if (d.record) {
        const exists = records.value.some((r) => r.sessionId === d.record!.sessionId);
        if (!exists) {
          records.value.unshift({
            ...d.record,
            timeLabel: d.record.timeLabel ?? formatSessionLabel(d.record.sessionId),
          });
          if (records.value.length > 1440) records.value.length = 1440;
        }
      }
    } catch {
      /* ignore */
    }
  });
  eventSource = es;
}

function cellTier(multiple?: number): "high" | "mid" | "low" {
  return dreamBusValueTier(multiple ?? 0);
}

onMounted(() => {
  void prefetchDreamBusVoices();
  void reload();
  connectSSE();
  pollTimer = setInterval(() => {
    void loadLive();
  }, 10_000);
  tickTimer = setInterval(() => {
    tick.value++;
  }, 1000);
});

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
  if (pollTimer) clearInterval(pollTimer);
  if (eventSource) eventSource.close();
});

defineExpose({ reload });
</script>

<template>
  <div class="dream-bus-panel">
    <header class="db-header">
      <h2 class="db-title">宝宝巴士 · 到站观测</h2>
    </header>

    <DreamBusRouteBoard class="db-route-board" :config="config" :live="live" :clock="tick" />

    <section class="db-section db-stats">
      <header class="db-section-head">
        <div class="db-section-title-wrap">
          <h3 class="db-section-title">近 {{ minuteRows.length }} 次到站</h3>
        </div>
        <div class="db-toolbar">
          <label class="db-field">
            <select v-model.number="selectedHours" class="db-select" aria-label="到站范围">
              <option v-for="h in HOUR_OPTIONS" :key="h" :value="h">{{ h }} 小时</option>
            </select>
          </label>
        </div>
      </header>
      <div v-if="minuteRows.length === 0" class="db-empty">暂无到站记录（请确认弹幕服务已连接直播间）</div>
      <div v-else class="db-grid">
        <div
          v-for="(row, i) in minuteRows"
          :key="row.arrivalClock + '-' + i"
          class="db-cell"
          :class="[
            `db-cell--tier-${cellTier(row.multiple)}`,
            { 'db-cell--flash': i === 0 },
          ]"
          :style="{ '--db-cell-accent': row.accent }"
          :title="`${row.arrivalClock} ${row.stationName}`"
        >
          <DreamBusStationIcon
            :station-id="row.stationId"
            size="36px"
            show-label
            :label-max-width="DREAM_BUS_LABEL_PRESETS.grid.maxWidth"
            :label-font-scale="DREAM_BUS_LABEL_PRESETS.grid.fontScale"
            :label-multiple="row.multiple"
          />
          <span class="db-cell-time">{{ row.arrivalClock }}</span>
        </div>
      </div>
    </section>

    <section class="db-section db-ratio">
      <header class="db-section-head">
        <div class="db-section-title-wrap">
          <h3 class="db-section-title">站点出现比例</h3>
        </div>
        <div class="db-toolbar">
          <div class="db-segment" role="group" aria-label="统计粒度">
            <button
              type="button"
              class="db-segment-btn"
              :class="{ 'db-segment-btn--on': ratioMode === 'hour' }"
              @click="ratioMode = 'hour'; ratioValue = 1"
            >
              按小时
            </button>
            <button
              type="button"
              class="db-segment-btn"
              :class="{ 'db-segment-btn--on': ratioMode === 'day' }"
              @click="ratioMode = 'day'; ratioValue = 1"
            >
              按天
            </button>
          </div>
          <label class="db-field">
            <select
              v-model.number="ratioValue"
              class="db-select"
              :aria-label="ratioMode === 'hour' ? '统计小时数' : '统计天数'"
            >
              <template v-if="ratioMode === 'hour'">
                <option v-for="h in RATIO_HOUR_OPTIONS" :key="h" :value="h">{{ h }} 小时</option>
              </template>
              <template v-else>
                <option v-for="d in RATIO_DAY_OPTIONS" :key="d" :value="d">{{ d }} 天</option>
              </template>
            </select>
          </label>
        </div>
      </header>
      <div class="db-ratio-grid">
        <div
          v-for="s in stationRatioStats"
          :key="'ratio-' + s.stationId"
          class="db-ratio-item"
          :class="`db-ratio-item--tier-${cellTier(s.multiple)}`"
          :style="{ '--db-cell-accent': s.accent }"
        >
          <DreamBusStationIcon :station-id="s.stationId" size="24px" />
          <div class="db-ratio-item-main">
            <div class="db-ratio-item-head">
              <span class="db-ratio-name">{{ s.stationName }}</span>
              <span v-if="s.multiple != null" class="db-ratio-mult">{{ s.multiple }}</span>
              <span class="db-ratio-pct">{{ s.pct }}%</span>
              <span class="db-ratio-n">{{ s.count }}</span>
            </div>
            <div class="db-ratio-bar-wrap">
              <div class="db-ratio-bar" :style="{ width: s.pct + '%' }" />
            </div>
          </div>
          <span class="db-ratio-config" title="配置概率">{{ s.configRate }}%</span>
        </div>
      </div>
    </section>

  </div>
</template>

<style scoped>
.dream-bus-panel {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 1rem;
  padding: 0.5rem 1rem 2rem;
  max-width: 72rem;
  width: min(100%, 72rem);
  margin: 0 auto;
  box-sizing: border-box;
}

.db-header {
  text-align: center;
}

.db-route-board {
  width: 100%;
}

.db-title {
  margin: 0;
  font-size: 1.35rem;
}

.db-section {
  border: 1px solid color-mix(in srgb, var(--fg, #eee) 12%, transparent);
  border-radius: 10px;
  padding: 0.75rem 0.85rem 0.85rem;
  width: 100%;
  box-sizing: border-box;
  background: color-mix(in srgb, var(--fg, #eee) 4%, transparent);
}

.db-section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 0.65rem 1rem;
  margin-bottom: 0.75rem;
  padding-bottom: 0.65rem;
  border-bottom: 1px solid color-mix(in srgb, var(--fg, #eee) 10%, transparent);
}

.db-section-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.db-section-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.25;
}

.db-section-sub {
  font-size: 0.78rem;
  opacity: 0.62;
  font-variant-numeric: tabular-nums;
}

.db-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem 0.65rem;
  margin-left: auto;
}

.db-field {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.db-field-label {
  font-size: 0.76rem;
  opacity: 0.62;
  white-space: nowrap;
}

.db-select {
  appearance: none;
  min-height: 2rem;
  min-width: 6.5rem;
  padding: 0.28rem 1.85rem 0.28rem 0.65rem;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--fg, #eee) 18%, transparent);
  background-color: color-mix(in srgb, var(--fg, #eee) 5%, var(--bg, #111));
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23aaa' d='M2.5 4.5 6 8l3.5-3.5'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.55rem center;
  color: inherit;
  font-size: 0.84rem;
  font-weight: 500;
  line-height: 1.2;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    background-color 0.15s ease;
}

.db-select:hover {
  border-color: color-mix(in srgb, var(--accent, #f7b52a) 35%, transparent);
}

.db-select:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--accent, #f7b52a) 55%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #f7b52a) 22%, transparent);
}

.db-segment {
  display: inline-flex;
  padding: 2px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--fg, #eee) 14%, transparent);
  background: color-mix(in srgb, var(--fg, #eee) 5%, transparent);
}

.db-segment-btn {
  min-height: 1.85rem;
  padding: 0.2rem 0.65rem;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font-size: 0.78rem;
  font-weight: 500;
  cursor: pointer;
  opacity: 0.72;
  transition:
    background 0.15s ease,
    opacity 0.15s ease,
    color 0.15s ease;
}

.db-segment-btn:hover {
  opacity: 1;
}

.db-segment-btn--on {
  opacity: 1;
  color: color-mix(in srgb, var(--accent, #f7b52a) 88%, #fff);
  background: color-mix(in srgb, var(--accent, #f7b52a) 22%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent, #f7b52a) 35%, transparent);
}

.db-empty {
  font-size: 0.85rem;
  opacity: 0.65;
  padding: 0.35rem 0 0.15rem;
}

.db-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 44px);
  gap: 3px;
  width: 100%;
  justify-content: center;
}

.db-cell {
  box-sizing: border-box;
  width: 44px;
  padding: 2px 1px 1px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  gap: 0;
  border-radius: 4px;
  border: 1.5px solid color-mix(in srgb, var(--db-cell-accent, #888) 58%, transparent);
  overflow: hidden;
  background: transparent;
  isolation: isolate;
}

.db-cell :deep(.db-st-stack) {
  gap: 0;
  width: 100%;
}

.db-cell :deep(.db-st-stack--labeled) {
  gap: 0;
}

.db-cell-time {
  font-size: 0.52rem;
  line-height: 1.05;
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
  margin-top: 1px;
}

.db-cell--tier-low,
.db-ratio-item--tier-low {
  background: color-mix(in srgb, var(--db-cell-accent, #888) 5%, transparent);
  border-width: 1.5px;
  box-shadow: none;
  animation: none;
}

.db-cell--tier-mid,
.db-ratio-item--tier-mid {
  border-width: 2.5px;
  background: linear-gradient(
    160deg,
    color-mix(in srgb, var(--db-cell-accent, #888) 24%, transparent),
    color-mix(in srgb, var(--db-cell-accent, #888) 17%, transparent)
  );
  animation: db-cell-glow-soft 2.2s ease-in-out infinite;
}

@keyframes db-cell-glow-soft {
  0%,
  100% {
    border-color: color-mix(in srgb, var(--db-cell-accent, #888) 52%, transparent);
    box-shadow: 0 0 1px color-mix(in srgb, var(--db-cell-accent, #888) 24%, transparent);
  }
  50% {
    border-color: color-mix(in srgb, var(--db-cell-accent, #888) 82%, transparent);
    box-shadow: 0 0 5px color-mix(in srgb, var(--db-cell-accent, #888) 42%, transparent);
  }
}

.db-cell--tier-high,
.db-ratio-item--tier-high {
  position: relative;
  border-width: 3px;
  background: linear-gradient(
    145deg,
    color-mix(in srgb, var(--db-cell-accent, #888) 62%, transparent) 0%,
    color-mix(in srgb, var(--db-cell-accent, #888) 44%, transparent) 48%,
    color-mix(in srgb, var(--db-cell-accent, #888) 58%, #000 5%) 100%
  );
  animation: db-cell-glow-strong 1.4s ease-in-out infinite;
}

.db-cell--tier-high::after,
.db-ratio-item--tier-high::after {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  border-radius: inherit;
  background: linear-gradient(
    115deg,
    transparent 0%,
    color-mix(in srgb, var(--db-cell-accent, #888) 22%, #fff) 42%,
    transparent 72%
  );
  opacity: 0.2;
  animation: db-cell-shimmer 2.1s ease-in-out infinite;
  pointer-events: none;
}

.db-cell--tier-high > *,
.db-ratio-item--tier-high > * {
  position: relative;
  z-index: 1;
}

@keyframes db-cell-shimmer {
  0%,
  100% {
    opacity: 0.12;
    transform: translateX(-35%) skewX(-10deg);
  }
  50% {
    opacity: 0.65;
    transform: translateX(35%) skewX(-10deg);
  }
}

@keyframes db-cell-glow-strong {
  0%,
  100% {
    border-color: color-mix(in srgb, var(--db-cell-accent, #888) 55%, transparent);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--db-cell-accent, #888) 35%, transparent),
      0 0 4px color-mix(in srgb, var(--db-cell-accent, #888) 38%, transparent),
      0 0 8px color-mix(in srgb, var(--db-cell-accent, #888) 18%, transparent);
  }
  50% {
    border-color: var(--db-cell-accent, #888);
    box-shadow:
      0 0 0 2px color-mix(in srgb, var(--db-cell-accent, #888) 55%, transparent),
      0 0 8px color-mix(in srgb, var(--db-cell-accent, #888) 72%, transparent),
      0 0 14px color-mix(in srgb, var(--db-cell-accent, #888) 48%, transparent);
  }
}

.db-cell--tier-mid.db-cell--flash,
.db-cell--tier-high.db-cell--flash {
  outline: 2px solid var(--db-cell-accent, var(--accent, #f7b52a));
  outline-offset: 1px;
}

.db-cell--tier-low.db-cell--flash {
  outline: 2px solid var(--accent, #f7b52a);
  outline-offset: 1px;
}

.db-ratio-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(15.5rem, 1fr));
  gap: 0.45rem 0.65rem;
}

.db-ratio-item {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 0.35rem 0.45rem;
  padding: 0.38rem 0.5rem;
  border-radius: 8px;
  border: 1.5px solid color-mix(in srgb, var(--db-cell-accent, #888) 58%, transparent);
  background: transparent;
  overflow: hidden;
  isolation: isolate;
  box-sizing: border-box;
  font-size: 0.68rem;
}

.db-ratio-item-main {
  min-width: 0;
}

.db-ratio-item-head {
  display: flex;
  align-items: baseline;
  gap: 0.25rem;
  margin-bottom: 0.18rem;
  line-height: 1.2;
}

.db-ratio-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.db-ratio-mult {
  opacity: 0.55;
  font-size: 0.62rem;
}

.db-ratio-config {
  opacity: 0.45;
  font-size: 0.6rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.db-ratio-bar-wrap {
  height: 0.28rem;
  background: color-mix(in srgb, var(--fg, #eee) 7%, transparent);
  border-radius: 999px;
  overflow: hidden;
}

.db-ratio-bar {
  height: 100%;
  border-radius: inherit;
  min-width: 2px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--db-cell-accent, #888) 85%, #000),
    var(--db-cell-accent, #888)
  );
  transition: width 0.3s ease;
}

.db-ratio-pct {
  margin-left: auto;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  font-size: 0.66rem;
}

.db-ratio-n {
  opacity: 0.5;
  font-size: 0.6rem;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 640px) {
  .db-section-head {
    align-items: stretch;
  }

  .db-toolbar {
    width: 100%;
    margin-left: 0;
    justify-content: stretch;
  }

  .db-field {
    flex: 1;
  }

  .db-select {
    flex: 1;
    min-width: 0;
  }

  .db-grid {
    grid-template-columns: repeat(auto-fill, 42px);
    gap: 2px;
  }

  .db-cell {
    width: 42px;
  }

  .db-ratio-grid {
    grid-template-columns: 1fr;
  }
}
</style>
