<script setup lang="ts">
import axios from "axios";
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import { createApi } from "../lib/api";
import type { ClientConfig } from "../lib/api";
import {
  enrichMissingAvatarsFromDoseeing,
  resolveAvatarForNicknameDisplay,
} from "../lib/doseeingAvatar";
import {
  normalizeMoneyList,
  TEAM_DEFS,
  type CaptainMoneyCard,
} from "../lib/captainTeams";
import {
  captainTeamsFromRoster,
  hudBottomTeamFromRoster,
  hudOtherMembersFromRoster,
} from "../lib/rosterClassify";
import {
  clearRosterStore,
  initRosterFromFetchedCards,
  loadRosterMap,
  type RosterEntry,
} from "../lib/rosterDb";
import type { FlyActorHint } from "../lib/recordSource";
import { inferFlyActorFromRecord } from "../lib/recordSource";
import type { ApiListResponse, MoneyCard, MoneyRecord } from "../types";
import {
  formatBattleShowPath,
  loadBattleShowFromStorage,
  parseBattleShowPath,
  saveBattleShowToStorage,
  type BattleShowState,
} from "../lib/battleShowRoute";
import HudBattleMemberSlot from "./HudBattleMemberSlot.vue";
import {
  ORBIT_SECTOR_PANEL,
  orbitSectorPanelCssVars,
} from "../lib/orbitSectorPanel";

type OrbitPlaced = {
  card: CaptainMoneyCard;
  kind: "captain" | "member" | "other";
  accent?: string;
  angleDeg: number;
  ringIndex: number;
  /** 若设置则覆盖 orbitBaseRem + ringIndex*orbitStepRem（队长环动态半径、外环衔接） */
  orbitRadiusRem?: number;
  /** 同圈总人数与序号，用于无缝拼接扇形 */
  ringSlotCount: number;
  ringSlotIndex: number;
  /** 扇形边界（度）：0°=正上，顺时针；与 clip / 头像角一致 */
  sectorArcDeg: { a0: number; a1: number };
};

/** 队长内环半径（rem）：保证 n 人整圈时相邻弦长不小于面板弦长（px） */
function captainRingRem(n: number): number {
  const { orbitBaseRem, captainRingFloorOffsetRem, slotChordPx } =
    ORBIT_SECTOR_PANEL;
  if (n <= 0) return orbitBaseRem;
  const floor = orbitBaseRem + captainRingFloorOffsetRem;
  if (n === 1) return floor;
  const rPx = slotChordPx.captain / (2 * Math.sin(Math.PI / n));
  return Math.max(floor, rPx / 16);
}

function orbitMaxSlotsForRadiusRem(rRem: number): number {
  const rPx = rRem * 16;
  const k = Math.floor(
    (2 * Math.PI * rPx) / ORBIT_SECTOR_PANEL.slotChordPx.member,
  );
  return Math.max(5, Math.min(26, k));
}

/**
 * 队员/其他：第 ringIdx 圈（队长占0，首圈队员为 1）的轨道圆心半径 rem。
 * 有队长时首圈圆心至少落在队长完整外带之外 + 径向缝，避免为给外圈让路而裁掉队长扇形外缘。
 */
function memberRingRem(
  ringIdx: number,
  hasCaptains: boolean,
  captainRadiusRem: number,
): number {
  const {
    orbitBaseRem,
    orbitStepRem,
    bandInnerRem,
    bandOuterRem,
    ringRadialSeamRem,
  } = ORBIT_SECTOR_PANEL;
  /** 相邻圈圆心距 ≥ 环带厚 + 缝，保证每圈径向厚度一致时圈与圈仍有间隔 */
  const centerStep = Math.max(
    orbitStepRem,
    bandInnerRem + bandOuterRem + ringRadialSeamRem,
  );
  let first: number;
  if (hasCaptains) {
    const minFirstOutsideCaptain =
      captainRadiusRem +
      bandOuterRem +
      ringRadialSeamRem +
      bandInnerRem;
    first = Math.max(captainRadiusRem + centerStep, minFirstOutsideCaptain);
  } else {
    first = orbitBaseRem;
  }
  const depth = hasCaptains ? ringIdx - 1 : ringIdx;
  return first + Math.max(0, depth) * centerStep;
}

/** 槽所在轨道环半径（rem），与扇形 clip 内弧计算一致 */
function orbitSlotRingRadiusRem(p: OrbitPlaced): number {
  const { orbitBaseRem, orbitStepRem } = ORBIT_SECTOR_PANEL;
  return p.orbitRadiusRem ?? orbitBaseRem + p.ringIndex * orbitStepRem;
}

/** 0°=正上，顺时针；百分比相对正方形轨道板（50% 为圆心） */
function sectorArcToXY(deg: number, rPct: number): string {
  const rad = (deg * Math.PI) / 180;
  return `${50 + rPct * Math.sin(rad)}% ${50 - rPct * Math.cos(rad)}%`;
}

/** 环形扇区多边形（外弧 → 内弧），角度与 orbit头像一致 */
function sectorClipPathForArc(
  a0: number,
  a1: number,
  innerPct: number,
  outerPct: number,
): string {
  if (outerPct <= innerPct) return "none";
  let span = a1 - a0;
  if (span <= 0 && a1 >= 360 - 1e-6 && a0 <= 1e-6) span = 360;
  if (span <= 0) return "none";
  const segments = Math.max(4, Math.min(36, Math.ceil(span / 5)));
  const pts: string[] = [sectorArcToXY(a0, outerPct)];
  for (let s = 1; s <= segments; s++) {
    const t = a0 + (span * s) / segments;
    pts.push(sectorArcToXY(t, outerPct));
  }
  for (let s = segments; s >= 0; s--) {
    const t = a0 + (span * s) / segments;
    pts.push(sectorArcToXY(t, innerPct));
  }
  return `polygon(${pts.join(", ")})`;
}

/**
 * 扇形弧段中点角（度，0–360），用于头像径向位；支持 a0/a1 越出 [0,360]（如跨 0°）。
 */
function orbitArcMidDeg(a0: number, a1: number): number {
  let span = a1 - a0;
  if (span < -1e-6) span += 360;
  if (span <= 1e-6) {
    let m = a0 % 360;
    if (m < 0) m += 360;
    return m;
  }
  if (Math.abs(span - 360) < 1e-6 || span >= 360 - 1e-6) return 0;
  let mid = a0 + span / 2;
  mid = mid % 360;
  if (mid < 0) mid += 360;
  return mid;
}

/** 队长阵营 corner → 象限起始角（0°=上，顺时针）：tl=[270,360), tr=[0,90), br=[90,180), bl=[180,270) */
const QUAD_BASE_DEG: Record<"tl" | "tr" | "bl" | "br", number> = {
  tl: 270,
  tr: 0,
  bl: 180,
  br: 90,
};

function sectorRadiiPctFromRem(
  innerRem: number,
  outerRem: number,
  sideRem: number,
): { innerPct: number; outerPct: number } {
  const half = sideRem / 2;
  const innerPct = (innerRem / half) * 50;
  const outerPct = (outerRem / half) * 50;
  const inP = Math.max(0.5, Math.min(innerPct, 47));
  const outP = Math.max(inP + 0.85, Math.min(outerPct, 49.85));
  return { innerPct: inP, outerPct: outP };
}

/**
 * 轨道环带内外半径（rem）：每圈径向厚度恒为 bandInner+bandOuter；邻圈留缝；
 * 队长不因外圈裁外缘，与 memberRingRem 圈心距配合保证圈间有间隔。
 */
