<script setup lang="ts">
import { computed, inject } from "vue";
import type { CaptainMoneyCard } from "./captainTeams";
import { ORBIT_SECTOR_PANEL } from "../../shared/orbitSectorPanel";
import MemberDislikeButton from "../../components/MemberDislikeButton.vue";
import MemberLikeButton from "../../components/MemberLikeButton.vue";
import { FMZ_TREASURY_AVATAR_KEY } from "../../shared/treasuryAvatarOpen";

const MAX_ORBIT_NAME_ARC_GRAPHEMES = 14;
const MAX_ORBIT_SCORE_ARC_CHARS = 16;

/** 扇形角域内对称分布的 n 个角（度，展开坐标 a0+span 系） */
function buildSectorArcAnglesU(
  a0: number,
  a1: number,
  n: number,
  maxDegBetweenChars: number,
  maxSpanFracOfSector: number,
  sectorEdgeMarginDeg: number,
): number[] {
  const span = sectorSpanDeg(a0, a1);
  const margin = sectorEdgeMarginDeg;
  const lowU = a0 + margin;
  const highU = a0 + span - margin;
  const arcMidU = a0 + span / 2;
  const halfRoom = Math.max(0, Math.min(arcMidU - lowU, highU - arcMidU));
  const thetasU: number[] = [];
  if (n === 1) {
    thetasU.push(Math.min(highU, Math.max(lowU, arcMidU)));
  } else {
    const stepIdeal = Math.min(
      maxDegBetweenChars,
      (maxSpanFracOfSector * span) / (n - 1),
    );
    const halfWidthIdeal = ((n - 1) / 2) * stepIdeal;
    const step =
      halfWidthIdeal <= halfRoom
        ? stepIdeal
        : halfRoom / Math.max((n - 1) / 2, 1e-6);
    for (let k = 0; k < n; k++) {
      thetasU.push(arcMidU + (k - (n - 1) / 2) * step);
    }
  }
  return thetasU;
}

function segmentOrbitName(s: string): string[] {
  const t = s.trim();
  if (!t) return [];
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter("zh-Hans", { granularity: "grapheme" });
    return [...seg.segment(t)].map((x) => x.segment);
  }
  return Array.from(t);
}

/** 扇形圆心角跨度（度），0°=正上顺时针 */
function sectorSpanDeg(a0: number, a1: number): number {
  let span = a1 - a0;
  if (span < -1e-6) span += 360;
  if (span <= 1e-6) return 360;
  return span;
}

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
    /** 轨道：昵称沿径向朝圆心、头像在赤道、积分朝外圈；与 avatarOnly 互斥 */
    orbitStack?: boolean;
    /** 轨道方位角（度，与 CaptainCornersHud orbit 一致）；用于径向排布文字 */
    orbitAngleDeg?: number;
    /** 赤道半径、内弧半径（rem，相对轨道板圆心）；与扇形几何一致 */
    orbitEquatorRem?: number;
    orbitInnerRem?: number;
    /** 扇形最外缘半径（rem），积分弧贴外环带 */
    orbitOuterRem?: number;
    /** 该成员扇形角域 [a0,a1]（度），昵称对称压在角平分径向上 */
    orbitSectorArc?: { a0: number; a1: number };
  }>(),
  {
    avatarOnly: false,
    orbitStack: false,
    orbitAngleDeg: 0,
    orbitEquatorRem: undefined,
    orbitInnerRem: undefined,
    orbitOuterRem: undefined,
    orbitSectorArc: undefined,
  },
);

const treasuryAvatar = inject(FMZ_TREASURY_AVATAR_KEY);

function onHudAvatarClick() {
  treasuryAvatar?.openIfMember(props.member.id);
}

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

/** 积分仅显示整数数字，无千分位等标点 */
const balanceDigitsOnly = computed(() => {
  const v = balance.value;
  if (typeof v !== "number" || !Number.isFinite(v)) return "0";
  return String(Math.trunc(v));
});

