<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import DreamBusSprite from "./DreamBusSprite.vue";
import stationBoardUrl from "../../../image/dream-bus/station-board.png?url";
import {
  dreamBusRouteAnchorLayout,
  dreamBusRouteNeedsCompactLayout,
  dreamBusStopRowIndex,
  dreamBusStationTopPx,
  dreamBusWrapBusTopPx,
  dreamBusWrapRouteHeightPx,
  dreamBusWrapRowLineTopPx,
  dreamBusWrapRowStepPx,
  DREAM_BUS_MOBILE_ICON_PX,
  DREAM_BUS_MOBILE_LABEL_MAX_PX,
  DREAM_BUS_ROUTE_LAYOUT,
} from "./dreamBusSpriteLayout";
import {
  playDreamBusArrivalVoice,
  playDreamBusDepartureVoice,
  resetDreamBusArrivalVoiceSession,
  onDreamBusVoiceUnlockState,
} from "./dreamBusArrivalVoice";
import type { DreamBusConfig, DreamBusLive } from "./dreamBusApi";
import {
  buildValueRouteStops,
  buildStationDriveTimings,
  dreamBusDriveSegmentContext,
} from "./dreamBusMapLayout";
import { dreamBusLiveLeftSec } from "./dreamBusLiveClock";
import {
  createDreamBusRunnerAnimState,
  DREAM_BUS_DRIVE_SEGMENT_SEC,
  DREAM_BUS_REVEAL_SEC,
  dreamBusDisplaySeconds,
  dreamBusDriveDurationSec,
  dreamBusDriveProgress01,
  dreamBusRevealElapsedSec,
  dreamBusRunnerCountdownSec,
  dreamBusRunnerLeftPct,
  dreamBusRunnerTopPx,
  dreamBusRunnerUsesRunAnim,
  syncDreamBusRunnerFromLive,
  tickDreamBusRunnerAnim,
} from "./dreamBusRunnerAnim";
import { dreamBusNowMs } from "./dreamBusServerClock";
import DreamBusStationIcon from "./DreamBusStationIcon.vue";
import { DREAM_BUS_LABEL_PRESETS } from "./dreamBusStationLabelLayout";

const props = defineProps<{
  config: DreamBusConfig | null;
  live: DreamBusLive | null;
  clock: number;
}>();

const REVEAL_PHASE_SEC = DREAM_BUS_REVEAL_SEC;
const ROUTE_MOBILE_BP = 640;

const animState = reactive(createDreamBusRunnerAnimState());
const nowMs = ref(Date.now());
const postDepartCountdownTotalSec = ref(REVEAL_PHASE_SEC);
const isRouteMqMobile = ref(false);
let routeMobileMq: MediaQueryList | null = null;
let rafId = 0;
let unbindVoiceUnlockRetry: (() => void) | null = null;

function syncRouteMobile() {
  isRouteMqMobile.value = routeMobileMq?.matches ?? false;
}

const isRouteCompact = computed(() => {
  const stopCount = valueRouteStops.value.length;
  return (
    isRouteMqMobile.value ||
    dreamBusRouteNeedsCompactLayout(routeWidthPx.value, stopCount)
  );
});

const routeIconSize = computed(() => {
  if (isRouteMqMobile.value) return `${DREAM_BUS_MOBILE_ICON_PX}px`;
  return "50px";
});

const routeLabelPreset = computed(() => {
  if (isRouteMqMobile.value) {
    return {
      maxWidth: `${DREAM_BUS_MOBILE_LABEL_MAX_PX}px`,
      fontScale: 0.85,
    };
  }
  return DREAM_BUS_LABEL_PRESETS.route;
});

function startAnimLoop() {
  cancelAnimationFrame(rafId);
  const loop = () => {
    nowMs.value = dreamBusNowMs();
    tickDreamBusRunnerAnim(animState, props.live, nowMs.value, routeWaypoints.value);
    if (isWaiting.value) {
      void maybePlayDepartureVoice();
    } else {
      void maybePlayHoldVoice();
    }
    if (
      animState.phase === "wait" ||
      animState.phase === "drive" ||
      animState.phase === "hold" ||
      props.live?.status === "0" ||
      props.live?.status === "2"
    ) {
      rafId = requestAnimationFrame(loop);
    }
  };
  rafId = requestAnimationFrame(loop);
}