function orbitBandRadiiRem(
  p: OrbitPlaced,
  ringCenters: Map<number, number>,
  seamRem: number,
): { innerRem: number; outerRem: number } {
  const { hubSectorInnerRem, bandInnerRem, bandOuterRem } = ORBIT_SECTOR_PANEL;
  const T = bandInnerRem + bandOuterRem;
  const r = orbitSlotRingRadiusRem(p);
  let innerRem = Math.max(hubSectorInnerRem, r - bandInnerRem);
  let outerRem = innerRem + T;

  if (p.kind === "captain") {
    return { innerRem, outerRem };
  }

  const ri = p.ringIndex;
  const prevR = ringCenters.get(ri - 1);
  const nextR = ringCenters.get(ri + 1);

  for (let iter = 0; iter < 10; iter++) {
    if (prevR != null) {
      const innerMin = prevR + bandOuterRem + seamRem;
      if (innerRem < innerMin) {
        innerRem = innerMin;
        outerRem = innerRem + T;
      }
    }
    if (nextR != null) {
      const outerMax = nextR - bandInnerRem - seamRem;
      if (outerRem > outerMax) {
        outerRem = outerMax;
        innerRem = outerRem - T;
      }
    }
    if (innerRem < hubSectorInnerRem) {
      innerRem = hubSectorInnerRem;
      outerRem = innerRem + T;
    }
  }

  if (outerRem <= innerRem + 1e-3) {
    const mid = (innerRem + outerRem) / 2;
    innerRem = mid - 0.05;
    outerRem = mid + 0.05;
  } else {
    outerRem = innerRem + T;
  }
  return { innerRem, outerRem };
}

function sectorAccentHex(p: OrbitPlaced): string {
  if (p.kind === "captain" && p.accent) return p.accent;
  if (p.kind === "member") return "#5eb0e8";
  return "#e9b949";
}

const props = withDefaults(
  defineProps<{
    config: ClientConfig;
    /** 轮询间隔 ms */
    pollMs?: number;
    /** 是否显示顶部工具条（独立小窗可关） */
    showControls?: boolean;
    /** 与 #/battle/<path> 同步；嵌入主站时由 App 传入 */
    battleShowPath?: string | null;
    /** false：全屏 #/captain-hud 仅写 localStorage，不改地址栏 */
    syncBattleShowToHash?: boolean;
  }>(),
  /** 布尔 prop 在 Vue 中省略时默认为 false，需显式默认 true */
  { showControls: true, battleShowPath: null, syncBattleShowToHash: true },
);

const emit = defineEmits<{
  "update:battleShowPath": [path: string];
}>();

const pollInterval = computed(() =>
  Math.max(1500, Math.min(60000, props.pollMs ?? 4000)),
);
const showToolbar = computed(() => props.showControls !== false);

const loading = ref(false);
const err = ref("");
const paused = ref(false);

const cards = shallowRef<CaptainMoneyCard[]>([]);
/** IndexedDB 团员档案（队长槽位、预赛名次）；分类以库为准，不按列表第 16 位之后推断 */
const rosterMap = shallowRef(new Map<string, RosterEntry>());
/** 界面展示的队长余额（动画结束后才追上服务器） */
const displayBalance = ref<Record<string, number>>({});
/** 最近一次拉取到的余额 */
const serverBalance = ref<Record<string, number>>({});

const teams = computed(() =>
  rosterMap.value.size
    ? captainTeamsFromRoster(cards.value, rosterMap.value)
    : [],
);

const allCaptains = computed(() => {
  const out: CaptainMoneyCard[] = [];
  for (const t of teams.value) out.push(...t.members);
  return out;
});

/** 非预赛 48 名单、非队长 — 看板上方中间 */
const otherMembers = computed(() =>
  rosterMap.value.size
    ? hudOtherMembersFromRoster(cards.value, rosterMap.value)
    : [],
);
/** 预赛 48 名单内、非队长 — 看板下方中间 */
const bottomTeam = computed(() =>
  rosterMap.value.size
    ? hudBottomTeamFromRoster(cards.value, rosterMap.value)
    : [],
);

/** 被攻击人展示：勾选并集；「所有人」为快捷全选 */
const attackedShowAll = ref(true);
const attackedCaptain = ref(true);
const attackedOther = ref(true);
const attackedMember = ref(true);

/** 演示进攻：进攻/恢复次数、随机或指定目标 */
const demoAttackCount = ref(1);
const demoHealCount = ref(0);
const demoTargetRandom = ref(true);
const demoSpecificTargetId = ref("");
/** 特定对象：按展示名/ID 前缀筛选（首字或连续前缀） */
const demoTargetPrefixFilter = ref("");

let applyingBattleFromUrl = false;

function applyBattleState(s: BattleShowState) {
  applyingBattleFromUrl = true;
  attackedShowAll.value = s.attackedShowAll;
  attackedCaptain.value = s.captain;
  attackedOther.value = s.other;
  attackedMember.value = s.member;
  void nextTick(() => {
    applyingBattleFromUrl = false;
  });
}

function currentBattleState(): BattleShowState {
  return {
    attackedShowAll: attackedShowAll.value,
    captain: attackedCaptain.value,
    other: attackedOther.value,
    member: attackedMember.value,
  };
}

watch(
  () => props.battleShowPath,
  (seg) => {
    if (!props.syncBattleShowToHash) return;
    if (seg == null || String(seg).trim() === "") return;
    const p = parseBattleShowPath(seg);
    if (!p) return;
    applyBattleState(p);
  },
  { immediate: true },
);

watch(
  [attackedShowAll, attackedCaptain, attackedOther, attackedMember],
  () => {
    if (applyingBattleFromUrl) return;
    const s = currentBattleState();
    saveBattleShowToStorage(s);
    if (!props.syncBattleShowToHash) return;
    const path = formatBattleShowPath(s);
    if (path === props.battleShowPath) return;
    emit("update:battleShowPath", path);
  },
  { flush: "post" },
);

const effShowCaptain = computed(
  () => attackedShowAll.value || attackedCaptain.value,
);
const effShowOther = computed(
  () => attackedShowAll.value || attackedOther.value,
);
const effShowMember = computed(
  () => attackedShowAll.value || attackedMember.value,
);

watch(attackedShowAll, (v) => {
  if (v) {
    attackedCaptain.value = true;
    attackedOther.value = true;
    attackedMember.value = true;
  }
});

watch([attackedCaptain, attackedOther, attackedMember], ([c, o, m]) => {
  if (!c || !o || !m) attackedShowAll.value = false;
});

/** 所有参与加减分动画与轮询的成员（去重，受展示筛选约束） */
const allBoardTargets = computed(() => {
  const m = new Map<string, CaptainMoneyCard>();
  if (effShowCaptain.value) {
    for (const c of allCaptains.value) m.set(balKey(c.id), c);
  }
  if (effShowOther.value) {
    for (const c of otherMembers.value) m.set(balKey(c.id), c);
  }
  if (effShowMember.value) {
    for (const c of bottomTeam.value) m.set(balKey(c.id), c);
  }
  return [...m.values()];
});

function demoTargetDisplayLabel(c: CaptainMoneyCard): string {
  const n = c.name != null ? String(c.name).trim() : "";
  return n || `ID ${c.id}`;
}

/** 演示「特定对象」下拉：仅当前视图可攻击对象（与 allBoardTargets 一致），支持前缀筛选 */
const demoFilteredBoardTargets = computed(() => {
  const list = allBoardTargets.value;
  const q = demoTargetPrefixFilter.value.trim();
  if (!q) return list;
  const qLower = q.toLowerCase();
  const filtered = list.filter((c) => {
    const label = demoTargetDisplayLabel(c);
    return (
      label.toLowerCase().startsWith(qLower) || String(c.id).startsWith(q)
    );
  });
  return filtered.length > 0 ? filtered : list;
});

watch(
  allBoardTargets,
  (list) => {
    if (!list.length) return;
    const ids = new Set(list.map((c) => balKey(c.id)));
    if (!demoSpecificTargetId.value || !ids.has(demoSpecificTargetId.value)) {
      demoSpecificTargetId.value = balKey(list[0]!.id);
    }
  },
  { immediate: true },
);

