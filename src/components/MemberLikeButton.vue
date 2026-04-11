<script setup lang="ts">
import { computed, onMounted } from "vue";
import { addMemberLike, loadMemberVotes, memberLikesState } from "../lib/memberLikes";

const props = withDefaults(
  defineProps<{
    memberId: string | number;
    /** hud：四角看板；tile：金库卡片角标内；inline：表格行内 */
    variant?: "hud" | "tile" | "inline";
  }>(),
  { variant: "tile" },
);

const idKey = computed(() => String(props.memberId));
const displayCount = computed(() => memberLikesState.counts[idKey.value] ?? 0);

onMounted(() => void loadMemberVotes());

function onClick(e: MouseEvent) {
  e.stopPropagation();
  e.preventDefault();
  void addMemberLike(props.memberId);
}
</script>

<template>
  <button
    type="button"
    class="like-btn"
    :class="'like-' + variant"
    :aria-label="'为成员点赞，当前 ' + displayCount"
    :title="'点赞 +' + displayCount"
    @click="onClick"
  >
    <svg class="heart" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"
      />
    </svg>
    <span class="num">{{ displayCount }}</span>
  </button>
</template>

<style scoped>
.like-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  margin: 0;
  padding: 0.2rem 0.35rem;
  border: 1px solid color-mix(in srgb, var(--accent, #38bdf8) 40%, var(--border, #2d3a4d));
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface, #1a2332) 88%, rgba(0, 0, 0, 0.35));
  color: color-mix(in srgb, var(--accent, #f472b6) 85%, #fff);
  cursor: pointer;
  line-height: 1;
  font: inherit;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
}
.like-btn:hover {
  filter: brightness(1.08);
}
.like-btn:active {
  transform: scale(0.96);
}
.heart {
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
.like-hud {
  flex-shrink: 0;
  align-self: center;
  padding: 0.12rem 0.28rem;
  gap: 0.12rem;
  font-size: 0.65rem;
}
.like-hud .heart {
  width: 12px;
  height: 12px;
}
.like-hud .num {
  font-size: 0.68rem;
}
.like-tile {
  padding: 0.22rem 0.4rem;
  font-size: 0.75rem;
  background: rgba(15, 20, 28, 0.82);
  backdrop-filter: blur(4px);
}
.like-tile .heart {
  width: 14px;
  height: 14px;
}
.like-inline {
  padding: 0.15rem 0.32rem;
  font-size: 0.72rem;
}
.like-inline .heart {
  width: 13px;
  height: 13px;
}
</style>
