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
import type { WeeklyReport } from "../lib/defenseTowerApi";
import {
  SIEGE_CITY_INNER_OFFSET_REM,
  SIEGE_CITY_OUTER_EXTRA_REM,
  SIEGE_MINUTE_WINDOWS,
  buildInnerCitySectors,
  type SiegeMinuteWindow,
  type SiegeInnerCitySector,
} from "../lib/siegeCityOrbit";

const props = defineProps<{
  report: WeeklyReport | null | undefined;
  secondsToSync: number;
  clock: number;
}>();

const minuteWindow = ref<SiegeMinuteWindow>(30);
const orbitBoardEl = ref<HTMLElement | null>(null);
const orbitScale = ref(1);

const citySectors = computed(() => buildInnerCitySectors(props.report, minuteWindow.value));

const orbitBoardSideRem = computed(() => {
  const P = ORBIT_SECTOR_PANEL;
  const maxR = P.hubSectorInnerRem
    + SIEGE_CITY_INNER_OFFSET_REM
    + SIEGE_CITY_OUTER_EXTRA_REM;
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
  const baseOpacity = s.latestMinuteIndex == null
    ? 0.08
    : Math.min(0.34, 0.12 + 0.16 * s.heatNorm + (s.isLatest ? 0.04 : 0));
  const op = Math.max(0.05, baseOpacity * (s.opacityScale ?? 1));
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

const ringGuideCircles = computed(() => {
  const side = orbitBoardSideRem.value;
  const P = ORBIT_SECTOR_PANEL;
  const cityOuter = P.hubSectorInnerRem
    + SIEGE_CITY_INNER_OFFSET_REM
    + SIEGE_CITY_OUTER_EXTRA_REM;
  return [{ key: "city-ring", rPct: (cityOuter / side) * 50 }];
});

const secondsToSync = computed(() => props.secondsToSync);
</script>

<template>
  <div class="siege-orbit-wrap">
    <div class="siege-toolbar">
      <span class="siege-toolbar-lbl">攻城城市环</span>
      <label class="siege-select-wrap">
        <span class="sr-only">统计窗口</span>
        <select v-model.number="minuteWindow" class="siege-select">
          <option v-for="m in SIEGE_MINUTE_WINDOWS" :key="m" :value="m">
            最近 {{ m }} 分钟
          </option>
        </select>
      </label>
    </div>
    <p class="siege-orbit-legend">
      参考<strong>战斗爽队长扇形面板</strong>：最内圈只保留<strong>6 个城市扇形</strong>；
      最近攻城城市固定占据<strong>0–60°</strong>，面板内只显示<strong>城市名 + 攻城时间</strong>。
    </p>

    <div
      ref="orbitBoardEl"
      class="orbit-board"
      :style="orbitBoardInlineStyle"
    >
      <div class="orbit-board-scaler" :style="orbitScalerStyle">
        <svg
          class="siege-ring-guides"
          viewBox="0 0 100 100"
          aria-hidden="true"
        >
          <circle
            v-for="c in ringGuideCircles"
            :key="c.key"
            cx="50"
            cy="50"
            :r="c.rPct"
            fill="none"
            stroke="currentColor"
            stroke-width="0.2"
            class="siege-ring-guides-stroke"
          />
        </svg>

        <div class="orbit-sectors siege-city-sectors" aria-hidden="true">
          <div
            v-for="s in citySectors"
            :key="s.cityId"
            class="orbit-sector siege-city-sector"
            :class="{ 'siege-city-sector--latest': s.isLatest }"
            :style="innerCitySectorStyle(s)"
          />
        </div>

        <div class="orbit-hub attack-hub-bh" aria-hidden="true">
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
          <div class="siege-hub-countdown">
            <div class="siege-hub-num">{{ secondsToSync }}</div>
          </div>
        </div>

        <div
          v-for="s in citySectors"
          :key="`city-label-${s.cityId}`"
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
</template>

<style scoped>
.siege-orbit-wrap {
  margin: 0 0 1rem;
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
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--primary) 28%, var(--border));
  background: radial-gradient(
      circle at 50% 50%,
      color-mix(in srgb, var(--surface) 72%, transparent) 0%,
      color-mix(in srgb, var(--surface) 34%, var(--bg)) 55%,
      color-mix(in srgb, var(--bg) 90%, black) 100%
    );
}

.orbit-board-scaler {
  position: relative;
  width: var(--orbit-side, 28rem);
  aspect-ratio: 1;
  flex-shrink: 0;
}

.siege-ring-guides {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  color: color-mix(in srgb, var(--primary) 26%, var(--border));
}

.siege-ring-guides-stroke {
  vector-effect: non-scaling-stroke;
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
  background: linear-gradient(
    var(--orbit-sector-gradient-deg, 168deg),
    color-mix(
      in srgb,
      var(--sector-accent) var(--orbit-sector-mix-strong, 40%),
      var(--surface, #1a2332)
    ),
    color-mix(
      in srgb,
      var(--sector-accent) var(--orbit-sector-mix-weak, 14%),
      var(--surface, #1a2332)
    )
  );
}

.siege-city-sector {
  opacity: 1;
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--sector-accent) 58%, var(--border)),
    inset 0 0 1.4rem color-mix(in srgb, var(--sector-accent) 12%, transparent);
  filter: drop-shadow(0 0 0.65rem color-mix(in srgb, var(--sector-glow) 22%, transparent));
}

.siege-city-sector--latest {
  z-index: 2;
}

.orbit-hub {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 3;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.attack-hub-bh {
  --attack-hub-taiji-member: #5eb0e8;
  --attack-hub-taiji-other: #e9b949;
  width: min(100%, 5.15rem);
  min-width: 3.5rem;
  min-height: 3.5rem;
  aspect-ratio: 1;
  max-width: 5.15rem;
  max-height: 5.15rem;
  border-radius: 50%;
  position: relative;
  background: transparent;
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

.siege-hub-num {
  font-size: 1.55rem;
  font-weight: 900;
  color: var(--accent, #3dd68c);
  text-shadow:
    0 0 12px color-mix(in srgb, var(--accent) 35%, transparent),
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
    color-mix(in srgb, var(--bg) 24%, transparent),
    color-mix(in srgb, var(--bg) 38%, transparent)
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
  color: color-mix(in srgb, var(--c) 62%, white);
  text-align: center;
  text-shadow:
    0 0 4px color-mix(in srgb, var(--bg) 88%, transparent),
    0 1px 2px rgba(0, 0, 0, 0.55);
}

.siege-city-time {
  font-size: 0.5rem;
  line-height: 1;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: color-mix(in srgb, white 90%, var(--c) 10%);
  letter-spacing: 0.01em;
  text-align: center;
  text-shadow:
    0 0 4px color-mix(in srgb, var(--bg) 88%, transparent),
    0 1px 2px rgba(0, 0, 0, 0.55);
}

@media (prefers-reduced-motion: reduce) {
  .attack-hub-taiji-wrap {
    animation: none;
  }

  .attack-hub-taiji-water {
    animation: none;
  }
}
</style>
