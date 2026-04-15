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
let lastPollTick = 0;

/**
 * 每秒检测：
 * - 倒计时 10~0 秒时每秒强制同步
 * - 其他时候每 10 秒同步一次
 */
function onTick() {
  tick.value++;
  if (reloading) return;
  const countdown = secondsToUpstreamSyncTick();
  const now = tick.value;

  if (countdown <= 10) {
    // 倒计时最后10秒，每秒同步
    reloading = true;
    lastPollTick = now;
    void reload().finally(() => { reloading = false; });
  } else if (now - lastPollTick >= 10) {
    // 其他时候每10秒同步一次
    reloading = true;
    lastPollTick = now;
    void reload().finally(() => { reloading = false; });
  }
}

onMounted(() => {
  void reload();
  lastPollTick = 0;
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
