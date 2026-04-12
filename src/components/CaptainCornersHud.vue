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
import { normalizeMoneyList, type CaptainMoneyCard } from "../lib/captainTeams";
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

/** 轨道半径：与 .attack-hub-bh 尺寸衔接；队员/其他按环向外扩展 */
const ORBIT_BASE_REM = 5.5;
const ORBIT_STEP_REM = 3.65;
/** 队员/其他环：卡片占位弦长（px，rem 换算按 16px = 1rem） */
const ORBIT_SLOT_CHORD_PX = 118;
/**
 * 队长最内环：n 人均分整圈，相邻两点弦长 chord = 2r·sin(π/n)，故 r = chord / (2·sin(π/n))。
 */
const ORBIT_CAPTAIN_CHORD_PX = 80;
/** 扇形环带：相对轨道半径的内缩 / 外延（rem），与 orbitRadiusRem 中心线配合 */
const ORBIT_SECTOR_BAND_IN_REM = 2.35;
const ORBIT_SECTOR_BAND_OUT_REM = 3.25;
/** 扇形内弧不小于传送门边缘（rem，相对板中心） */
const HUB_SECTOR_INNER_REM = 2.95;

type OrbitPlaced = {
  card: CaptainMoneyCard;
  kind: "captain" | "member" | "other";
  accent?: string;
  angleDeg: number;
  ringIndex: number;
  /** 若设置则覆盖 ORBIT_BASE_REM + ringIndex*STEP（队长环动态半径、外环衔接） */
  orbitRadiusRem?: number;
  /** 同圈总人数与序号，用于无缝拼接扇形 */
  ringSlotCount: number;
  ringSlotIndex: number;
  /** 扇形边界（度）：0°=正上，顺时针；与 clip / 头像角一致 */
  sectorArcDeg: { a0: number; a1: number };
};

/** 队长内环半径（rem）：保证 n 人整圈时相邻弦长不小于 ORBIT_CAPTAIN_CHORD_PX（px） */
function captainRingRem(n: number): number {
  if (n <= 0) return ORBIT_BASE_REM;
  const floor = ORBIT_BASE_REM + 1.85;
  if (n === 1) return floor;
  const rPx =
    ORBIT_CAPTAIN_CHORD_PX / (2 * Math.sin(Math.PI / n));
  return Math.max(floor, rPx / 16);
}

function orbitMaxSlotsForRadiusRem(rRem: number): number {
  const rPx = rRem * 16;
  const k = Math.floor((2 * Math.PI * rPx) / ORBIT_SLOT_CHORD_PX);
  return Math.max(5, Math.min(26, k));
}

/** 队员/其他：第 ringIdx 圈（队长占0，首圈队员为 1）的半径 rem */
function memberRingRem(
  ringIdx: number,
  hasCaptains: boolean,
  captainRadiusRem: number,
): number {
  const first = hasCaptains ? captainRadiusRem + ORBIT_STEP_REM : ORBIT_BASE_REM;
  const depth = hasCaptains ? ringIdx - 1 : ringIdx;
  return first + Math.max(0, depth) * ORBIT_STEP_REM;
}

/** 扇形环带内外弧的半径中点（赤道），与 sectorRadiiPct 几何一致 */
function orbitEquatorRadiusRem(p: OrbitPlaced): number {
  const r =
    p.orbitRadiusRem ?? ORBIT_BASE_REM + p.ringIndex * ORBIT_STEP_REM;
  const innerRem = Math.max(HUB_SECTOR_INNER_REM, r - ORBIT_SECTOR_BAND_IN_REM);
  const outerRem = r + ORBIT_SECTOR_BAND_OUT_REM;
  return (innerRem + outerRem) / 2;
}