watch(demoTargetRandom, (random) => {
  if (random) demoTargetPrefixFilter.value = "";
});

watch(
  [demoFilteredBoardTargets, demoTargetRandom],
  () => {
    if (demoTargetRandom.value) return;
    const list = demoFilteredBoardTargets.value;
    if (!list.length) return;
    const ids = new Set(list.map((c) => balKey(c.id)));
    if (!ids.has(demoSpecificTargetId.value)) {
      demoSpecificTargetId.value = balKey(list[0]!.id);
    }
  },
  { flush: "post" },
);

const visibleCaptains = computed(() =>
  effShowCaptain.value ? allCaptains.value : [],
);

/**
 * 同心环绕传送门：最内环队长按 A/B/C/D 象限各占 90°，分界落在 0°/90°/180°/270°（正上为0° 顺时针），
 * 象限内等分；队内相邻扇形角向重叠（captainIntraTeamSeamOverlapDeg），象限间留 interTeamBoundaryGapDeg。
 * 队员/其他外圈：同色相邻与队长队内一致角向重叠；异色（队员↔其他）相邻留缝，缝宽 = 2×memberIntraRingSeamOverlapDeg（与重叠带同宽）。
 */
const orbitPlacements = computed((): OrbitPlaced[] => {
  const out: OrbitPlaced[] = [];
  let nextRing = 0;
  let captainRadiusRem = 0;
  let hasCaptains = false;

  if (effShowCaptain.value) {
    type CapWedge = {
      card: CaptainMoneyCard;
      accent: string;
      a0: number;
      a1: number;
      center: number;
    };
    const capDrafts: CapWedge[] = [];
    const boundaryGap = ORBIT_SECTOR_PANEL.interTeamBoundaryGapDeg;
    const halfBoundary = boundaryGap / 2;
    const seamOv = ORBIT_SECTOR_PANEL.captainIntraTeamSeamOverlapDeg;
    for (const team of teams.value) {
      const m = team.members.length;
      if (m === 0) continue;
      const quadBase = QUAD_BASE_DEG[team.corner] + halfBoundary;
      const quadSpan = 90 - boundaryGap;
      const step = quadSpan / m;
      for (let k = 0; k < m; k++) {
        let a0 = quadBase + k * step;
        let a1 = quadBase + (k + 1) * step;
        if (m > 1 && seamOv > 0) {
          if (k > 0) a0 -= seamOv;
          if (k < m - 1) a1 += seamOv;
        }
        capDrafts.push({
          card: team.members[k]!,
          accent: team.accent,
          a0,
          a1,
          center: (a0 + a1) / 2,
        });
      }
    }
    capDrafts.sort((u, v) => u.a0 - v.a0);
    const nCap = capDrafts.length;
    if (nCap > 0) {
      hasCaptains = true;
      captainRadiusRem = captainRingRem(nCap);
      for (let i = 0; i < nCap; i++) {
        const w = capDrafts[i]!;
        out.push({
          card: w.card,
          kind: "captain",
          accent: w.accent,
          angleDeg: w.center,
          ringIndex: 0,
          orbitRadiusRem: captainRadiusRem,
          ringSlotCount: nCap,
          ringSlotIndex: i,
          /** 与象限槽位同宽，不在队内再收窄，避免扇形底图之间出现条缝 */
          sectorArcDeg: { a0: w.a0, a1: w.a1 },
        });
      }
      nextRing = 1;
    }
  }

  /**
   * 外圈顺序与积分脱钩：队员按档案预赛名次（bottomTeam 已有序），其他按 _orderIndex，
   * 避免 displayBalance 变化时扇形/头像位置重排。
   */
  const memb = effShowMember.value ? [...bottomTeam.value] : [];
  const oth = effShowOther.value ? [...otherMembers.value] : [];

  const memOv = ORBIT_SECTOR_PANEL.memberIntraRingSeamOverlapDeg;

  /** 队员优先、其他接在后面，同一圈可混排，角间隔与「仅其他/仅队员」一致 */
  const outerQueue: { card: CaptainMoneyCard; kind: "member" | "other" }[] = [
    ...memb.map((card) => ({ card, kind: "member" as const })),
    ...oth.map((card) => ({ card, kind: "other" as const })),
  ];

  let ring = nextRing;
  while (outerQueue.length) {
    const rRem = memberRingRem(ring, hasCaptains, captainRadiusRem);
    const cap = orbitMaxSlotsForRadiusRem(rRem);
    const chunk = outerQueue.splice(0, cap);
    const n = chunk.length;
    const stepDeg = 360 / n;

    if (n === 1) {
      const item = chunk[0]!;
      out.push({
        card: item.card,
        kind: item.kind,
        angleDeg: orbitArcMidDeg(0, 360),
        ringIndex: ring,
        orbitRadiusRem: rRem,
        ringSlotCount: 1,
        ringSlotIndex: 0,
        sectorArcDeg: { a0: 0, a1: 360 },
      });
      ring++;
      continue;
    }

    const a0: number[] = new Array(n);
    const a1: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      a0[i] = i * stepDeg;
      a1[i] = (i + 1) * stepDeg;
    }

    for (let boundary = 1; boundary < n; boundary++) {
      const sameKind =
        chunk[boundary - 1]!.kind === chunk[boundary]!.kind;
      if (sameKind) {
        a1[boundary - 1]! += memOv;
        a0[boundary]! -= memOv;
      } else {
        a1[boundary - 1]! -= memOv;
        a0[boundary]! += memOv;
      }
    }

    const sameWrap = chunk[n - 1]!.kind === chunk[0]!.kind;
    if (sameWrap) {
      a1[n - 1]! += memOv;
      a0[0]! -= memOv;
    } else {
      a1[n - 1]! -= memOv;
      a0[0]! += memOv;
    }

    for (let i = 0; i < n; i++) {
      const item = chunk[i]!;
      out.push({
        card: item.card,
        kind: item.kind,
        angleDeg: orbitArcMidDeg(a0[i]!, a1[i]!),
        ringIndex: ring,
        orbitRadiusRem: rRem,
        ringSlotCount: n,
        ringSlotIndex: i,
        sectorArcDeg: { a0: a0[i]!, a1: a1[i]! },
      });
    }
    ring++;
  }

  return out;
});

const orbitRingCenterByIndex = computed(() => {
  const m = new Map<number, number>();
  for (const p of orbitPlacements.value) {
    if (!m.has(p.ringIndex)) {
      m.set(p.ringIndex, orbitSlotRingRadiusRem(p));
    }
  }
  return m;
});

function orbitBandForSlot(p: OrbitPlaced) {
  return orbitBandRadiiRem(
    p,
    orbitRingCenterByIndex.value,
    ORBIT_SECTOR_PANEL.ringRadialSeamRem,
  );
}

function orbitInnerRadiusRem(p: OrbitPlaced): number {
  return orbitBandForSlot(p).innerRem;
}

function orbitOuterRadiusRem(p: OrbitPlaced): number {
  return orbitBandForSlot(p).outerRem;
}

function orbitEquatorRadiusRem(p: OrbitPlaced): number {
  const { innerRem, outerRem } = orbitBandForSlot(p);
  return (innerRem + outerRem) / 2;
}

function orbitSlotStyle(p: OrbitPlaced): Record<string, string> {
  const { innerRem, outerRem } = orbitBandForSlot(p);
  const eq = (innerRem + outerRem) / 2;
  return {
    "--orbit-a": `${p.angleDeg}deg`,
    "--orbit-r": `${eq}rem`,
    "--orbit-inner-r": `${innerRem}rem`,
    "--orbit-outer-r": `${outerRem}rem`,
  };
}