/** 与 orbitSectorPanel 同步：arc=弧排模板 | experimental=定稿（积分上、昵称下） */
const orbitNameScoreVariant = computed(
  () => ORBIT_SECTOR_PANEL.orbitNameScoreVariant,
);
const orbitLayoutUsesArcTemplate = computed(
  () =>
    props.orbitStack &&
    !props.avatarOnly &&
    orbitNameScoreVariant.value === "arc",
);
const orbitLayoutExperimental = computed(
  () =>
    props.orbitStack &&
    !props.avatarOnly &&
    orbitNameScoreVariant.value === "experimental",
);

/** 与金库一致：顶层 name 或 attribute 内昵称 */
const displayName = computed(() => {
  const n = props.member.name;
  if (n != null && String(n).trim() !== "") return String(n).trim();
  return String(props.member.id ?? "—");
});

/**
 * 弧排昵称：名字角向中心 = 扇形内弧的几何中点（角 a0+span/2），与板心共径向（内弧法线）；
 * 半径取内弧～赤道之间以靠近头像；字间距收紧并留边，保证落在扇形角域内。
 */
const nameArcLayout = computed(() => {
  if (ORBIT_SECTOR_PANEL.orbitNameScoreVariant !== "arc") return null;
  if (
    !props.orbitStack ||
    props.avatarOnly ||
    props.orbitSectorArc == null ||
    props.orbitInnerRem == null ||
    props.orbitEquatorRem == null
  ) {
    return null;
  }
  let chs = segmentOrbitName(displayName.value);
  if (!chs.length) return null;
  if (chs.length > MAX_ORBIT_NAME_ARC_GRAPHEMES) {
    chs = chs.slice(0, MAX_ORBIT_NAME_ARC_GRAPHEMES - 1).concat("…");
  }
  const { a0, a1 } = props.orbitSectorArc;
  const {
    towardAvatarT,
    maxDegBetweenChars,
    maxSpanFracOfSector,
    sectorEdgeMarginDeg,
    avatarExtraPadPx,
    glyphHalfLineEm,
  } = ORBIT_SECTOR_PANEL.nameArc;

  const Rin = props.orbitInnerRem;
  const Req = props.orbitEquatorRem;
  const alphaDeg = Number(props.orbitAngleDeg ?? 0);
  const alphaRad = (alphaDeg * Math.PI) / 180;
  const sx = Req * Math.sin(alphaRad);
  const sy = -Req * Math.cos(alphaRad);
  const cA = Math.cos(alphaRad);
  const sA = Math.sin(alphaRad);

  const n = chs.length;
  const thetasU = buildSectorArcAnglesU(
    a0,
    a1,
    n,
    maxDegBetweenChars,
    maxSpanFracOfSector,
    sectorEdgeMarginDeg,
  );

  const avCfg = ORBIT_SECTOR_PANEL.avatar;
  const avatarCircleRRem =
    (avCfg.sizePx / 2 + avCfg.borderPx + avatarExtraPadPx) / 16;
  const glyphRRem =
    ORBIT_SECTOR_PANEL.orbitStack.nameFontRem * glyphHalfLineEm;
  const minCenterDist = avatarCircleRRem + glyphRRem;

  let Rtext =
    Rin + Math.min(1, Math.max(0, towardAvatarT)) * (Req - Rin);
  Rtext = Math.min(Rtext, Req - minCenterDist);
  const rFloor = Rin + 0.06;
  while (Rtext > rFloor + 1e-6) {
    let ok = true;
    for (const thetaDeg of thetasU) {
      const tr = (thetaDeg * Math.PI) / 180;
      const cx = Rtext * Math.sin(tr);
      const cy = -Rtext * Math.cos(tr);
      if (Math.hypot(cx - sx, cy - sy) < minCenterDist) {
        ok = false;
        break;
      }
    }
    if (ok) break;
    Rtext -= 0.04;
  }
  Rtext = Math.max(rFloor, Rtext);

  return chs.map((ch, k) => {
    const thetaDeg = thetasU[k]!;
    const tr = (thetaDeg * Math.PI) / 180;
    const cx = Rtext * Math.sin(tr);
    const cy = -Rtext * Math.cos(tr);
    const dx = cx - sx;
    const dy = cy - sy;
    const dxp = dx * cA + dy * sA;
    const dyp = -dx * sA + dy * cA;
    const dxR = Number(dxp.toFixed(4));
    const dyR = Number(dyp.toFixed(4));
    return {
      ch,
      style: {
        transform: `translate(-50%, -50%) rotate(var(--orbit-a)) translate(${dxR}rem, ${dyR}rem) rotate(calc(-1 * var(--orbit-a))) rotate(${thetaDeg}deg)`,
      },
    };
  });
});