const routeEl = ref<HTMLElement | null>(null);
const routeWidthPx = ref(680);
let routeResizeObserver: ResizeObserver | null = null;

function syncRouteWidth() {
  routeWidthPx.value = routeEl.value?.clientWidth ?? 680;
}

onMounted(() => {
  syncRouteWidth();
  if (typeof window !== "undefined") {
    routeMobileMq = window.matchMedia(`(max-width: ${ROUTE_MOBILE_BP}px)`);
    syncRouteMobile();
    routeMobileMq.addEventListener("change", syncRouteMobile);
  }
  if (typeof ResizeObserver !== "undefined") {
    routeResizeObserver = new ResizeObserver(syncRouteWidth);
    if (routeEl.value) routeResizeObserver.observe(routeEl.value);
  }
  unbindVoiceUnlockRetry = onDreamBusVoiceUnlockState((unlocked) => {
    if (unlocked) syncVoiceAfterLive(props.live);
  });
});

onUnmounted(() => {
  cancelAnimationFrame(rafId);
  routeResizeObserver?.disconnect();
  routeMobileMq?.removeEventListener("change", syncRouteMobile);
  unbindVoiceUnlockRetry?.();
  unbindVoiceUnlockRetry = null;
});

const stations = computed(() =>
  [...(props.config?.stations ?? [])].sort((a, b) => a.stationId - b.stationId),
);

const valueRouteStops = computed(() => buildValueRouteStops(stations.value));

const routeGeometry = computed(() =>
  dreamBusRouteAnchorLayout(routeWidthPx.value, valueRouteStops.value.length, {
    compact: isRouteCompact.value,
    mobile: isRouteMqMobile.value,
  }),
);

const routeStationsPerRow = computed(() => routeGeometry.value.stationsPerRow);
const routeMobileGrid = computed(() => routeGeometry.value.mobileGrid);
const routeRowStepPx = computed(() =>
  dreamBusWrapRowStepPx(routeMobileGrid.value),
);

const valueRouteStopsPositioned = computed(() => {
  const leftPcts = routeGeometry.value.stopLeftPcts;
  return valueRouteStops.value.map((stop, i) => ({
    ...stop,
    leftPct: leftPcts[i] ?? stop.leftPct,
  }));
});

const routeWaypoints = computed(() => {
  const stops = valueRouteStopsPositioned.value;
  const startPct = routeGeometry.value.busStartLeftPct;
  const compact = isRouteCompact.value;
  const rowTop = (valueRank: number) =>
    compact
      ? dreamBusWrapBusTopPx(
          dreamBusStopRowIndex(valueRank, routeStationsPerRow.value),
          routeMobileGrid.value,
        )
      : DREAM_BUS_ROUTE_LAYOUT.busWrapTopPx;
  const startTop = rowTop(0);
  if (!stops.length) {
    return [{ stationId: 0, leftPct: startPct, topPct: 50, topPx: startTop }];
  }
  return [
    { stationId: 0, leftPct: startPct, topPct: 50, topPx: startTop },
    ...stops.map((s) => ({
      stationId: s.stationId,
      leftPct: s.leftPct,
      topPct: s.topPct,
      topPx: rowTop(s.valueRank),
    })),
  ];
});

const stationDriveTimings = computed(() =>
  buildStationDriveTimings(
    valueRouteStopsPositioned.value,
    routeWaypoints.value,
    DREAM_BUS_DRIVE_SEGMENT_SEC,
  ),
);

const driveDurationSec = computed(() =>
  dreamBusDriveDurationSec(animState.arrivedStationId, routeWaypoints.value),
);

const stationDriveTimingById = computed(() => {
  const map = new Map<number, (typeof stationDriveTimings.value)[number]>();
  for (const row of stationDriveTimings.value) map.set(row.stationId, row);
  return map;
});