function sectorSkinStyle(
  p: OrbitPlaced,
  sideRem: number,
): Record<string, string> {
  const { innerRem, outerRem } = orbitBandForSlot(p);
  const { innerPct, outerPct } = sectorRadiiPctFromRem(
    innerRem,
    outerRem,
    sideRem,
  );
  const { a0, a1 } = p.sectorArcDeg;
  const clip = sectorClipPathForArc(a0, a1, innerPct, outerPct);
  const a = sectorAccentHex(p);
  return {
    clipPath: clip,
    WebkitClipPath: clip,
    "--sector-accent": a,
  };
}

/** 正方形轨道边长（rem），扇形 clip 百分比与圆心一致 */
const orbitBoardSideRem = computed(() => {
  const { orbitBaseRem, bandOuterRem, board } = ORBIT_SECTOR_PANEL;
  let maxR = 0;
  for (const p of orbitPlacements.value) {
    maxR = Math.max(maxR, p.orbitRadiusRem ?? orbitBaseRem);
  }
  const maxOuter = maxR + bandOuterRem;
  return Math.max(2 * maxOuter + board.sidePaddingRem, board.sideMinRem);
});

const orbitBoardInlineStyle = computed(() => ({
  "--orbit-side": `${orbitBoardSideRem.value}rem`,
  ...orbitSectorPanelCssVars(),
}));

/**
 * 中心传送门外环旋涡：conic 四段与轨道象限一致（0°=上顺时针），
 * 色带与 Treasury 四角 A/B/C/D 阵营色一致。
 */
const attackHubSwirlStyle = computed(() => {
  const [cA, cB, cC, cD] = TEAM_DEFS;
  return {
    "--attack-hub-swirl-tr": cB.accent,
    "--attack-hub-swirl-br": cD.accent,
    "--attack-hub-swirl-bl": cC.accent,
    "--attack-hub-swirl-tl": cA.accent,
    /** 与 orbit 队员 / 其他扇形底色一致；队员侧实色，其他侧面填充 40% 透明度（见 .attack-hub-taiji-fill--*） */
    "--attack-hub-taiji-member": "#5eb0e8",
    "--attack-hub-taiji-other": "#e9b949",
  };
});

type QueueItem = {
  targetId: string | number;
  card: string;
  endBalance: number;
};

const queue = ref<QueueItem[]>([]);
let processing = false;

/**
 * 飞入中实例（可多路并发）。
 * 调速仅按「同一被攻击人」统计：同时飞向该目标超过 20 路后，每多 10 路全体飞向该目标的速度 +50%（不影响其他目标）。
 */
type FlyInst = {
  id: number;
  src: string;
  label: string;
  targetId: string | number;
  size: number;
};
const flyInstances = ref<FlyInst[]>([]);
let flySeq = 0;
/** 每路飞入的调速系数（>1 加速以尽快结束） */
const flySpeedById = new Map<number, { speedMul: number }>();
/** 同一目标并发飞入 ≤ 此值时为原速；超出部分按步进加速 */
const FLY_PER_TARGET_CONGEST_THRESHOLD = 20;
const FLY_PER_TARGET_SPEED_STEP_COUNT = 10;
const FLY_PER_TARGET_SPEED_BONUS_PER_STEP = 0.5;

/** 落地后暂留在目标头像旁的小头像（避免重叠，有上限） */
type ParkedNear = {
  key: number;
  targetKey: string;
  src: string;
  /** 来源队长昵称（加减分操作者） */
  name: string;
  stackIndex: number;
};
const parkedNear = ref<ParkedNear[]>([]);
let parkedKey = 0;
/** 同一目标旁最多并排小头像；超出则只播飘字 */
const MAX_PARKED_PER_TARGET = 4;

const hitIds = ref<Set<string>>(new Set());
const healIds = ref<Set<string>>(new Set());
const floaters = ref<
  Array<{
    id: string;
    text: string;
    kind: "hit" | "heal";
    key: number;
    /** 同一目标多条飘字纵向错开 */
    stackIndex: number;
  }>
>([]);
let floaterKey = 0;
/** 四角 A/B/C/D 阵营围成的2×2 区域，飞入起点为其对称中心（不含上下 strips） */
const cornersFlyHubRef = ref<HTMLElement | null>(null);

const FLY_MS_MIN = 2500;
const FLY_MS_MAX = 5000;
const FLY_SIZE = 28;
/**
 * 飞入路径进度 u（ease 后 0→1）达到此值后起渐隐，u=1 时透明度为 0（抵达中心已基本消失）
 */
const FLY_OPACITY_FADE_START_U = 0.68;

function randomFlyMs(): number {
  return FLY_MS_MIN + Math.random() * (FLY_MS_MAX - FLY_MS_MIN);
}

function speedMulForSameTargetConcurrent(n: number): number {
  if (n <= FLY_PER_TARGET_CONGEST_THRESHOLD) return 1;
  const over = n - FLY_PER_TARGET_CONGEST_THRESHOLD;
  const steps = Math.ceil(over / FLY_PER_TARGET_SPEED_STEP_COUNT);
  return 1 + FLY_PER_TARGET_SPEED_BONUS_PER_STEP * steps;
}

function recalculateFlySpeeds() {
  const list = flyInstances.value;
  const countByTarget = new Map<string, number>();
  for (const f of list) {
    const k = balKey(f.targetId);
    countByTarget.set(k, (countByTarget.get(k) ?? 0) + 1);
  }
  for (const f of list) {
    const row = flySpeedById.get(f.id);
    if (!row) continue;
    const n = countByTarget.get(balKey(f.targetId)) ?? 1;
    row.speedMul = speedMulForSameTargetConcurrent(n);
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

function balKey(id: string | number) {
  return String(id);
}

function anchorEl(id: string | number): HTMLElement | null {
  return document.querySelector(`[data-captain-anchor="${balKey(id)}"]`);
}

/** 飞入起点：四阵营区域中心（viewport 坐标，与 FLY_SIZE 对齐为 translate 左上角） */
function cornersHubStart(size: number): { x: number; y: number } {
  const el = cornersFlyHubRef.value;
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      return {
        x: r.left + r.width / 2 - size / 2,
        y: r.top + r.height / 2 - size / 2,
      };
    }
  }
  const s = size;
  return {
    x: window.innerWidth / 2 - s / 2,
    y: window.innerHeight / 2 - s / 2,
  };
}

/** 接近 material standard cubic-bezier(0.4, 0, 0.2, 1) 的 ease-out */
function easeFlyProgress(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** 飞入终点：飞行小头像（pin）中心与目标头像中心对齐，落在对方头像上 */
function rectOf(el: HTMLElement | null, size: number) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    x: r.left + r.width / 2 - size / 2,
    y: r.top + r.height / 2 - size / 2,
  };
}

async function fetchCards() {
  const api = createApi(props.config);
  const body = {
    page: 1,
    size: 100,
    search: [
      {
        key: "enable",
        value: "1",
        condition: "=",
        relationship: "AND",
        type: "CONDITION",
      },
    ],
    sort: [{ content: "id", condition: "AES" }],
  };
  const res = (await api.moneyList(body)) as ApiListResponse<MoneyCard>;
  if (res.code !== 0 || !res.data?.list) {
    throw new Error("拉取金库列表失败");
  }
  const list = normalizeMoneyList(
    res.data.list || [],
    props.config.currencyProportion || 100,
  );
  return enrichMissingAvatarsFromDoseeing(list);
}

async function fetchLatestRecord(card: string): Promise<MoneyRecord | null> {
  try {
    const api = createApi(props.config);
    const body: Record<string, unknown> = {
      page: 1,
      size: 5,
      search: [
        {
          key: "card",
          value: String(card),
          condition: "=",
          relationship: "AND",
          type: "CONDITION",
        },
      ],
      sort: [{ content: "id", condition: "DESC" }],
    };
    const res = (await api.moneyRecordList(body)) as ApiListResponse<MoneyRecord>;
    if (res.code !== 0 || !res.data?.list?.length) return null;
    return res.data.list[0] as MoneyRecord;
  } catch {
    return null;
  }
}