function orbitSlotStyle(p: OrbitPlaced): Record<string, string> {
  return {
    "--orbit-a": `${p.angleDeg}deg`,
    "--orbit-r": `${orbitEquatorRadiusRem(p)}rem`,
  };
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

/** 队长阵营 corner → 象限起始角（0°=上，顺时针）：tl=[270,360), tr=[0,90), br=[90,180), bl=[180,270) */
const QUAD_BASE_DEG: Record<"tl" | "tr" | "bl" | "br", number> = {
  tl: 270,
  tr: 0,
  bl: 180,
  br: 90,
};

function sectorRadiiPct(p: OrbitPlaced, sideRem: number): {
  innerPct: number;
  outerPct: number;
} {
  const r = p.orbitRadiusRem ?? ORBIT_BASE_REM;
  const innerRem = Math.max(HUB_SECTOR_INNER_REM, r - ORBIT_SECTOR_BAND_IN_REM);
  const outerRem = r + ORBIT_SECTOR_BAND_OUT_REM;
  const half = sideRem / 2;
  const innerPct = (innerRem / half) * 50;
  const outerPct = (outerRem / half) * 50;
  const inP = Math.max(0.5, Math.min(innerPct, 47));
  const outP = Math.max(inP + 0.85, Math.min(outerPct, 49.85));
  return { innerPct: inP, outerPct: outP };
}

function sectorAccentHex(p: OrbitPlaced): string {
  if (p.kind === "captain" && p.accent) return p.accent;
  if (p.kind === "member") return "#5eb0e8";
  return "#e9b949";
}

function sectorSkinStyle(
  p: OrbitPlaced,
  sideRem: number,
): Record<string, string> {
  const { innerPct, outerPct } = sectorRadiiPct(p, sideRem);
  const { a0, a1 } = p.sectorArcDeg;
  const clip = sectorClipPathForArc(a0, a1, innerPct, outerPct);
  const a = sectorAccentHex(p);
  return {
    clipPath: clip,
    WebkitClipPath: clip,
    "--sector-accent": a,
  };
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

const visibleCaptains = computed(() =>
  effShowCaptain.value ? allCaptains.value : [],
);

/**
 * 同心环绕传送门：最内环队长按 A/B/C/D 象限各占 90°，分界落在 0°/90°/180°/270°（正上为0° 顺时针），
 * 象限内等分；外圈队员/其他整圈等弧。头像中心在扇形赤道半径上。
 */
const orbitPlacements = computed((): OrbitPlaced[] => {
  const disp = displayBalance.value;
  const bal = (c: CaptainMoneyCard) => disp[balKey(c.id)] ?? 0;
  const rankOf = (c: CaptainMoneyCard) =>
    rosterMap.value.get(String(c.id))?.preliminaryRank ?? 9999;

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
    for (const team of teams.value) {
      const m = team.members.length;
      if (m === 0) continue;
      const base = QUAD_BASE_DEG[team.corner];
      const step = 90 / m;
      for (let k = 0; k < m; k++) {
        const a0 = base + k * step;
        const a1 = base + (k + 1) * step;
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
          sectorArcDeg: { a0: w.a0, a1: w.a1 },
        });
      }
      nextRing = 1;
    }
  }

  let memb = effShowMember.value ? [...bottomTeam.value] : [];
  memb.sort((a, b) => {
    const db = bal(b) - bal(a);
    if (db !== 0) return db;
    return rankOf(a) - rankOf(b);
  });

  let oth = effShowOther.value ? [...otherMembers.value] : [];
  oth.sort((a, b) => {
    const db = bal(b) - bal(a);
    if (db !== 0) return db;
    return a._orderIndex - b._orderIndex;
  });

  const placeInRings = (items: CaptainMoneyCard[], kind: "member" | "other") => {
    const list = [...items];
    let ring = nextRing;
    while (list.length) {
      const rRem = memberRingRem(ring, hasCaptains, captainRadiusRem);
      const cap = orbitMaxSlotsForRadiusRem(rRem);
      const chunk = list.splice(0, cap);
      const n = chunk.length;
      for (let i = 0; i < n; i++) {
        const a0 = (360 * i) / n;
        const a1 = (360 * (i + 1)) / n;
        out.push({
          card: chunk[i]!,
          kind,
          angleDeg: (a0 + a1) / 2,
          ringIndex: ring,
          orbitRadiusRem: rRem,
          ringSlotCount: n,
          ringSlotIndex: i,
          sectorArcDeg: { a0, a1 },
        });
      }
      ring++;
    }
    nextRing = ring;
  };

  placeInRings(memb, "member");
  placeInRings(oth, "other");

  return out;
});

