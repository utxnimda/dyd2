<script setup lang="ts">
import { computed } from "vue";
import type { CaptainMoneyCard } from "../lib/captainTeams";
import MemberDislikeButton from "./MemberDislikeButton.vue";
import MemberLikeButton from "./MemberLikeButton.vue";

type Parked = {
  key: number;
  targetKey: string;
  src: string;
  name: string;
  stackIndex: number;
};
type Floater = {
  id: string;
  text: string;
  kind: "hit" | "heal";
  key: number;
  stackIndex: number;
};

const props = withDefaults(
  defineProps<{
    member: CaptainMoneyCard;
    kind: "other" | "member" | "captain";
    /** 队长环：阵营色，与 Treasury 四角一致 */
    accent?: string;
    hitIds: Set<string>;
    healIds: Set<string>;
    parkedNear: Parked[];
    floaters: Floater[];
    displayBalance: Record<string, number>;
    /** 仅圆形头像；隐藏昵称、积分、点赞与飞入旁小头像等 */
    avatarOnly?: boolean;
    /** 轨道：头像 + 昵称 + 积分纵向居中排布（无点赞/飞入装饰）；与 avatarOnly 互斥 */
    orbitStack?: boolean;
  }>(),
  { avatarOnly: false, orbitStack: false },
);

function balKey(id: string | number) {
  return String(id);
}

const k = computed(() => balKey(props.member.id));
const parkedForTarget = computed(() =>
  props.parkedNear.filter((x) => x.targetKey === k.value),
);
const floatersForTarget = computed(() =>
  props.floaters.filter((x) => x.id === k.value),
);
const balance = computed(() => props.displayBalance[k.value] ?? 0);
</script>