const driveElapsedSec = computed(() => {
  void nowMs.value;
  void props.clock;
  if (animState.phase !== "drive") return 0;
  if (props.live?.status === "2") {
    return Math.min(
      driveDurationSec.value,
      dreamBusRevealElapsedSec(props.live, nowMs.value),
    );
  }
  return Math.min(
    driveDurationSec.value,
    Math.max(0, (nowMs.value - animState.driveStartedAt) / 1000),
  );
});

const driveSegmentContext = computed(() => {
  if (animState.phase !== "drive") return null;
  return dreamBusDriveSegmentContext(
    driveElapsedSec.value,
    routeWaypoints.value,
    stations.value,
    driveDurationSec.value,
  );
});

function isStationActiveDuringDrive(stationId: number): boolean {
  const ctx = driveSegmentContext.value;
  return ctx?.nextStationId === stationId;
}

function isStationPassedDuringDrive(stationId: number): boolean {
  const timing = stationDriveTimingById.value.get(stationId);
  if (!timing || animState.phase !== "drive") return false;
  return driveElapsedSec.value >= timing.arrivalSec - 0.05;
}

const leftTimeDisplay = computed(() => {
  void nowMs.value;
  void props.clock;
  return dreamBusDisplaySeconds(
    dreamBusRunnerCountdownSec(animState, props.live, nowMs.value, routeWaypoints.value),
  );
});

const isWaiting = computed(
  () => animState.phase === "wait" || props.live?.status === "0",
);

function valueRankForStationId(stationId: number): number {
  const stop = valueRouteStopsPositioned.value.find((s) => s.stationId === stationId);
  return stop?.valueRank ?? 0;
}

let lastHoldVoiceKey = "";
let holdVoiceInFlight = false;
let departureVoiceInFlight = false;

async function maybePlayHoldVoice() {
  if (holdVoiceInFlight) return;
  if (animState.phase !== "hold" || animState.arrivedStationId <= 0) return;
  const sessionId = animState.sessionId;
  if (!sessionId) return;
  const key = `${sessionId}:${animState.arrivedStationId}`;
  if (key === lastHoldVoiceKey) return;
  holdVoiceInFlight = true;
  try {
    const ok = await playDreamBusArrivalVoice(
      valueRankForStationId(animState.arrivedStationId),
      sessionId,
    );
    if (ok) lastHoldVoiceKey = key;
  } finally {
    holdVoiceInFlight = false;
  }
}

async function maybePlayDepartureVoice() {
  if (departureVoiceInFlight) return;
  if (!isWaiting.value) return;
  const sessionId = animState.sessionId || String(props.live?.sessionId ?? "");
  if (!sessionId) return;
  const leftSec = leftTimeDisplay.value;
  if (leftSec > 7 || leftSec < 2) return;
  departureVoiceInFlight = true;
  try {
    await playDreamBusDepartureVoice(sessionId);
  } finally {
    departureVoiceInFlight = false;
  }
}

function syncVoiceAfterLive(live: DreamBusLive | null) {
  void maybePlayHoldVoice();
  if (live && String(live.status) === "0") {
    void maybePlayDepartureVoice();
  }
}

watch(
  () => [animState.phase, animState.arrivedStationId, animState.sessionId] as const,
  () => {
    maybePlayHoldVoice();
  },
);

watch(
  () => props.live?.sessionId,
  (sid, prev) => {
    if (sid !== prev) {
      lastHoldVoiceKey = "";
      resetDreamBusArrivalVoiceSession();
    }
  },
);

watch(
  () =>
    [
      isWaiting.value,
      leftTimeDisplay.value,
      animState.sessionId || String(props.live?.sessionId ?? ""),
    ] as const,
  () => {
    maybePlayDepartureVoice();
  },
);

watch(
  () => [routeWaypoints.value.length, props.config?.stations?.length ?? 0] as const,
  () => {
    syncDreamBusRunnerFromLive(animState, props.live, dreamBusNowMs(), routeWaypoints.value);
    syncVoiceAfterLive(props.live);
    startAnimLoop();
  },
);

