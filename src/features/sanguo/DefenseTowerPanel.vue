<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  fetchDefenseOverview,
  fetchDefenseRecentAttacks,
  secondsToUpstreamSyncTick,
  type DefenseAttackRow,
  type DefenseOverview,
} from "./defenseTowerApi";
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
let lastPollMs = 0; // last poll timestamp (ms)
let retryCount = 0; // retry counter within the :50 window
const MAX_RETRIES = 6; // max retries after :50 (covers ~12s window)

/** 当前分钟标签，如 "12:37" */
function currentMinuteLabel(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Check whether the latest snapshot already contains the current minute's
 * data by looking at the report_minute array for the current HH:MM label.
 * This is more reliable than checking fetchedAt because the server may
 * have fetched but upstream hadn't refreshed yet.
 */
function hasCurrentMinuteData(): boolean {
  const report = overview.value?.snapshot?.report;
  if (!report || !Array.isArray(report.report_minute)) return false;
  const label = currentMinuteLabel();
  for (const entry of report.report_minute) {
    if (entry && typeof entry === "object") {
      const keys = Object.keys(entry);
      if (keys.length > 0 && keys[0] === label) return true;
    }
  }
  return false;
}

/**
 * Every-second tick handler:
 * - When countdown reaches 0 (second >= 50), start aggressive polling
 *   every 2s until we get the current minute's data or exhaust retries.
 * - Once we have the data (or outside the :50 window), poll every 10s.
 */
function onTick() {
  tick.value++;
  if (reloading) return;

  const now = Date.now();
  const elapsed = now - lastPollMs;
  const sec = new Date().getSeconds();

  // Inside the :50 window (sec >= 50 or sec < 4 of next minute after wrap)
  const inSyncWindow = sec >= 50 || sec < 4;

  if (inSyncWindow && !hasCurrentMinuteData() && retryCount < MAX_RETRIES) {
    // Aggressive: poll every 2s
    if (elapsed >= 2000) {
      reloading = true;
      lastPollMs = now;
      retryCount++;
      void reload().finally(() => { reloading = false; });
    }
  } else {
    // Reset retry counter when we leave the sync window or got data
    if (!inSyncWindow || hasCurrentMinuteData()) {
      retryCount = 0;
    }
    // Normal: poll every 10s
    if (elapsed >= 10_000) {
      reloading = true;
      lastPollMs = now;
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