/**
 * 外弧积分：与昵称弧同一套角向对称；半径在赤道～外弧之间，并与头像保持间隙。
 */
const scoreArcLayout = computed(() => {
  if (ORBIT_SECTOR_PANEL.orbitNameScoreVariant !== "arc") return null;
  if (
    !props.orbitStack ||
    props.avatarOnly ||
    props.orbitSectorArc == null ||
    props.orbitOuterRem == null ||
    props.orbitEquatorRem == null
  ) {
    return null;
  }
  const label = balanceDigitsOnly.value;
  let chs = [...label];
  if (!chs.length) return null;
  if (chs.length > MAX_ORBIT_SCORE_ARC_CHARS) {
    chs = chs.slice(0, MAX_ORBIT_SCORE_ARC_CHARS - 1).concat("…");
  }
  const { a0, a1 } = props.orbitSectorArc;
  const {
    towardOutsideT,
    maxDegBetweenChars,
    maxSpanFracOfSector,
    sectorEdgeMarginDeg,
    avatarExtraPadPx,
    glyphHalfLineEm,
  } = ORBIT_SECTOR_PANEL.scoreArc;

  const Router = props.orbitOuterRem;
  const Req = props.orbitEquatorRem;
  const alphaDeg = Number(props.orbitAngleDeg ?? 0);
  const alphaRad = (alphaDeg * Math.PI) / 180;
  const sx = Req * Math.sin(alphaRad);
  const sy = -Req * Math.cos(alphaRad);
  const cA = Math.cos(alphaRad);
  const sA = Math.sin(alphaRad);

  const n = chs.length;
  const thetasU = buildSectorArcAnglesU(
    a0,
    a1,
    n,
    maxDegBetweenChars,
    maxSpanFracOfSector,
    sectorEdgeMarginDeg,
  );

  const avCfg = ORBIT_SECTOR_PANEL.avatar;
  const avatarCircleRRem =
    (avCfg.sizePx / 2 + avCfg.borderPx + avatarExtraPadPx) / 16;
  const glyphRRem =
    ORBIT_SECTOR_PANEL.orbitStack.scoreFontRem * glyphHalfLineEm;
  const minCenterDist = avatarCircleRRem + glyphRRem;

  let Rscore =
    Req + Math.min(1, Math.max(0, towardOutsideT)) * (Router - Req);
  Rscore = Math.max(Rscore, Req + minCenterDist);
  const rCeil = Math.max(Req + minCenterDist + 0.02, Router - glyphRRem - 0.06);
  Rscore = Math.min(Rscore, rCeil);

  while (Rscore < rCeil - 1e-6) {
    let ok = true;
    for (const thetaDeg of thetasU) {
      const tr = (thetaDeg * Math.PI) / 180;
      const cx = Rscore * Math.sin(tr);
      const cy = -Rscore * Math.cos(tr);
      if (Math.hypot(cx - sx, cy - sy) < minCenterDist) {
        ok = false;
        break;
      }
    }
    if (ok) break;
    Rscore += 0.04;
  }
  Rscore = Math.min(Rscore, rCeil);

  return chs.map((ch, k) => {
    const thetaDeg = thetasU[k]!;
    const tr = (thetaDeg * Math.PI) / 180;
    const cx = Rscore * Math.sin(tr);
    const cy = -Rscore * Math.cos(tr);
    const dx = cx - sx;
    const dy = cy - sy;
    const dxp = dx * cA + dy * sA;
    const dyp = -dx * sA + dy * cA;
    const dxR = Number(dxp.toFixed(4));
    const dyR = Number(dyp.toFixed(4));
    return {
      ch,
      style: {
        transform: `translate(-50%, -50%) rotate(var(--orbit-a)) translate(${dxR}rem, ${dyR}rem) rotate(calc(-1 * var(--orbit-a))) rotate(${thetaDeg}deg)`,
      },
    };
  });
});