watch(
  () => props.live,
  (live) => {
    syncDreamBusRunnerFromLive(animState, live, dreamBusNowMs(), routeWaypoints.value);
    if (live?.status === "2") {
      const left = dreamBusLiveLeftSec(live, dreamBusNowMs());
      postDepartCountdownTotalSec.value = Math.max(REVEAL_PHASE_SEC, left);
    }
    syncVoiceAfterLive(live);
    startAnimLoop();
  },
  { immediate: true, deep: true },
);

watch(
  () => props.clock,
  () => {
    nowMs.value = dreamBusNowMs();
    syncDreamBusRunnerFromLive(animState, props.live, nowMs.value, routeWaypoints.value);
    tickDreamBusRunnerAnim(animState, props.live, nowMs.value, routeWaypoints.value);
    maybePlayDepartureVoice();
    startAnimLoop();
  },
);

/** 进入爬行时快照 leftTime 总量，供爬行 + 休假进度条共用 */
watch(
  () => props.live?.sessionId,
  (sid, prev) => {
    if (sid && prev && sid !== prev) {
      postDepartCountdownTotalSec.value = REVEAL_PHASE_SEC;
    }
  },
);

watch(
  () =>
    [
      animState.phase,
      animState.driveStartedAt,
      animState.sessionId,
      props.live?.status,
      props.live?.sessionId,
    ] as const,
  ([phase, driveStartedAt]) => {
    const live = props.live;
    if (live?.status !== "2") return;
    if (phase === "drive" && driveStartedAt) {
      const left = dreamBusLiveLeftSec(live, dreamBusNowMs());
      postDepartCountdownTotalSec.value = Math.max(REVEAL_PHASE_SEC, left);
      return;
    }
    if (phase === "hold") {
      const left = dreamBusLiveLeftSec(live, dreamBusNowMs());
      postDepartCountdownTotalSec.value = Math.max(
        postDepartCountdownTotalSec.value,
        REVEAL_PHASE_SEC,
        left,
      );
    }
  },
);

watch(
  () => animState.phase,
  (phase, prev) => {
    if (phase === "hold" && prev !== "hold") {
      void maybePlayHoldVoice();
    }
    startAnimLoop();
  },
);

const isDriving = computed(() => animState.phase === "drive");

const isOnVacation = computed(() => animState.phase === "hold");

const isCrawling = computed(() => animState.phase === "drive");

const revealedStation = computed(() => {
  if (animState.phase !== "hold") return 0;
  return animState.arrivedStationId > 0 ? animState.arrivedStationId : 0;
});

const isRevealing = computed(
  () =>
    animState.phase === "hold" ||
    (props.live?.status === "2" && revealedStation.value > 0 && animState.phase !== "drive"),
);

const routeEndLeftPct = computed(() => {
  const wps = routeWaypoints.value;
  return wps[wps.length - 1]?.leftPct ?? 94;
});

const routeStartLeftPct = computed(() => routeWaypoints.value[0]?.leftPct ?? 4);

function leftPctToProgressPct(leftPct: number): number {
  const span = routeEndLeftPct.value - routeStartLeftPct.value;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(100, ((leftPct - routeStartLeftPct.value) / span) * 100));
}

/** 发车后爬行 + 休假：共用 live.leftTime 驱动进度条 */
function postDepartCountdownProgressPct(nowMs: number): number | null {
  const live = props.live;
  if (live?.status !== "2") return null;
  if (animState.phase !== "drive" && animState.phase !== "hold") return null;
  const left = dreamBusLiveLeftSec(live, nowMs);
  const total = postDepartCountdownTotalSec.value;
  const clampedLeft = Math.max(0, Math.min(total, left));
  return ((total - clampedLeft) / total) * 100;
}

const phaseProgressPct = computed(() => {
  void nowMs.value;
  void props.clock;

  if (animState.phase === "wait" || props.live?.status === "0") {
    return dreamBusDriveProgress01(animState, props.live, nowMs.value, routeWaypoints.value) * 100;
  }

  if (animState.phase === "drive" || animState.phase === "hold") {
    const postDepartPct = postDepartCountdownProgressPct(nowMs.value);
    if (postDepartPct != null) return postDepartPct;
    if (animState.phase === "drive") {
      return dreamBusDriveProgress01(animState, props.live, nowMs.value, routeWaypoints.value) * 100;
    }
    const left = dreamBusRunnerLeftPct(animState, routeWaypoints.value, nowMs.value, props.live);
    return leftPctToProgressPct(left);
  }

  if (props.live?.status === "2") {
    return postDepartCountdownProgressPct(nowMs.value) ?? 0;
  }

  return 0;
});

