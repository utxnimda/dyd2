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
let chasingMinute = ""; // 正在追赶的分钟标签（HH:MM）

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
 * - 倒计时 10~0 秒时每秒强制同步
 * - 过了 50 秒还没拿到当前分钟数据 → 每 2 秒追赶拉取
 * - 其他时候每 10 秒同步一次
 */
function onTick() {
  tick.value++;
  if (reloading) return;

  const sec = new Date().getSeconds();
  const countdown = secondsToUpstreamSyncTick();
  const now = tick.value;

  // 追赶模式：过了 50 秒，当前分钟数据还没拿到
  if (sec >= 50 && !hasCurrentMinuteData()) {
    const label = currentMinuteLabel();
    if (chasingMinute !== label) {
      chasingMinute = label;
    }
    // 每 2 秒重试
    if (now - lastPollTick >= 2) {
      reloading = true;
      lastPollTick = now;
      void reload().finally(() => { reloading = false; });
    }
    return;
  }

  // 追赶成功，清除状态
  if (chasingMinute && hasCurrentMinuteData()) {
    chasingMinute = "";
  }

  if (countdown <= 10) {
    reloading = true;
    lastPollTick = now;
    void reload().finally(() => { reloading = false; });
  } else if (now - lastPollTick >= 10) {
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
