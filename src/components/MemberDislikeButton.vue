<script setup lang="ts">
import { computed, inject, ref } from "vue";
import {
  addMemberDislike,
  FMZ_REACTIONS_CLIENT_KEY,
  memberDislikesState,
  reactionsClientFromSettings,
  type ReactionsClient,
} from "../lib/memberLikes";
import { loadSettings } from "../settings";

const props = withDefaults(
  defineProps<{
    memberId: string | number;
    variant?: "hud" | "tile" | "inline";
  }>(),
  { variant: "inline" },
);

const reactionsRef = inject(FMZ_REACTIONS_CLIENT_KEY, null);
const ctx = computed(
  () => reactionsRef?.value ?? reactionsClientFromSettings(loadSettings()),
);

const idKey = computed(() => String(props.memberId));
const displayCount = computed(() => memberDislikesState.counts[idKey.value] ?? 0);
const pending = ref(false);
const clickErr = ref("");

async function onClick(e: MouseEvent) {
  e.stopPropagation();
  e.preventDefault();
  const c = ctx.value;
  if (!c.baseUrl || !c.projectKey) {
    clickErr.value = "赞踩配置缺失";
    return;
  }
  pending.value = true;
  clickErr.value = "";
  try {
    await addMemberDislike(props.memberId, c);
  } catch (err) {
    clickErr.value = err instanceof Error ? err.message : String(err);
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <button
    type="button"
    class="dis-btn"
    :class="'dis-' + variant"
    :disabled="pending"
    :aria-label="'点踩，当前 ' + displayCount"
    :title="clickErr || '点踩 ' + displayCount"
    @click="onClick"
  >
    <svg class="thumb" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"
      />
    </svg>
    <span class="num">{{ displayCount }}</span>
    <span v-if="clickErr" class="react-err" :title="clickErr">!</span>
  </button>
</template>

<style scoped>
.dis-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  margin: 0;
  padding: 0.2rem 0.35rem;
  border: 1px solid color-mix(in srgb, var(--muted, #8b9cb3) 55%, var(--border, #2d3a4d));
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface, #1a2332) 88%, rgba(0, 0, 0, 0.35));
  color: var(--muted, #a8b8cc);
  cursor: pointer;
  line-height: 1;
  font: inherit;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
}
.dis-btn:hover {
  filter: brightness(1.12);
  color: var(--text, #e8eef7);
}
.dis-btn:active {
  transform: scale(0.96);
}
.thumb {
  width: 1em;
  height: 1em;
  flex-shrink: 0;
  fill: currentColor;
}
.num {
  font-size: 0.72em;
  font-weight: 800;
  min-width: 1ch;
  color: var(--text, #e8eef7);
  font-variant-numeric: tabular-nums;
}
.dis-hud {
  flex-shrink: 0;
  align-self: center;
  padding: 0.12rem 0.28rem;
  gap: 0.12rem;
  font-size: 0.65rem;
}
.dis-hud .thumb {
  width: 12px;
  height: 12px;
}
.dis-hud .num {
  font-size: 0.68rem;
}
.dis-tile {
  padding: 0.22rem 0.4rem;
  font-size: 0.75rem;
  background: rgba(15, 20, 28, 0.82);
  backdrop-filter: blur(4px);
}
.dis-tile .thumb {
  width: 14px;
  height: 14px;
}
.dis-inline {
  padding: 0.15rem 0.32rem;
  font-size: 0.72rem;
}
.dis-inline .thumb {
  width: 13px;
  height: 13px;
}
.react-err {
  font-size: 0.65em;
  font-weight: 900;
  color: var(--danger, #ff6b6b);
  margin-left: 0.1rem;
}
</style>