const stationBoardTopPx = computed(() =>
  dreamBusStationTopPx(isRouteMqMobile.value),
);

const stationBoardLeftPx = computed(() => routeGeometry.value.boardCenterPx);
const routeLeadingInsetPx = computed(() => routeGeometry.value.routeLeadingInsetPx);
const stationBoardWidth = computed(
  () => `${routeGeometry.value.boardWidthPx}px`,
);
const busWrapWidth = computed(() => `${routeGeometry.value.busWidthPx}px`);

const compactRowCount = computed(() =>
  Math.max(
    1,
    Math.ceil(
      valueRouteStopsPositioned.value.length /
        Math.max(1, routeStationsPerRow.value),
    ),
  ),
);

const compactRouteHeightPx = computed(() =>
  isRouteCompact.value
    ? dreamBusWrapRouteHeightPx(
        valueRouteStopsPositioned.value.length,
        routeStationsPerRow.value,
        routeMobileGrid.value,
      )
    : null,
);

const busWrapStyle = computed(() => {
  const style: Record<string, string> = {
    left: `${busLeftPct.value}%`,
    width: busWrapWidth.value,
  };
  if (isRouteCompact.value) {
    style.top = `${busTopPx.value}px`;
  }
  return style;
});

function stopRowIndex(valueRank: number): number {
  return isRouteCompact.value
    ? dreamBusStopRowIndex(valueRank, routeStationsPerRow.value)
    : 0;
}

const progressMode = computed<"idle" | "wait" | "drive" | "reveal">(() => {
  if (animState.phase === "wait" || props.live?.status === "0") return "wait";
  if (animState.phase === "drive") return "drive";
  if (isRevealing.value) return "reveal";
  return "idle";
});

const busLeftPct = computed(() => {
  void nowMs.value;
  void props.clock;
  return dreamBusRunnerLeftPct(animState, routeWaypoints.value, nowMs.value, props.live);
});

const busTopPx = computed(() => {
  void nowMs.value;
  void props.clock;
  const fallback = isRouteCompact.value
    ? dreamBusWrapBusTopPx(0, routeMobileGrid.value)
    : DREAM_BUS_ROUTE_LAYOUT.busWrapTopPx;
  return dreamBusRunnerTopPx(
    animState,
    routeWaypoints.value,
    nowMs.value,
    fallback,
    props.live,
  );
});

const busIsRunning = computed(() => dreamBusRunnerUsesRunAnim(animState));

const showBus = computed(
  () =>
    animState.phase === "wait" ||
    animState.phase === "drive" ||
    animState.phase === "hold",
);

/** 车次：当前时间 HH:mm */
const tripLabel = computed(() => {
  void props.clock;
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
});

const showProgressCountdown = computed(
  () => !!props.live || showBus.value || isWaiting.value,
);

const progressCountdownText = computed(() => {
  if (!showProgressCountdown.value) return "";
  const n = leftTimeDisplay.value;
  if (isWaiting.value) return `还有 ${n} 秒发车`;
  if (isCrawling.value) return `宝宝爬行中 ${n} 秒`;
  if (isOnVacation.value) return `宝宝休假还剩 ${n} 秒`;
  return "";
});
</script>