const wrapStyle = computed((): Record<string, string> | undefined => {
  const s: Record<string, string> = {};
  if (props.kind === "captain" && props.accent) s["--accent"] = props.accent;
  if (props.orbitStack && !props.avatarOnly) {
    s["--orbit-a"] = `${Number(props.orbitAngleDeg ?? 0)}deg`;
  }
  return Object.keys(s).length ? s : undefined;
});
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
    :data-orbit-name-score="
      orbitStack && !avatarOnly ? orbitNameScoreVariant : undefined
    "
    :style="wrapStyle"
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
            'slot-inner--orbit-stack--exp-below': orbitLayoutExperimental,
          }"
        >
          <div class="av-wrap">
            <img
              v-if="member.avatar"
              class="av av--treasury-hit"
              :data-captain-anchor="k"
              :src="member.avatar"
              alt=""
              referrerpolicy="no-referrer"
              title="点击查看金库余额与流水"
              @click.stop="onHudAvatarClick"
            />
            <div
              v-else
              class="av ph av--treasury-hit"
              :data-captain-anchor="k"
              title="点击查看金库余额与流水"
              role="button"
              tabindex="0"
              @click.stop="onHudAvatarClick"
              @keydown.enter.prevent="onHudAvatarClick"
              @keydown.space.prevent="onHudAvatarClick"
            />
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
          <!-- arc模板：弧排昵称 + 外弧积分；缺几何 props 时回退径向单行 -->
          <template v-if="orbitLayoutUsesArcTemplate">
            <div
              v-if="scoreArcLayout"
              class="meta meta--orbit-score-arc"
              :style="{ '--orbit-score-arc-n': scoreArcLayout.length }"
            >
              <span
                v-for="(row, i) in scoreArcLayout"
                :key="i"
                class="pts-arc-char"
                :style="row.style"
              >{{ row.ch }}</span>
            </div>
            <div
              v-else
              class="meta meta--orbit-stack meta--orbit-pts"
            >
              <div class="pts">{{ balanceDigitsOnly }}</div>
            </div>
            <div
              v-if="nameArcLayout"
              class="meta meta--orbit-name-arc"
              :style="{ '--orbit-name-arc-n': nameArcLayout.length }"
            >
              <span
                v-for="(row, i) in nameArcLayout"
                :key="i"
                class="nm-arc-char"
                :style="row.style"
              >{{ row.ch }}</span>
            </div>
            <div
              v-else
              class="meta meta--orbit-stack meta--orbit-name"
            >
              <div class="nm nm--orbit-inline">{{ displayName }}</div>
            </div>
          </template>
          <!-- experimental：昵称、积分均在头像下方（不占用径向弧排） -->
          <template v-else-if="orbitLayoutExperimental">
            <div class="orbit-exp-name-score">
              <div class="orbit-exp__pts">{{ balanceDigitsOnly }}</div>
              <div class="orbit-exp__name">{{ displayName }}</div>
            </div>
          </template>
          <template v-if="!avatarOnly && orbitStack">
            <div
              v-for="f in floatersForTarget"
              :key="f.key"
              class="floater floater--orbit"
              :class="f.kind"
              :style="{ '--f-stack': f.stackIndex }"
            >
              {{ f.text }}
            </div>
          </template>
          <div v-if="!avatarOnly && !orbitStack" class="meta">
            <div class="nm">{{ member.name }}</div>
            <div class="pts">{{ balanceDigitsOnly }}</div>
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
  min-width: var(--orbit-avatar-size, 36px);
  max-width: none;
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
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  /* 对称垫高：几何中心 = 头像中心，供赤道锚点对齐；径向位移由 .orbit-board 注入的 --orbit-shift-radial */
  padding-block: var(--orbit-radial-pad, 1.82rem);
  width: 100%;
}
.meta--orbit-stack {
  position: absolute;
  left: 50%;
  top: 50%;
  min-width: 0;
  padding: 0;
  text-align: center;
  pointer-events: none;
}
.meta--orbit-stack:not(.meta--orbit-name) {
  width: 100%;
  max-width: var(--orbit-meta-max, 4.25rem);
}
.meta--orbit-stack .pts {
  max-width: 100%;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: auto;
}
/** 外圈侧：先转向径向朝外，再平移，再旋回以保持字横平竖直 */
.meta--orbit-pts {
  z-index: 2;
  transform: translate(-50%, -50%) rotate(var(--orbit-a, 0deg))
    translateY(calc(-1 * var(--orbit-shift-radial))) rotate(calc(-1 * var(--orbit-a, 0deg)));
}
/** 圆心侧：与积分同一套 rotate →径向平移 → 旋回（无扇形弧参数时的回退） */
.meta--orbit-name {
  z-index: 5;
  transform: translate(-50%, -50%) rotate(var(--orbit-a, 0deg))
    translateY(var(--orbit-shift-radial)) rotate(calc(-1 * var(--orbit-a, 0deg)));
  width: auto;
  max-width: var(--orbit-label-max, 4.35rem);
  min-width: 0;
  overflow: visible;
  isolation: isolate;
}
/** 昵称贴扇形最内弧：逐字等圆心角、等半径 */
.meta--orbit-name-arc {
  z-index: 5;
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  overflow: visible;
  pointer-events: none;
  isolation: isolate;
  --orbit-name-arc-n: 1;
}
.nm-arc-char {
  position: absolute;
  left: 0;
  top: 0;
  font-size: calc(
    var(--orbit-name-font, 0.62rem) * min(1, 11 / max(2, var(--orbit-name-arc-n)))
  );
  line-height: 1;
  font-weight: 700;
  color: var(--text, #e8eef7);
  text-shadow:
    0 0 3px color-mix(in srgb, var(--bg, #0f1419) 92%, transparent),
    0 1px 2px color-mix(in srgb, var(--bg, #0f1419) 88%, transparent);
  pointer-events: auto;
  transform-origin: center center;
  white-space: nowrap;
}
/** 外弧积分：逐字弧排，与昵称弧同一几何策略 */
.meta--orbit-score-arc {
  z-index: 2;
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  overflow: visible;
  pointer-events: none;
  isolation: isolate;
  --orbit-score-arc-n: 1;
}
.pts-arc-char {
  position: absolute;
  left: 0;
  top: 0;
  font-size: calc(
    var(--orbit-score-font, 0.66rem) * min(1, 11 / max(2, var(--orbit-score-arc-n)))
  );
  line-height: 1;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--accent, #3dd68c);
  text-shadow:
    0 0 3px color-mix(in srgb, var(--bg, #0f1419) 92%, transparent),
    0 1px 2px color-mix(in srgb, var(--bg, #0f1419) 88%, transparent);
  pointer-events: auto;
  transform-origin: center center;
  white-space: nowrap;
}
/**
 * experimental（已保存定稿）：积分在头像上、昵称在头像下。
 * 切换弧排模板：orbitSectorPanel.orbitNameScoreVariant = 'arc'
 */
.orbit-exp-name-score {
  position: absolute;
  inset: 0;
  z-index: 4;
  pointer-events: none;
}
.orbit-exp__pts {
  position: absolute;
  left: 50%;
  top: calc(50% - var(--orbit-avatar-half, 18px) - 0.1rem);
  transform: translate(-50%, -100%);
  max-width: min(6.5rem, 42vw);
  font-size: var(--orbit-score-font, 0.66rem);
  line-height: var(--orbit-score-lh, 1.05);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--accent, #3dd68c);
  white-space: nowrap;
  text-align: center;
  text-shadow:
    0 0 3px color-mix(in srgb, var(--bg, #0f1419) 92%, transparent),
    0 1px 2px color-mix(in srgb, var(--bg, #0f1419) 88%, transparent);
  pointer-events: auto;
}
.orbit-exp__name {
  position: absolute;
  left: 50%;
  top: calc(50% + var(--orbit-avatar-half, 18px) + 0.12rem);
  transform: translateX(-50%);
  max-width: min(6.5rem, 42vw);
  font-size: var(--orbit-name-font, 0.62rem);
  line-height: var(--orbit-name-lh, 1.15);
  font-weight: 700;
  color: var(--text, #e8eef7);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
  text-shadow:
    0 0 3px color-mix(in srgb, var(--bg, #0f1419) 92%, transparent),
    0 1px 2px color-mix(in srgb, var(--bg, #0f1419) 88%, transparent);
  pointer-events: auto;
}
.nm--orbit-inline {
  font-size: var(--orbit-name-font, 0.62rem);
  line-height: var(--orbit-name-lh, 1.15);
  font-weight: 700;
  color: var(--text, #e8eef7);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow:
    0 0 3px color-mix(in srgb, var(--bg, #0f1419) 92%, transparent),
    0 1px 2px color-mix(in srgb, var(--bg, #0f1419) 88%, transparent);
  pointer-events: auto;
}
.meta--orbit-pts .pts {
  font-size: var(--orbit-score-font, 0.66rem);
  line-height: var(--orbit-score-lh, 1.05);
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
  z-index: 1;
  flex-shrink: 0;
  width: var(--orbit-avatar-size, 36px);
  height: var(--orbit-avatar-size, 36px);
}
.av {
  width: var(--orbit-avatar-size, 36px);
  height: var(--orbit-avatar-size, 36px);
  border-radius: 50%;
  object-fit: cover;
  border: var(--orbit-avatar-border, 2px) solid
    color-mix(in srgb, var(--accent) 50%, var(--border));
  flex-shrink: 0;
  display: block;
}
.av--treasury-hit {
  cursor: pointer;
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
/**
 * 轨道模式：积分在头像上、昵称在头像下（或弧排），原「头像下方」飘字易与字重叠；
 * 改为头像右侧、与头像垂直居中对齐，多条时沿竖向错开。
 */
.floater.floater--orbit {
  left: calc(50% + var(--orbit-avatar-half, 18px) + 0.34rem);
  top: 50%;
  right: auto;
  z-index: 8;
  transform: translateY(calc(-50% + var(--f-stack, 0) * -14px));
  animation: damageOrbitFromSide 1.15s cubic-bezier(0.22, 1, 0.36, 1) forwards;
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
@keyframes damageOrbitFromSide {
  0% {
    opacity: 0;
    transform: translateY(calc(-50% + var(--f-stack, 0) * -14px)) translateX(12px)
      scale(0.55);
    filter: blur(0.6px);
  }
  18% {
    opacity: 1;
    filter: blur(0);
    transform: translateY(calc(-50% + var(--f-stack, 0) * -14px)) translateX(0)
      scale(1.08);
  }
  55% {
    opacity: 1;
    transform: translateY(calc(-50% + var(--f-stack, 0) * -14px)) translateX(0)
      scale(1);
  }
  100% {
    opacity: 0;
    transform: translateY(calc(-50% + var(--f-stack, 0) * -14px)) translateX(-8px)
      scale(0.92);
  }
}
@media (prefers-reduced-motion: reduce) {
  .floater.floater--orbit {
    animation: none;
    opacity: 1;
    transform: translateY(calc(-50% + var(--f-stack, 0) * -14px));
  }
}
</style>
