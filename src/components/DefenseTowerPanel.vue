<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  fetchDefenseOverview,
  fetchDefenseRecentAttacks,
  fetchPrediction,
  secondsToUpstreamSyncTick,
  type DefenseAttackRow,
  type DefenseOverview,
  type PredictionData,
} from "../lib/defenseTowerApi";
import SiegeOrbitBoard from "./SiegeOrbitBoard.vue";

const overview = ref<DefenseOverview | null>(null);
const recentAttacks = ref<DefenseAttackRow[]>([]);
const prediction = ref<PredictionData | null>(null);
const tick = ref(0);
let tickTimer: ReturnType<typeof setInterval> | null = null;

const countdownSec = computed(() => {
  void tick.value;
  return secondsToUpstreamSyncTick();
});

const snap = computed(() => overview.value?.snapshot ?? null);

async function loadOverview() {
  try {
    overview.value = await fetchDefenseOverview();
  } catch {
    overview.value = null;
  }
}

async function loadRecentAttacks() {
  try {
    const data = await fetchDefenseRecentAttacks(1440);
    recentAttacks.value = data.rows;
  } catch {
    // keep old data
  }
}

async function loadPrediction() {
  try {
    prediction.value = await fetchPrediction();
  } catch {
    // keep old data
  }
}

async function reload() {
  await Promise.all([loadOverview(), loadRecentAttacks(), loadPrediction()]);
}

let reloading = false;
let lastPollSec = 0;

/** 当前分钟标签，如 "12:37" */
function currentMinuteLabel(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 最新一条记录是否已经是当前分钟的 */
function hasCurrentMinuteData(): boolean {
  if (recentAttacks.value.length === 0) return false;
  return recentAttacks.value[0].attack_time_label === currentMinuteLabel();
}

/**
 * 每秒检测：
 * - 过了第 50 秒且还没拿到当前分钟数据 → 每 2 秒拉取
 * - 已经拿到当前分钟数据 → 每 10 秒常规拉取
 */
function onTick() {
  tick.value++;
  if (reloading) return;

  const sec = new Date().getSeconds();
  const elapsed = sec - lastPollSec;

  if (sec >= 50 && !hasCurrentMinuteData()) {
    // 追赶模式：每2秒拉一次
    if (elapsed >= 2 || elapsed < 0) {
      reloading = true;
      lastPollSec = sec;
      void reload().finally(() => { reloading = false; });
    }
  } else {
    // 常规模式：每10秒拉一次
    if (elapsed >= 10 || elapsed < 0) {
      reloading = true;
      lastPollSec = sec;
      void reload().finally(() => { reloading = false; });
    }
  }
}

onMounted(() => {
  void reload();
  tickTimer = setInterval(onTick, 1000);
});

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
});

defineExpose({ load: reload, reload });
</script>

<template>
  <section class="siege-panel-minimal">
    <SiegeOrbitBoard
      :report="snap?.report"
      :seconds-to-sync="countdownSec"
      :clock="tick"
      :recent-attacks="recentAttacks"
      :prediction="prediction"
    />
  </section>
</template>

<style scoped>
.siege-panel-minimal {
  padding: 0;
}
</style>