function mergeQueueFromServer() {
  const srv = serverBalance.value;
  const disp = displayBalance.value;
  const q = queue.value;
  for (const c of allBoardTargets.value) {
    const id = c.id;
    const k = balKey(id);
    const want = srv[k];
    const have = disp[k];
    if (want === have) continue;
    const card = String(c.card ?? "");
    if (!card) continue;
    const idx = q.findIndex((it) => balKey(it.targetId) === k);
    if (idx >= 0) {
      const next = [...q];
      next[idx] = { ...next[idx], endBalance: want };
      queue.value = next;
    } else {
      queue.value = [...q, { targetId: id, card, endBalance: want }];
    }
  }
}

function parkedCountForTarget(targetKey: string) {
  return parkedNear.value.filter((p) => p.targetKey === targetKey).length;
}

function pushParkedAfterFly(
  targetKey: string,
  srcUrl: string | undefined,
  actorName: string,
) {
  if (!srcUrl) return;
  const n = parkedCountForTarget(targetKey);
  if (n >= MAX_PARKED_PER_TARGET) return;
  const pk = ++parkedKey;
  parkedNear.value = [
    ...parkedNear.value,
    {
      key: pk,
      targetKey,
      src: srcUrl,
      name: actorName.trim() || "未知",
      stackIndex: n,
    },
  ];
  window.setTimeout(() => {
    parkedNear.value = parkedNear.value.filter((p) => p.key !== pk);
  }, 2600);
}

async function playFly(
  actor: FlyActorHint | undefined,
  target: CaptainMoneyCard,
): Promise<void> {
  await runFlyAnimation(actor, target);
}