<template>
  <div
    class="perim-slot-wrap"
    :class="[
      kind === 'other'
        ? 'perim-slot-wrap--other'
        : kind === 'captain'
          ? 'perim-slot-wrap--captain'
          : 'perim-slot-wrap--member',
      orbitStack ? 'perim-slot-wrap--orbit' : '',
    ]"
    :style="kind === 'captain' && accent ? { '--accent': accent } : undefined"
  >
    <div
      class="slot"
      :class="{
        ishit: hitIds.has(k),
        isheal: healIds.has(k),
      }"
    >
      <div
        class="slot-bundle"
        :class="{
          'slot-bundle--avatar-only': avatarOnly,
          'slot-bundle--orbit-stack': orbitStack && !avatarOnly,
        }"
      >
        <div
          class="slot-inner"
          :class="{
            'slot-inner--avatar-only': avatarOnly,
            'slot-inner--orbit-stack': orbitStack && !avatarOnly,
          }"
        >
          <div class="av-wrap">
            <img
              v-if="member.avatar"
              class="av"
              :data-captain-anchor="k"
              :src="member.avatar"
              alt=""
              referrerpolicy="no-referrer"
            />
            <div v-else class="av ph" :data-captain-anchor="k" />
            <div v-if="!avatarOnly && !orbitStack" class="parked-stack" aria-hidden="true">
              <div v-for="p in parkedForTarget" :key="p.key" class="parked-item">
                <img class="parked-mini" :src="p.src" alt="" referrerpolicy="no-referrer" />
                <span class="parked-name">{{ p.name }}</span>
              </div>
            </div>
            <template v-if="!avatarOnly && !orbitStack">
              <div
                v-for="f in floatersForTarget"
                :key="f.key"
                class="floater"
                :class="f.kind"
                :style="{ '--f-stack': f.stackIndex }"
              >
                {{ f.text }}
              </div>
            </template>
          </div>
          <div v-if="!avatarOnly && !orbitStack" class="hud-reactions">
            <MemberLikeButton :member-id="member.id" variant="hud" />
            <MemberDislikeButton :member-id="member.id" variant="hud" />
          </div>
          <div
            v-if="!avatarOnly && orbitStack"
            class="meta meta--orbit-stack"
          >
            <div class="nm">{{ member.name }}</div>
            <div class="pts">{{ balance.toLocaleString() }}</div>
          </div>
          <div v-if="!avatarOnly && !orbitStack" class="meta">
            <div class="nm">{{ member.name }}</div>
            <div class="pts">{{ balance.toLocaleString() }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.perim-slot-wrap--other {
  --accent: #e9b949;
}
.perim-slot-wrap--member {
  --accent: #5eb0e8;
}
.perim-slot-wrap--captain {
  --accent: #a855f7;
}
.perim-slot-wrap--orbit {
  width: fit-content;
  min-width: 2.25rem; /* 36px 头像 */
  max-width: 4.25rem;
  flex-shrink: 0;
}
.slot {
  position: relative;
  overflow: visible;
}
/** 头像 + 点赞点踩 + 昵称/积分 同一视觉块 */
.slot-bundle {
  border-radius: 12px;
  padding: 0.32rem 0.42rem 0.38rem;
  border: 2px solid color-mix(in srgb, var(--accent) 44%, var(--border, #2d3a4d));
  background: linear-gradient(
    145deg,
    color-mix(in srgb, var(--accent) 14%, var(--surface, #1a2332)),
    color-mix(in srgb, var(--accent) 6%, var(--surface, #1a2332))
  );
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--accent) 22%, transparent),
    inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
}
.slot-bundle--avatar-only {
  padding: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  border-radius: 0;
}
.slot-inner {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  min-width: 0;
}
.slot-inner--avatar-only {
  gap: 0;
}
.slot-bundle--orbit-stack {
  padding: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  border-radius: 0;
  width: 100%;
}
.slot-inner--orbit-stack {
  flex-direction: column;
  align-items: center;
  gap: 0.1rem;
  width: 100%;
}
.meta--orbit-stack {
  width: 100%;
  min-width: 0;
  align-self: stretch;
  padding-top: 0;
  text-align: center;
}
.meta--orbit-stack .nm,
.meta--orbit-stack .pts {
  max-width: 100%;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta--orbit-stack .nm {
  font-size: 0.62rem;
  line-height: 1.1;
}
.meta--orbit-stack .pts {
  font-size: 0.66rem;
  line-height: 1.05;
}
.hud-reactions {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.15rem;
  align-self: flex-start;
  padding-top: 2px;
}
.av-wrap {
  position: relative;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
}
.av {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid color-mix(in srgb, var(--accent) 50%, var(--border));
  flex-shrink: 0;
  display: block;
}
.av.ph {
  background: color-mix(in srgb, var(--muted) 32%, var(--surface));
}
.meta {
  min-width: 0;
  align-self: flex-start;
  padding-top: 1px;
}
.nm {
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1.15;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 6.5rem;
}
.pts {
  font-size: 0.78rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--accent, #3dd68c);
}

.slot.ishit .slot-bundle:not(.slot-bundle--avatar-only):not(.slot-bundle--orbit-stack) {
  border-color: color-mix(in srgb, var(--danger) 55%, var(--border, #2d3a4d));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--danger) 35%, transparent);
}
.slot.ishit .av {
  animation: shake 0.5s ease;
  box-shadow: 0 0 0 0 rgba(255, 80, 80, 0.65);
}
.slot.ishit .av,
.slot.ishit .av.ph {
  border-color: var(--danger);
}
.slot.isheal .slot-bundle:not(.slot-bundle--avatar-only):not(.slot-bundle--orbit-stack) {
  border-color: color-mix(in srgb, var(--accent) 62%, var(--border, #2d3a4d));
  box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 28%, transparent);
}
.slot.isheal .av {
  animation: pulseheal 0.65s ease;
  box-shadow: 0 0 14px rgba(61, 214, 140, 0.55);
}
.slot.isheal .av,
.slot.isheal .av.ph {
  border-color: var(--accent);
}

@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  20% {
    transform: translateX(-4px) rotate(-4deg);
  }
  40% {
    transform: translateX(4px) rotate(4deg);
  }
  60% {
    transform: translateX(-3px);
  }
  80% {
    transform: translateX(3px);
  }
}
@keyframes pulseheal {
  0% {
    transform: scale(1);
    filter: brightness(1);
  }
  40% {
    transform: scale(1.08);
    filter: brightness(1.25) drop-shadow(0 0 8px #3dd68c);
  }
  100% {
    transform: scale(1);
    filter: brightness(1);
  }
}

.parked-stack {
  position: absolute;
  right: calc(100% + 4px);
  top: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
  pointer-events: none;
  z-index: 2;
}
.parked-item {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}
.parked-mini {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid color-mix(in srgb, var(--border, #2d3a4d) 85%, var(--text, #e8eef7) 15%);
  box-shadow: 0 2px 10px color-mix(in srgb, var(--bg, #0f1419) 55%, transparent);
  flex-shrink: 0;
}
.parked-name {
  font-size: 0.58rem;
  font-weight: 800;
  color: var(--text, #e8eef7);
  text-shadow: 0 1px 3px color-mix(in srgb, var(--bg, #0f1419) 85%, transparent);
  max-width: 4.2rem;
  text-align: right;
  line-height: 1.05;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.floater {
  position: absolute;
  left: 50%;
  top: calc(100% + 4px);
  z-index: 3;
  font-size: 0.82rem;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.9), 0 0 10px rgba(0, 0, 0, 0.45);
  white-space: nowrap;
  transform: translateX(calc(-50% + var(--f-stack, 0) * 10px));
  animation: damageFromBelow 1.15s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}
.floater.hit {
  color: var(--danger);
}
.floater.heal {
  color: color-mix(in srgb, var(--accent) 82%, #fff 18%);
}
@keyframes damageFromBelow {
  0% {
    opacity: 0;
    transform: translateX(calc(-50% + var(--f-stack, 0) * 10px)) translateY(14px)
      scale(0.55);
    filter: blur(0.6px);
  }
  18% {
    opacity: 1;
    filter: blur(0);
    transform: translateX(calc(-50% + var(--f-stack, 0) * 10px)) translateY(0)
      scale(1.08);
  }
  55% {
    opacity: 1;
    transform: translateX(calc(-50% + var(--f-stack, 0) * 10px)) translateY(-6px)
      scale(1);
  }
  100% {
    opacity: 0;
    transform: translateX(calc(-50% + var(--f-stack, 0) * 10px)) translateY(-26px)
      scale(0.92);
  }
}
</style>