/** 正方形轨道边长（rem），扇形 clip 百分比与圆心一致 */
const orbitBoardSideRem = computed(() => {
  let maxR = 0;
  for (const p of orbitPlacements.value) {
    maxR = Math.max(maxR, p.orbitRadiusRem ?? ORBIT_BASE_REM);
  }
  const maxOuter = maxR + ORBIT_SECTOR_BAND_OUT_REM;
  return Math.max(2 * maxOuter + 5, 20);
});

type QueueItem = {
  targetId: string | number;
  card: string;
  endBalance: number;
};

const queue = ref<QueueItem[]>([]);
let processing = false;

/** 飞入中（较小头像，2.5–5s 随机时长飞到目标）；label 为加减分来源昵称 */
const fly = ref<{
  src: string;
  label: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  size: number;
} | null>(null);

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
const flyMoverRef = ref<HTMLElement | null>(null);
/** 四角 A/B/C/D 阵营围成的2×2 区域，飞入起点为其对称中心（不含上下 strips） */
const cornersFlyHubRef = ref<HTMLElement | null>(null);

const FLY_MS_MIN = 2500;
const FLY_MS_MAX = 5000;
const FLY_SIZE = 28;

function randomFlyMs(): number {
  return FLY_MS_MIN + Math.random() * (FLY_MS_MAX - FLY_MS_MIN);
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
  const tkPre = balKey(target.id);
  /** 目标旁小头像已满时不再飞入，只保留下方扣分飘字 */
  if (parkedCountForTarget(tkPre) >= MAX_PARKED_PER_TARGET) {
    await new Promise<void>((r) => setTimeout(r, 40));
    return;
  }

  const size = FLY_SIZE;
  const flyMs = randomFlyMs();
  const targetId = target.id;
  await nextTick();
  const hub0 = cornersHubStart(size);
  const targetEl0 = anchorEl(targetId);
  const end0 = rectOf(targetEl0, size) ?? hub0;

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

  fly.value = {
    src: srcUrl,
    label: actorLabel,
    x0: hub0.x,
    y0: hub0.y,
    x1: end0.x,
    y1: end0.y,
    size,
  };
  await nextTick();

  const layer = flyMoverRef.value;
  if (!layer) {
    fly.value = null;
    return;
  }
  layer.style.transition = "none";

  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    const t0 = performance.now();
    const step = (now: number) => {
      if (finished) return;
      const elapsed = now - t0;
      const t = Math.min(1, elapsed / flyMs);
      const u = easeFlyProgress(t);
      const startNow = cornersHubStart(size);
      const elNow = anchorEl(targetId);
      const endNow = rectOf(elNow, size) ?? startNow;
      const x = startNow.x + (endNow.x - startNow.x) * u;
      const y = startNow.y + (endNow.y - startNow.y) * u;
      layer.style.transform = `translate(${x}px, ${y}px)`;
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        finish();
      }
    };
    requestAnimationFrame(step);
    window.setTimeout(finish, Math.ceil(flyMs) + 200);
  });
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
  fly.value = null;
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