async function runFlyAnimation(
  actor: FlyActorHint | undefined,
  target: CaptainMoneyCard,
): Promise<void> {
  const tkPre = balKey(target.id);
  /** 目标旁小头像已满时不再飞入，只保留下方扣分飘字 */
  if (parkedCountForTarget(tkPre) >= MAX_PARKED_PER_TARGET) {
    await new Promise<void>((r) => setTimeout(r, 40));
    return;
  }

  const size = FLY_SIZE;
  const flyMs = Math.max(800, randomFlyMs());
  const targetId = target.id;

  const placeholderSvg =
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
          <circle cx="32" cy="32" r="30" fill="#334155"/><text x="32" y="38" text-anchor="middle" fill="#94a3b8" font-size="22">?</text>
        </svg>`,
    );

  const srcUrl =
    (actor?.avatar && String(actor.avatar).trim()) || placeholderSvg;

  const actorLabel = actor?.name?.trim() || "未知来源";

  const id = ++flySeq;
  flyInstances.value = [
    ...flyInstances.value,
    { id, src: srcUrl, label: actorLabel, targetId, size },
  ];
  flySpeedById.set(id, { speedMul: 1 });
  recalculateFlySpeeds();

  await nextTick();
  const layer = document.querySelector(
    `[data-fly-id="${id}"]`,
  ) as HTMLElement | null;
  if (!layer) {
    flyInstances.value = flyInstances.value.filter((f) => f.id !== id);
    flySpeedById.delete(id);
    recalculateFlySpeeds();
    return;
  }

  layer.style.transition = "none";
  layer.style.opacity = "1";

  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  try {
    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        resolve();
      };
      const t0 = performance.now();
      let lastNow = t0;
      let pathProgress = 0;
      const step = (now: number) => {
        if (finished) return;
        const startNow = cornersHubStart(size);
        const elNow = anchorEl(targetId);
        const endNow = rectOf(elNow, size) ?? startNow;

        if (reduceMotion) {
          pathProgress = Math.min(1, (now - t0) / Math.min(600, flyMs));
        } else {
          const dt = Math.min(80, now - lastNow);
          lastNow = now;
          const ctrl = flySpeedById.get(id);
          const speedMul = ctrl?.speedMul ?? 1;
          pathProgress += (dt / flyMs) * speedMul;
          if (pathProgress > 1) pathProgress = 1;
        }

        const u = reduceMotion
          ? pathProgress
          : easeFlyProgress(pathProgress);
        const x = startNow.x + (endNow.x - startNow.x) * u;
        const y = startNow.y + (endNow.y - startNow.y) * u;
        layer.style.transform = `translate(${x}px, ${y}px)`;

        if (reduceMotion) {
          layer.style.opacity = pathProgress < 1 ? "1" : "0";
        } else {
          const s0 = FLY_OPACITY_FADE_START_U;
          const fade = Math.max(0, Math.min(1, (u - s0) / (1 - s0)));
          layer.style.opacity = String(1 - fade);
        }

        if (pathProgress < 1) {
          requestAnimationFrame(step);
        } else {
          layer.style.transform = `translate(${endNow.x}px, ${endNow.y}px)`;
          layer.style.opacity = "0";
          finish();
        }
      };
      requestAnimationFrame(step);
      window.setTimeout(finish, Math.ceil(flyMs / 0.15) + 600);
    });
  } finally {
    flyInstances.value = flyInstances.value.filter((f) => f.id !== id);
    flySpeedById.delete(id);
    recalculateFlySpeeds();

    const tk = balKey(target.id);
    const tname = String(target.name ?? "").trim();
    if (actor) {
      const samePerson =
        (actor.captainId != null && balKey(actor.captainId) === tk) ||
        (!!tname && actor.name?.trim() === tname);
      if (!samePerson) {
        pushParkedAfterFly(tk, srcUrl, actorLabel);
      }
    }
  }
}

function flashTarget(targetId: string | number, delta: number) {
  const k = balKey(targetId);
  const isHit = delta < 0;
  const setRef = isHit ? hitIds : healIds;
  const next = new Set(setRef.value);
  next.add(k);
  setRef.value = next;
  const fk = ++floaterKey;
  const stackIndex = floaters.value.filter((f) => f.id === k).length;
  floaters.value = [
    ...floaters.value,
    {
      id: k,
      text: `${delta > 0 ? "+" : ""}${delta.toLocaleString()}`,
      kind: isHit ? "hit" : "heal",
      key: fk,
      stackIndex,
    },
  ];
  window.setTimeout(() => {
    const h = new Set(hitIds.value);
    const e = new Set(healIds.value);
    h.delete(k);
    e.delete(k);
    hitIds.value = h;
    healIds.value = e;
  }, 900);
  window.setTimeout(() => {
    floaters.value = floaters.value.filter((f) => f.key !== fk);
  }, 2200);
}

async function processQueueLoop() {
  if (processing || paused.value) return;
  const item = queue.value[0];
  if (!item) return;
  processing = true;
  try {
    const target = allBoardTargets.value.find(
      (c) => balKey(c.id) === balKey(item.targetId),
    );
    if (!target?.card) {
      queue.value = queue.value.slice(1);
      mergeQueueFromServer();
      return;
    }
    const k = balKey(item.targetId);
    const have = displayBalance.value[k] ?? serverBalance.value[k] ?? 0;
    const delta = item.endBalance - have;
    if (delta === 0) {
      queue.value = queue.value.slice(1);
      mergeQueueFromServer();
      return;
    }

    const record = await fetchLatestRecord(String(target.card));
    let actor = inferFlyActorFromRecord(
      record,
      allBoardTargets.value,
      k,
      String(target.name ?? "").trim(),
    );
    if (actor && !actor.avatar?.trim() && actor.name?.trim()) {
      const url = await resolveAvatarForNicknameDisplay(actor.name);
      actor = { ...actor, avatar: url };
    }

    await playFly(actor, target);

    displayBalance.value = { ...displayBalance.value, [k]: item.endBalance };
    flashTarget(item.targetId, delta);
    queue.value = queue.value.slice(1);
    mergeQueueFromServer();
  } finally {
    processing = false;
    void processQueueLoop();
  }
}

function boardBalanceIdSet(
  list: CaptainMoneyCard[],
  roster: Map<string, RosterEntry>,
  vis: { captain: boolean; other: boolean; member: boolean },
): Set<string> {
  const keys = new Set<string>();
  if (vis.captain) {
    for (const e of roster.values()) {
      if (e.captainSlot != null) keys.add(e.id);
    }
  }
  if (vis.member) {
    for (const c of hudBottomTeamFromRoster(list, roster)) keys.add(balKey(c.id));
  }
  if (vis.other) {
    for (const c of hudOtherMembersFromRoster(list, roster)) keys.add(balKey(c.id));
  }
  return keys;
}

async function resetLocalRoster() {
  if (
    !window.confirm(
      "确定清空本地团员档案（IndexedDB）？下次刷新会按当前金库列表重新写入队长槽位与预赛 48 名次。",
    )
  ) {
    return;
  }
  err.value = "";
  try {
    await clearRosterStore();
    rosterMap.value = new Map();
    await tick(true);
  } catch (e: unknown) {
    err.value = e instanceof Error ? e.message : String(e);
  }
}

async function tick(force = false) {
  if (!force && paused.value) return;
  try {
    const list = await fetchCards();
    try {
      await initRosterFromFetchedCards(list);
      rosterMap.value = await loadRosterMap();
    } catch (e: unknown) {
      err.value =
        e instanceof Error
          ? `本地团员库失败：${e.message}`
          : "本地团员库失败（请检查浏览器是否允许 IndexedDB）";
      rosterMap.value = new Map();
      cards.value = list;
      return;
    }
    cards.value = list;
    const nextSrv: Record<string, number> = {};
    const keys = boardBalanceIdSet(list, rosterMap.value, {
      captain: effShowCaptain.value,
      other: effShowOther.value,
      member: effShowMember.value,
    });
    for (const c of list) {
      if (keys.has(balKey(c.id))) {
        nextSrv[balKey(c.id)] = Number(c.balance ?? 0);
      }
    }
    serverBalance.value = nextSrv;

    if (!Object.keys(displayBalance.value).length) {
      displayBalance.value = { ...nextSrv };
      return;
    }
    mergeQueueFromServer();
    void processQueueLoop();
  } catch (e: unknown) {
    if (axios.isAxiosError(e)) {
      const st = e.response?.status;
      err.value = `拉取失败 HTTP ${st ?? "?"}`;
    } else {
      err.value = e instanceof Error ? e.message : String(e);
    }
  }
}

async function manualLoad() {
  loading.value = true;
  err.value = "";
  try {
    await tick(true);
  } finally {
    loading.value = false;
  }
}

function clampDemoN(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(50_000, Math.floor(v));
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

function demoDeltaHit(target: CaptainMoneyCard): number {
  const k = balKey(target.id);
  const have = displayBalance.value[k] ?? serverBalance.value[k] ?? 0;
  return -Math.max(
    1,
    Math.min(99999, Math.round(Math.abs(have) * 0.08 + 500)),
  );
}

function demoDeltaHeal(target: CaptainMoneyCard): number {
  const k = balKey(target.id);
  const have = displayBalance.value[k] ?? serverBalance.value[k] ?? 0;
  return Math.max(
    1,
    Math.min(99999, Math.round(Math.abs(have) * 0.02 + 300)),
  );
}

/** 本地演示：多路飞头像 + 飘字 + 红闪；同一目标并发过多时仅该目标飞入加速。建议先勾选「暂停轮询」。 */
async function demoAttackHit() {
  const targets = allBoardTargets.value;
  if (targets.length < 1) {
    err.value = "演示需至少展示一名被攻击对象（勾选展示队长/队员/其他）";
    return;
  }
  const caps = visibleCaptains.value;
  if (caps.length < 1) {
    err.value = "演示需至少一名展示中的队长作为攻击方";
    return;
  }
  const nAtt = clampDemoN(demoAttackCount.value);
  const nHeal = clampDemoN(demoHealCount.value);
  if (nAtt + nHeal === 0) {
    err.value = "进攻人数与恢复人数至少一项大于 0";
    return;
  }
  err.value = "";
  processing = true;
  try {
    const pickTarget = (): CaptainMoneyCard => {
      if (demoTargetRandom.value) {
        return targets[Math.floor(Math.random() * targets.length)]!;
      }
      const sid = demoSpecificTargetId.value;
      const one = targets.find((c) => balKey(c.id) === sid);
      return one ?? targets[0]!;
    };

    type DemoTask = { target: CaptainMoneyCard; delta: number };
    const tasks: DemoTask[] = [];
    for (let i = 0; i < nAtt; i++) {
      const target = pickTarget();
      tasks.push({ target, delta: demoDeltaHit(target) });
    }
    for (let i = 0; i < nHeal; i++) {
      const target = pickTarget();
      tasks.push({ target, delta: demoDeltaHeal(target) });
    }
    const order = shuffleArray(tasks);

    const deltaByKey = new Map<string, number>();
    for (const t of order) {
      const k = balKey(t.target.id);
      deltaByKey.set(k, (deltaByKey.get(k) ?? 0) + t.delta);
    }

    const source = caps[0]!;
    const actor: FlyActorHint = {
      name: String(source.name ?? "").trim() || `ID ${source.id}`,
      avatar: source.avatar || undefined,
      captainId: source.id,
    };

    await Promise.all(
      order.map(async (t) => {
        await runFlyAnimation(actor, t.target);
        flashTarget(t.target.id, t.delta);
      }),
    );

    const next = { ...displayBalance.value };
    for (const [k, d] of deltaByKey) {
      next[k] = (next[k] ?? serverBalance.value[k] ?? 0) + d;
    }
    displayBalance.value = next;
  } finally {
    processing = false;
  }
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => {
    void tick(false);
  }, pollInterval.value);
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

onMounted(async () => {
  if (!props.syncBattleShowToHash) {
    applyBattleState(loadBattleShowFromStorage());
  }
  await manualLoad();
  startPoll();
});

onUnmounted(() => {
  stopPoll();
});

defineExpose({ reload: manualLoad, startPoll, stopPoll });
</script>

<template>
  <section class="hud" :class="{ 'no-controls': !showToolbar }">
    <div v-if="showToolbar" class="bar">
      <label class="pause">
        <input v-model="paused" type="checkbox" />
        暂停轮询
      </label>
      <button type="button" class="btn" :disabled="loading" @click="manualLoad">
        {{ loading ? "刷新中…" : "立即刷新" }}
      </button>
      <button
        type="button"
        class="btn"
        :disabled="loading"
        title="清空 IndexedDB 团员档案后，下次拉取按当前列表重新生成"
        @click="resetLocalRoster"
      >
        重置本地团员
      </button>
      <button
        type="button"
        class="btn btn-demo"
        :disabled="
          loading ||
          allBoardTargets.length < 1 ||
          visibleCaptains.length < 1 ||
          processing
        "
        title="先暂停轮询可避免下次刷新把演示余额同步回去；同一被攻击人同时超过 20 路飞入时，每多 10 路该目标飞入加速 50%"
        @click="demoAttackHit"
      >
        演示进攻效果
      </button>
      <div class="bar-demo" role="group" aria-label="演示参数">
        <span class="bar-demo-lbl">演示</span>
        <label class="bar-demo-field">
          进攻人数
          <input
            v-model.number="demoAttackCount"
            class="bar-demo-num"
            type="number"
            min="0"
            max="50000"
            step="1"
          />
        </label>
        <label class="bar-demo-field">
          恢复人数
          <input
            v-model.number="demoHealCount"
            class="bar-demo-num"
            type="number"
            min="0"
            max="50000"
            step="1"
          />
        </label>
        <label class="bar-demo-radio">
          <input v-model="demoTargetRandom" type="radio" :value="true" />
          随机对象
        </label>
        <div
          class="bar-demo-specific"
          :class="{ 'bar-demo-specific--muted': demoTargetRandom }"
        >
          <label class="bar-demo-radio bar-demo-radio--specific">
            <input v-model="demoTargetRandom" type="radio" :value="false" />
            特定对象
          </label>
          <div v-show="!demoTargetRandom" class="bar-demo-specific-controls">
            <input
              v-model="demoTargetPrefixFilter"
              type="search"
              class="bar-demo-filter"
              placeholder="首字/前缀筛选"
              maxlength="24"
              autocomplete="off"
              aria-label="按展示名或 ID 前缀筛选可攻击对象"
            />
            <select
              v-model="demoSpecificTargetId"
              class="bar-demo-select"
              aria-label="当前视图可攻击对象"
            >
              <option
                v-for="c in demoFilteredBoardTargets"
                :key="balKey(c.id)"
                :value="balKey(c.id)"
              >
                {{ demoTargetDisplayLabel(c) }}
              </option>
            </select>
          </div>
        </div>
      </div>
      <div class="bar-attacked" role="group" aria-label="被攻击人展示范围">
        <span class="bar-attacked-lbl">展示</span>
        <label class="bar-chk">
          <input v-model="attackedShowAll" type="checkbox" />
          所有人
        </label>
        <label class="bar-chk">
          <input v-model="attackedCaptain" type="checkbox" />
          队长
        </label>
        <label class="bar-chk">
          <input v-model="attackedOther" type="checkbox" />
          其他
        </label>
        <label class="bar-chk">
          <input v-model="attackedMember" type="checkbox" />
          队员
        </label>
      </div>
    </div>
    <p v-if="err" class="err">{{ err }}</p>

    <div class="board">
      <div
        v-if="orbitPlacements.length"
        class="orbit-board"
        :style="orbitBoardInlineStyle"
      >
        <div class="orbit-sectors" aria-hidden="true">
          <div
            v-for="p in orbitPlacements"
            :key="'sec-' + p.kind + '-' + String(p.card.id)"
            class="orbit-sector"
            :style="sectorSkinStyle(p, orbitBoardSideRem)"
          />
        </div>
        <div
          ref="cornersFlyHubRef"
          class="orbit-hub attack-hub-bh"
          :style="attackHubSwirlStyle"
          aria-hidden="true"
        >
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
        </div>
        <div
          v-for="p in orbitPlacements"
          :key="p.kind + '-' + String(p.card.id)"
          class="orbit-slot"
          :style="orbitSlotStyle(p)"
        >
          <div class="orbit-slot-pin">
            <HudBattleMemberSlot
              :member="p.card"
              :kind="p.kind"
              :accent="p.accent"
              orbit-stack
              :orbit-angle-deg="p.angleDeg"
              :orbit-equator-rem="orbitEquatorRadiusRem(p)"
              :orbit-inner-rem="orbitInnerRadiusRem(p)"
              :orbit-outer-rem="orbitOuterRadiusRem(p)"
              :orbit-sector-arc="p.sectorArcDeg"
              :hit-ids="hitIds"
              :heal-ids="healIds"
              :parked-near="parkedNear"
              :floaters="floaters"
              :display-balance="displayBalance"
            />
          </div>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div class="fly-avatar-layer" aria-hidden="true">
        <div
          v-for="f in flyInstances"
          :key="f.id"
          class="fly-mover"
          :data-fly-id="f.id"
        >
          <div class="fly-mover-body">
            <div
              class="fly-mover-pin"
              :style="{
                width: f.size + 'px',
                height: f.size + 'px',
              }"
            >
              <img class="fly-img" :src="f.src" alt="" referrerpolicy="no-referrer" />
            </div>
            <span class="fly-mover-name">{{ f.label }}</span>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.hud {
  border-radius: 14px;
  border: 1px solid var(--border, #2d3a4d);
  /* 随全局配色变化（原先用写死的 rgba，浅色主题不会变） */
  background: linear-gradient(
    160deg,
    color-mix(in srgb, var(--surface) 94%, var(--text) 3%),
    color-mix(in srgb, var(--bg) 92%, var(--surface) 8%)
  );
  padding: 0.65rem 0.75rem 0.85rem;
  margin-bottom: 1rem;
}
.hud.no-controls {
  padding-top: 0.85rem;
}
.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.65rem 1rem;
  margin-bottom: 0.5rem;
  font-size: 0.82rem;
  color: var(--muted, #8b9cb3);
}
.pause {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  cursor: pointer;
}
.bar-attacked {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem 0.75rem;
  margin-left: auto;
  font-size: 0.78rem;
  color: var(--muted, #8b9cb3);
}
.bar-demo {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.65rem;
  font-size: 0.78rem;
  color: var(--muted, #8b9cb3);
}
.bar-demo-lbl {
  font-weight: 700;
  color: var(--text, #e8eef7);
  margin-right: 0.1rem;
}
.bar-demo-field {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  cursor: pointer;
  user-select: none;
  color: var(--text, #e8eef7);
}
.bar-demo-num {
  width: 2.9rem;
  padding: 0.12rem 0.35rem;
  border-radius: 6px;
  border: 1px solid var(--border, #2d3a4d);
  background: var(--surface, #1a2332);
  color: var(--text, #e8eef7);
  font-size: 0.78rem;
}
.bar-demo-radio {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  cursor: pointer;
  user-select: none;
  color: var(--text, #e8eef7);
}
.bar-demo-radio input {
  accent-color: var(--primary, #5b9cff);
  cursor: pointer;
}
.bar-demo-specific {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.55rem;
}
.bar-demo-specific--muted {
  opacity: 0.48;
  filter: grayscale(0.35);
}
.bar-demo-specific--muted .bar-demo-radio--specific {
  cursor: pointer;
}
.bar-demo-specific-controls {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.45rem;
}
.bar-demo-filter {
  width: 7.25rem;
  padding: 0.12rem 0.4rem;
  border-radius: 6px;
  border: 1px solid var(--border, #2d3a4d);
  background: var(--surface, #1a2332);
  color: var(--text, #e8eef7);
  font-size: 0.78rem;
}
.bar-demo-filter::placeholder {
  color: var(--muted, #8b9cb3);
}
.bar-demo-select {
  min-width: 6.5rem;
  max-width: 12rem;
  padding: 0.12rem 0.35rem;
  border-radius: 6px;
  border: 1px solid var(--border, #2d3a4d);
  background: var(--surface, #1a2332);
  color: var(--text, #e8eef7);
  font-size: 0.78rem;
}
.bar-attacked-lbl {
  font-weight: 700;
  color: var(--text, #e8eef7);
  margin-right: 0.15rem;
}
.bar-chk {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  cursor: pointer;
  user-select: none;
  color: var(--text, #e8eef7);
}
.bar-chk input {
  width: 0.95rem;
  height: 0.95rem;
  accent-color: var(--primary, #5b9cff);
  cursor: pointer;
}
.btn {
  padding: 0.25rem 0.65rem;
  border-radius: 8px;
  border: 1px solid var(--border, #2d3a4d);
  background: var(--surface, #1a2332);
  color: var(--text, #e8eef7);
  cursor: pointer;
  font-size: 0.8rem;
}
.err {
  color: var(--danger, #ff6b6b);
  font-size: 0.8rem;
  margin: 0 0 0.35rem;
}

.board {
  position: relative;
  width: 100%;
}
.orbit-board {
  position: relative;
  width: min(100%, var(--orbit-side, 28rem));
  aspect-ratio: 1;
  margin-inline: auto;
  overflow: visible;
}
.orbit-sectors {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  border-radius: 50%;
}
.orbit-sector {
  position: absolute;
  inset: 0;
  opacity: var(--orbit-sector-opacity, 0.5);
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
.orbit-hub {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 2;
  translate: -50% -50%;
  pointer-events: none;
}
.orbit-slot {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  z-index: 3;
  overflow: visible;
  pointer-events: none;
}
.orbit-slot-pin {
  pointer-events: auto;
  width: fit-content;
  min-width: var(--orbit-avatar-size, 36px);
  max-width: none;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  /* 槽几何中心即头像中心（orbit-stack 对称 padding） */
  transform: translate(-50%, -50%) rotate(var(--orbit-a)) translateY(calc(-1 * var(--orbit-r)))
    rotate(calc(-1 * var(--orbit-a)));
  transform-origin: 50% 50%;
}
/* 进攻飞入中心：传送门 — 内凹通道 + 外环能量旋涡 + 外发光 */
.attack-hub-bh {
  width: min(100%, 5.25rem);
  min-width: 3.5rem;
  min-height: 3.5rem;
  aspect-ratio: 1;
  max-width: 5.25rem;
  max-height: 5.25rem;
  border-radius: 50%;
  position: relative;
  border: none;
  outline: none;
  background: transparent;
  box-sizing: border-box;
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
/* 水流感：底层高光带缓慢漂移，叠在面上方、线下方由 z-index 控制 */
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
  display: block;
  z-index: 1;
  overflow: visible;
}
/* 面：高透明 + 径向渐隐 */
.attack-hub-taiji-fill {
  -webkit-mask-image: radial-gradient(
    circle at 50% 50%,
    rgba(0, 0, 0, 0.9) 0%,
    rgba(0, 0, 0, 0.45) 44%,
    rgba(0, 0, 0, 0.12) 68%,
    rgba(0, 0, 0, 0) 100%
  );
  mask-image: radial-gradient(
    circle at 50% 50%,
    rgba(0, 0, 0, 0.9) 0%,
    rgba(0, 0, 0, 0.45) 44%,
    rgba(0, 0, 0, 0.12) 68%,
    rgba(0, 0, 0, 0) 100%
  );
  mask-mode: alpha;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
  -webkit-mask-size: 100% 100%;
  mask-size: 100% 100%;
}
/* 队员侧：底色实；其他侧：面 40% 透明度 */
.attack-hub-taiji-fill path.attack-hub-taiji-fill--member {
  fill-opacity: 1;
}
.attack-hub-taiji-fill path.attack-hub-taiji-fill--other {
  fill-opacity: 0.4;
}
/* 分界线：队员侧清晰；其他侧与面一致 */
.attack-hub-taiji-edge path {
  paint-order: stroke fill;
}
.attack-hub-taiji-edge path.attack-hub-taiji-edge--member {
  stroke-opacity: 0.88;
}
.attack-hub-taiji-edge path.attack-hub-taiji-edge--other {
  stroke-opacity: calc(0.88 * 0.4);
}
/* 鱼眼：与对应侧透明度一致，略提亮以便辨认 */
.attack-hub-taiji-dots circle {
  filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.35));
}
.attack-hub-taiji-dots circle.attack-hub-taiji-dots--member {
  fill-opacity: 0.92;
}
.attack-hub-taiji-dots circle.attack-hub-taiji-dots--other {
  fill-opacity: calc(0.92 * 0.4);
}
/* 旋涡能量外环 */
.attack-hub-bh::after {
  content: "";
  position: absolute;
  inset: -6%;
  border-radius: 50%;
  z-index: 1;
  pointer-events: none;
  background: conic-gradient(
    from 0deg,
    color-mix(in srgb, var(--attack-hub-swirl-tr, #22c55e) 52%, transparent),
    transparent 55deg,
    color-mix(in srgb, var(--attack-hub-swirl-br, #ec4899) 50%, transparent) 110deg,
    transparent 165deg,
    color-mix(in srgb, var(--attack-hub-swirl-bl, #3b82f6) 48%, transparent) 220deg,
    transparent 275deg,
    color-mix(in srgb, var(--attack-hub-swirl-tl, #a855f7) 48%, transparent) 320deg,
    transparent
  );
  -webkit-mask-image: radial-gradient(
    circle,
    transparent 0,
    transparent 56%,
    #000 60%,
    #000 88%,
    transparent 100%
  );
  mask-image: radial-gradient(
    circle,
    transparent 0,
    transparent 56%,
    #000 60%,
    #000 88%,
    transparent 100%
  );
  animation: attack-hub-portal-swirl 5s linear infinite;
  will-change: transform;
}
/* 门内「通道」：半透明叠层 + 上亮下暗，透出下层旋涡，略呈凹面 */
.attack-hub-bh::before {
  content: "";
  position: absolute;
  inset: 10%;
  border-radius: 50%;
  z-index: 3;
  pointer-events: none;
  opacity: 0.55;
  background:
    radial-gradient(
      ellipse 115% 90% at 42% 34%,
      rgba(255, 255, 255, 0.12) 0%,
      rgba(255, 255, 255, 0.03) 28%,
      transparent 52%
    ),
    radial-gradient(
      circle at 50% 52%,
      rgba(0, 4, 14, 0.22) 0%,
      rgba(6, 12, 32, 0.12) 45%,
      transparent 72%
    );
  box-shadow:
    inset 0 16px 28px rgba(140, 190, 255, 0.09),
    inset 0 -22px 36px rgba(0, 0, 0, 0.38),
    inset 0 0 48px rgba(0, 0, 0, 0.18),
    inset 0 0 0 1px rgba(255, 255, 255, 0.05),
    0 0 16px color-mix(in srgb, var(--primary, #5b9cff) 20%, transparent);
  animation: attack-hub-portal-pulse 2.6s ease-in-out infinite;
}
@keyframes attack-hub-portal-swirl {
  to {
    transform: rotate(360deg);
  }
}
@keyframes attack-hub-portal-pulse {
  0%,
  100% {
    opacity: 0.62;
    filter: brightness(1);
  }
  50% {
    opacity: 0.78;
    filter: brightness(1.08);
  }
}
@media (prefers-reduced-motion: reduce) {
  .attack-hub-taiji-wrap {
    animation: none;
  }
  .attack-hub-taiji-water {
    animation: none;
  }
  .attack-hub-bh::after {
    animation: none;
  }
  .attack-hub-bh::before {
    animation: none;
  }
}
</style>

<style>
/* Teleport 到 body，非 scoped */
.fly-avatar-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 9999;
}
.fly-avatar-layer .fly-mover {
  position: absolute;
  left: 0;
  top: 0;
  will-change: transform;
}
.fly-avatar-layer .fly-mover-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
}
.fly-avatar-layer .fly-mover-pin {
  border-radius: 50%;
  overflow: hidden;
  box-shadow: 0 3px 14px color-mix(in srgb, var(--bg, #0f1419) 60%, transparent);
  border: 1.5px solid color-mix(in srgb, var(--border, #2d3a4d) 80%, var(--text, #e8eef7) 20%);
  flex-shrink: 0;
}
.fly-avatar-layer .fly-mover-name {
  font-size: 11px;
  font-weight: 800;
  line-height: 1.25;
  color: var(--text, #e8eef7);
  background: color-mix(in srgb, var(--surface, #1a2332) 36%, transparent);
  border: 1px solid color-mix(in srgb, var(--border, #2d3a4d) 42%, transparent);
  border-radius: 8px;
  padding: 3px 8px;
  box-shadow: 0 2px 10px color-mix(in srgb, var(--bg, #0f1419) 28%, transparent);
  text-align: center;
  max-width: 96px;
  min-width: 0;
  width: max-content;
  text-shadow: 0 1px 2px color-mix(in srgb, var(--bg, #0f1419) 72%, transparent);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  display: block;
}
.fly-avatar-layer .fly-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
</style>
