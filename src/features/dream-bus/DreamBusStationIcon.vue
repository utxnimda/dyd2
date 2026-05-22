<script setup lang="ts">
import { computed } from "vue";
import DreamBusStationLabel from "./DreamBusStationLabel.vue";
import { dreamBusStationIconUrl } from "./dreamBusStationIcons";

const props = withDefaults(
  defineProps<{
    stationId: number;
    size?: string;
    variant?: "intro" | "map";
    showLabel?: boolean;
    labelMaxWidth?: string;
    labelMultiple?: number;
    /** 仅缩放 label 倍率字号 */
    labelFontScale?: number;
  }>(),
  {
    size: "50px",
    variant: "intro",
    showLabel: false,
    labelMaxWidth: "72px",
    labelFontScale: 1,
  },
);

const iconSrc = computed(() => dreamBusStationIconUrl(props.stationId, props.variant));
</script>

<template>
  <div v-if="iconSrc" class="db-st-stack" :class="{ 'db-st-stack--labeled': showLabel }">
    <div class="db-st-icon-wrap">
      <img
        class="db-st-icon"
        :src="iconSrc"
        alt=""
        :style="{ width: size, height: size }"
      />
      <slot name="overlay" />
    </div>
    <DreamBusStationLabel
      v-if="showLabel"
      :station-id="stationId"
      :multiple="labelMultiple"
      :max-width="labelMaxWidth"
      :font-scale="labelFontScale"
    />
  </div>
</template>

<style scoped>
.db-st-stack {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 0.12rem;
}

.db-st-icon-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.db-st-icon {
  display: block;
  flex-shrink: 0;
  object-fit: contain;
}
</style>
