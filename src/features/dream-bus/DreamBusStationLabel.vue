<script setup lang="ts">
import { computed } from "vue";
import { dreamBusStarBand } from "./dreamBusMapLayout";
import { dreamBusStationLabelUrl } from "./dreamBusStationIcons";
import { DREAM_BUS_LABEL_VALUE_LAYOUT } from "./dreamBusStationLabelLayout";

const props = withDefaults(
  defineProps<{
    stationId: number;
    /** 倍率；省略则只显示站名 label 图 */
    multiple?: number;
    /** 胶囊总宽度 */
    maxWidth?: string;
    /** 仅缩放倍率字号，不改变相对位置 */
    fontScale?: number;
  }>(),
  { maxWidth: "72px", fontScale: 1 },
);

const labelSrc = computed(() => dreamBusStationLabelUrl(props.stationId));
const band = computed(() =>
  props.multiple != null ? dreamBusStarBand(props.multiple) : null,
);
const showValue = computed(() => props.multiple != null && band.value);

const pillStyle = computed(() => ({
  maxWidth: props.maxWidth,
  "--db-label-zone-left": DREAM_BUS_LABEL_VALUE_LAYOUT.zoneLeft,
  "--db-label-zone-right": DREAM_BUS_LABEL_VALUE_LAYOUT.zoneRight,
  "--db-label-zone-top": DREAM_BUS_LABEL_VALUE_LAYOUT.zoneTop,
  "--db-label-zone-bottom": DREAM_BUS_LABEL_VALUE_LAYOUT.zoneBottom,
  "--db-label-value-shift-x": DREAM_BUS_LABEL_VALUE_LAYOUT.valueShiftX,
  "--db-label-font-cqw": `${DREAM_BUS_LABEL_VALUE_LAYOUT.fontCqw * props.fontScale}cqw`,
}));
</script>

<template>
  <div
    v-if="labelSrc"
    class="db-label-pill"
    :style="pillStyle"
    :title="multiple != null ? String(multiple) : undefined"
  >
    <img class="db-label-pill__bg" :src="labelSrc" alt="" draggable="false" />
    <div v-if="showValue" class="db-label-pill__value-zone">
      <span class="db-label-pill__value" :class="`db-label-pill__value--${band}`">
        {{ multiple }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.db-label-pill {
  position: relative;
  display: inline-block;
  width: 100%;
  aspect-ratio: 142 / 34;
  line-height: 0;
  container-type: inline-size;
}

.db-label-pill__bg {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: fill;
  user-select: none;
  pointer-events: none;
}

.db-label-pill__value-zone {
  position: absolute;
  left: var(--db-label-zone-left);
  right: var(--db-label-zone-right);
  top: var(--db-label-zone-top);
  bottom: var(--db-label-zone-bottom);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--db-label-font-cqw);
  pointer-events: none;
}

.db-label-pill__value {
  font-weight: 900;
  line-height: 1;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  transform: translateX(var(--db-label-value-shift-x));
}

.db-label-pill__value--orange {
  color: #4a3018;
  text-shadow: 0 0.5px 0 rgba(255, 255, 255, 0.35);
}

.db-label-pill__value--teal {
  color: #1e4a42;
  text-shadow: 0 0.5px 0 rgba(255, 255, 255, 0.3);
}

.db-label-pill__value--red {
  color: #fff8ec;
  text-shadow: 0 1px 0 rgba(120, 30, 0, 0.35);
}
</style>