<template>
  <div class="db-route">
    <div
      class="db-progress"
      :class="{
        'db-progress--wait': progressMode === 'wait',
        'db-progress--drive': progressMode === 'drive',
        'db-progress--reveal': progressMode === 'reveal',
        'db-progress--idle': progressMode === 'idle',
      }"
      role="progressbar"
      :aria-valuenow="Math.round(phaseProgressPct)"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <div class="db-progress-head">
        <span class="db-progress-trip">宝宝巴士 · 第 {{ tripLabel }} 车次</span>
        <span v-if="progressCountdownText" class="db-progress-time">{{ progressCountdownText }}</span>
      </div>
      <div class="db-progress-track">
        <div class="db-progress-fill" :style="{ width: `${phaseProgressPct}%` }">
          <div class="db-progress-glow" />
        </div>
      </div>
    </div>

    <div
      class="db-value-route-wrap"
      :style="routeLeadingInsetPx > 0 ? { paddingLeft: `${routeLeadingInsetPx}px` } : undefined"
    >
      <div
        ref="routeEl"
        class="db-value-route"
        :class="{
          'db-value-route--compact': isRouteCompact,
          'db-value-route--mobile-grid': isRouteMqMobile,
        }"
        :style="{
          ...(compactRouteHeightPx ? { height: `${compactRouteHeightPx}px` } : {}),
          '--db-wrap-row-step': `${routeRowStepPx}px`,
        }"
      >
        <template v-if="isRouteCompact">
          <div
            v-for="row in compactRowCount"
            :key="`line-${row - 1}`"
            class="db-value-route-line db-value-route-line--row"
            :style="{
              top: `${dreamBusWrapRowLineTopPx(row - 1, routeMobileGrid)}px`,
            }"
            aria-hidden="true"
          />
        </template>
        <div v-else class="db-value-route-line" aria-hidden="true" />

        <div v-if="showBus" class="db-bus-wrap" :style="busWrapStyle">
          <DreamBusSprite :running="busIsRunning" />
        </div>

        <div
          v-for="stop in valueRouteStopsPositioned"
          :key="stop.stationId"
          class="db-value-stop"
          :class="{
            'db-value-stop--hit': revealedStation === stop.stationId,
            'db-value-stop--drive': isDriving,
            'db-value-stop--active': isStationActiveDuringDrive(stop.stationId),
            'db-value-stop--passed': isStationPassedDuringDrive(stop.stationId),
          }"
          :style="{
            left: `${stop.leftPct}%`,
            '--db-stop-row': stopRowIndex(stop.valueRank),
          }"
        >
          <DreamBusStationIcon
            :station-id="stop.stationId"
            :size="routeIconSize"
            show-label
            :label-max-width="routeLabelPreset.maxWidth"
            :label-font-scale="routeLabelPreset.fontScale"
            :label-multiple="stop.multiple"
          >
            <template #overlay>
              <div
                v-if="revealedStation === stop.stationId"
                class="db-value-stop-ring"
              />
            </template>
          </DreamBusStationIcon>
        </div>

        <div
          class="db-start-station"
          :style="{
            left: `${stationBoardLeftPx}px`,
            top: `${stationBoardTopPx}px`,
            width: stationBoardWidth,
          }"
        >
          <img
            class="db-start-station__img"
            :src="stationBoardUrl"
            alt="起点站"
            draggable="false"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.db-route {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 100%;
}

