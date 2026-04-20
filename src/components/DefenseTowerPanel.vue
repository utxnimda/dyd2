<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  fetchDefenseOverview,
  fetchDefenseRecentAttacks,
  secondsToUpstreamSyncTick,
  type DefenseAttackRow,
  type DefenseOverview,
} from "../lib/defenseTowerApi";
import SiegeOrbitBoard from "./SiegeOrbitBoard.vue";

const overview = ref<DefenseOverview | null>(null);
const recentAttacks = ref<DefenseAttackRow[]>([]);
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

async function reload() {
  await Promise.all([loadOverview(), loadRecentAttacks()]);
}

let reloading = false;
let lastPollSec = 0; // 上次拉取的时间戳 ms

/** 当前分钟标签，如 "12:37" */
function currentMinuteLabel(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Check whether the latest snapshot was fetched after the current minute's
 * :50 mark. This is more reliable than checking attack_time_label because
 * not every minute has a siege event.
 */
function hasCurrentMinuteData(): boolean {
  const fetchedAt = overview.value?.snapshot?.fetchedAt;
  if (!fetchedAt) return false;
  const now = new Date();
  // The upstream refreshes at :50 of each minute.
  // Build a timestamp for the current minute's :50 mark.
  const mark = new Date(now);
  mark.setSeconds(50, 0);
  // If we haven't reached :50 yet this minute, use last minute's :50
  if (now < mark) mark.setMinutes(mark.getMinutes() - 1);
  return fetchedAt >= mark.getTime();
}

/**
 * 每秒检测：
 * - 倒计时到0后（即过了每分钟第50秒），还没拿到当前分钟数据 → 每2秒尝试拉取，最多尝试5次
 * - 已有当前分钟数据 → 每10秒常规拉取
 */
function onTick() {
  tick.value++;
  if (reloading) return;

  const now = Date.now();
  const countdown = secondsToUpstreamSyncTick();
  const elapsed = now - lastPollSec;
  const currentSecond = new Date().getSeconds();

  if (countdown === 0 || (currentSecond >= 50 && !hasCurrentMinuteData())) {
    // 倒计时归零或过了50秒还没数据：每2秒尝试拉取，最多尝试5次（50-60秒区间）
    if (!hasCurrentMinuteData() && elapsed >= 2000 && currentSecond <= 60) {
      reloading = true;
      lastPollSec = now;
      void reload().finally(() => { reloading = false; });
    }
  } else {
    // 常规：每10秒拉
    if (elapsed >= 10_000) {
      reloading = true;
      lastPollSec = now;
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
    />
  </section>
</template>

<style scoped>
.siege-panel-minimal {
  padding: 0;
}
</style>
