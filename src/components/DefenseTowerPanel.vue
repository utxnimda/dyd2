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
let pollTimer: ReturnType<typeof setInterval> | null = null;

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

let lastSyncReloadSec = -1; // 避免同一秒重复拉取
let reloading = false;

/** 每秒检测：秒数到 50-53 时立即拉取（上游在第 48 秒刷新，服务端在第 50 秒拉取） */
function onTick() {
  tick.value++;
  if (reloading) return;
  const sec = new Date().getSeconds();
  if (sec >= 50 && sec <= 53 && lastSyncReloadSec !== sec) {
    lastSyncReloadSec = sec;
    reloading = true;
    void reload().finally(() => { reloading = false; });
  }
}

onMounted(() => {
  void reload();
  tickTimer = setInterval(onTick, 1000);
  // 兜底轮询：防止对齐拉取因为某种原因错过
  pollTimer = setInterval(() => {
    if (!reloading) {
      reloading = true;
      void reload().finally(() => { reloading = false; });
    }
  }, 30_000);
});

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
  if (pollTimer) clearInterval(pollTimer);
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