.db-progress {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.55rem 0.65rem 0.6rem;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--fg, #eee) 12%, transparent);
  background: color-mix(in srgb, var(--fg, #eee) 4%, transparent);
}

.db-progress--wait {
  border-color: color-mix(in srgb, var(--fg, #eee) 22%, transparent);
}

.db-progress--drive {
  border-color: color-mix(in srgb, var(--accent, #f7b52a) 35%, transparent);
}

.db-progress--reveal {
  border-color: color-mix(in srgb, #48c9b0 35%, transparent);
}

.db-progress--idle {
  opacity: 0.65;
}

.db-progress-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 1.1rem;
  line-height: 1.25;
}

.db-progress-trip {
  font-weight: 600;
  font-size: 0.95rem;
  white-space: nowrap;
}

.db-progress-time {
  font-size: 0.88rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--accent, #f7b52a);
  white-space: nowrap;
}

.db-progress--reveal .db-progress-time {
  color: #48c9b0;
}

.db-progress--wait .db-progress-time {
  opacity: 1;
  color: var(--accent, #f7b52a);
  text-shadow: 0 0 1px color-mix(in srgb, var(--fg, #111) 55%, transparent);
}

.db-progress--drive .db-progress-time {
  opacity: 1;
  color: #ffb347;
}

.db-progress-track {
  height: 0.55rem;
  border-radius: 999px;
  overflow: hidden;
  background: color-mix(in srgb, var(--fg, #eee) 10%, transparent);
}

.db-progress--wait .db-progress-fill {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--fg, #eee) 35%, transparent),
    color-mix(in srgb, var(--accent, #f7b52a) 45%, transparent)
  );
}

.db-progress-fill {
  position: relative;
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent, #f7b52a), #ffd56a);
  min-width: 2px;
  will-change: width;
}

.db-progress--reveal .db-progress-fill {
  background: linear-gradient(90deg, #48c9b0, #7dcea0);
}

.db-progress--reveal .db-progress-glow {
  box-shadow: 0 0 10px color-mix(in srgb, #48c9b0 55%, transparent);
  opacity: 0.75;
}

.db-progress--idle .db-progress-fill {
  background: color-mix(in srgb, var(--fg, #eee) 25%, transparent);
  width: 0 !important;
}

.db-progress-glow {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: 0 0 10px color-mix(in srgb, var(--accent, #f7b52a) 50%, transparent);
  opacity: 0.6;
}

.db-value-route-wrap {
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--fg, #eee) 14%, transparent);
  background: color-mix(in srgb, var(--fg, #eee) 3%, transparent);
  padding: 0.65rem 0.5rem 0.85rem;
  overflow-x: hidden;
}

.db-value-route {
  position: relative;
  width: 100%;
  min-width: 0;
  height: 200px;
  margin: 0 0.25rem;
}

.db-start-station {
  position: absolute;
  z-index: 3;
  transform: translateX(-50%);
  pointer-events: none;
}

.db-start-station__img {
  display: block;
  width: 100%;
  height: auto;
  user-select: none;
}

.db-bus-wrap {
  position: absolute;
  top: 54px;
  z-index: 4;
  width: 118px;
  transform: translate(-50%, 0);
  pointer-events: none;
  filter: drop-shadow(0 3px 6px rgba(0, 0, 0, 0.18));
}

.db-value-route-line {
  position: absolute;
  left: 4%;
  right: 4%;
  top: 68px;
  height: 4px;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent, #f7b52a) 30%, transparent),
    color-mix(in srgb, #e74c3c 35%, transparent)
  );
  box-shadow: 0 1px 0 color-mix(in srgb, var(--fg, #eee) 8%, transparent);
}

.db-value-stop {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
  z-index: 2;
  pointer-events: none;
}

.db-value-stop--hit :deep(.db-st-icon) {
  filter: drop-shadow(0 0 8px rgba(255, 213, 106, 0.85));
}

.db-value-stop-ring {
  position: absolute;
  inset: -4px;
  border: 2px solid #ffd56a;
  border-radius: 10px;
  animation: db-pulse 1.2s ease-in-out infinite;
}

@keyframes db-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.06);
    opacity: 0.75;
  }
}

.db-value-stop--drive.db-value-stop--active :deep(.db-st-icon) {
  filter: drop-shadow(0 0 6px rgba(247, 181, 42, 0.9));
}

.db-value-stop--drive.db-value-stop--passed :deep(.db-st-icon) {
  opacity: 0.72;
}

.db-value-route--compact .db-value-stop {
  top: calc(var(--db-stop-row, 0) * var(--db-wrap-row-step, 78px));
  max-width: 62px;
}

.db-value-route--compact:not(.db-value-route--mobile-grid) .db-value-stop {
  max-width: 76px;
}

.db-value-route--compact .db-value-stop :deep(.db-st-stack) {
  gap: 0.08rem;
}

.db-value-route--compact .db-value-route-line--row {
  left: 4%;
  right: 4%;
}

.db-value-route--mobile-grid .db-value-stop {
  max-width: 52px;
}

.db-value-route--mobile-grid .db-value-route-line--row {
  left: 2%;
  right: 1%;
}

@media (max-width: 640px) {
  .db-value-route-wrap {
    padding-left: 0.35rem;
    padding-right: 0.25rem;
  }

  .db-value-route {
    margin: 0;
  }
}
</style>