/** 本地演示「进攻」：飞头像 + 扣分飘字 + 头像红闪（不请求后端）。建议先勾选「暂停轮询」。 */
async function demoAttackHit() {
  const caps = visibleCaptains.value;
  if (caps.length < 2) {
    err.value = "演示需勾选展示「队长」，且至少 2 名队长数据";
    return;
  }
  err.value = "";
  const source = caps[0]!;
  const target = caps.find((c) => balKey(c.id) !== balKey(source.id)) ?? caps[1]!;
  const k = balKey(target.id);
  const have =
    displayBalance.value[k] ?? serverBalance.value[k] ?? 0;
  const delta = -Math.max(1, Math.min(99999, Math.round(Math.abs(have) * 0.08 + 500)));
  processing = true;
  try {
    await playFly(
      {
        name: String(source.name ?? "").trim() || `ID ${source.id}`,
        avatar: source.avatar || undefined,
        captainId: source.id,
      },
      target,
    );
    displayBalance.value = { ...displayBalance.value, [k]: have + delta };
    flashTarget(target.id, delta);
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
        :disabled="loading || visibleCaptains.length < 2 || processing"
        title="先暂停轮询可避免下次刷新把演示余额同步回去"
        @click="demoAttackHit"
      >
        演示进攻效果
      </button>
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
        :style="{ '--orbit-side': orbitBoardSideRem + 'rem' }"
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
          aria-hidden="true"
        />
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
          v-if="fly"
          ref="flyMoverRef"
          class="fly-mover"
        >
          <div
            class="fly-mover-pin"
            :style="{
              width: fly.size + 'px',
              height: fly.size + 'px',
            }"
          >
            <img class="fly-img" :src="fly.src" alt="" referrerpolicy="no-referrer" />
          </div>
          <span class="fly-mover-name">{{ fly.label }}</span>
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
  opacity: 0.5;
  background: linear-gradient(
    168deg,
    color-mix(in srgb, var(--sector-accent) 40%, var(--surface, #1a2332)),
    color-mix(in srgb, var(--sector-accent) 14%, var(--surface, #1a2332))
  );
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sector-accent) 28%, transparent);
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
  min-width: 2.25rem;
  max-width: 4.25rem;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  /* 头像圆心（36px 高的一半）对准轨道赤道锚点，与仅头像时一致 */
  transform: translate(-50%, -50%) rotate(var(--orbit-a)) translateY(calc(-1 * var(--orbit-r)))
    rotate(calc(-1 * var(--orbit-a)));
  transform-origin: 50% 18px;
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
    color-mix(in srgb, var(--primary, #5b9cff) 52%, transparent),
    transparent 55deg,
    rgba(180, 120, 255, 0.38) 110deg,
    transparent 165deg,
    rgba(100, 220, 255, 0.32) 220deg,
    transparent 275deg,
    color-mix(in srgb, var(--primary, #5b9cff) 48%, transparent) 320deg,
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
  z-index: 2;
  pointer-events: none;
  opacity: 0.72;
  background:
    radial-gradient(
      ellipse 115% 90% at 42% 34%,
      rgba(255, 255, 255, 0.11) 0%,
      rgba(200, 230, 255, 0.04) 22%,
      transparent 48%
    ),
    radial-gradient(
      circle at 50% 54%,
      rgba(0, 4, 14, 0.38) 0%,
      rgba(6, 12, 32, 0.26) 34%,
      rgba(20, 45, 95, 0.14) 56%,
      color-mix(in srgb, var(--primary, #5b9cff) 26%, transparent) 72%,
      rgba(180, 215, 255, 0.12) 84%,
      transparent 94%
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
  display: flex;
  flex-direction: column;
  align-items: center;
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
  background: color-mix(in srgb, var(--surface, #1a2332) 93%, var(--bg, #0f1419) 7%);
  border: 1px solid color-mix(in srgb, var(--border, #2d3a4d) 78%, transparent);
  border-radius: 8px;
  padding: 3px 8px;
  box-shadow: 0 2px 12px color-mix(in srgb, var(--bg, #0f1419) 50%, transparent);
  text-align: center;
  max-width: 96px;
  min-width: 0;
  width: max-content;
  max-height: 2.6em;
  text-shadow: 0 1px 2px color-mix(in srgb, var(--bg, #0f1419) 72%, transparent);
  overflow: hidden;
  word-break: break-all;
  display: block;
}
.fly-avatar-layer .fly-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
</style>
