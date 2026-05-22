<script setup lang="ts">
import busBodyUrl from "../../../image/dream-bus/bus-body3.png?url";

defineProps<{
  running?: boolean;
}>();
</script>

<template>
  <div class="db-bus-unit" :class="{ 'db-bus-unit--run': running }">
    <img class="db-bus-unit__body" :src="busBodyUrl" alt="" draggable="false" />
  </div>
</template>

<style scoped>
.db-bus-unit {
  position: relative;
  display: inline-block;
  line-height: 0;
}

.db-bus-unit__body {
  display: block;
  width: 100%;
  height: auto;
  user-select: none;
  pointer-events: none;
}

.db-bus-unit--run {
  animation: db-bus-bob 0.55s ease-in-out infinite;
}

@keyframes db-bus-bob {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-3px);
  }
}
</style>
