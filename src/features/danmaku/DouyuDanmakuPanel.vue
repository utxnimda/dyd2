<script setup lang="ts">
import { ref, shallowRef, computed, reactive, onMounted, onUnmounted, nextTick, watch } from "vue";
import DmToolbarMenuSelect from "./DmToolbarMenuSelect.vue";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface DanmakuMsg {
  type: string;
  uid: string;
  nn: string;
  txt: string;
  level: string;
  ts: number;
  roomId?: string;
  /** 粉丝牌名 */
  bnn?: string;
  /** 粉丝牌等级 */
  bl?: string;
  brid?: string;
  rid?: string;
  /** 斗鱼原始头像/ic 片段（常为上传路径或大图 URL） */
  ic?: string;
  photo?: string;
}
interface TriggerConfig { id: string; pattern: string; action: string; enabled: boolean; description: string; roomIds?: string[]; }
interface TriggerLogEntry { triggerId: string; pattern: string; action: string; content: string; nickname: string; uid: string; fullText: string; ts: number; source?: string; roomId?: string; }
interface RoomInfo { room_id: number; room_name: string; owner_name: string; owner_uid: string | number; show_status: number; game_name: string; cate_name: string; online_num: number; fans_num: number; room_thumb: string; start_time: number; avatar: string; }
interface GiftMsg { type?: string; uid?: string; nn?: string; gfid?: string; gfn?: string; gfcnt?: string; hits?: string; gs?: string; bg?: string; bnn?: string; bl?: string; brid?: string; level?: string; ic?: string; rid?: string; roomId: string; ts: number; [key: string]: unknown; }
interface BackendRoomStatus { roomId: string; status: string; stats: { total: number; triggered: number; connected_at: number | null }; recording: boolean; recordedCount: number; info?: RoomInfo | null; }



// Song request panel (replaces old cmd stats)
interface SongTimelineEntry { song: string; artist: string; ts: number; uid: string; nn: string; }
interface SongRequester { nn: string; uid: string; ts: number; }
interface SongStatEntry { count: number; requesters: SongRequester[]; }

/* ------------------------------------------------------------------ */
/*  Constants & State                                                 */
/* ------------------------------------------------------------------ */

const API = "/__fmz_danmaku";
const MAX_DANMAKU = 300;

const LS_GIFT_PANEL_OPEN = "fmz_dm_gift_panel_open";
const LS_GIFT_SEARCH_NN = "fmz_dm_gift_search_nickname";
const LS_GIFT_SEARCH_MODE = "fmz_dm_gift_search_mode";
const LS_DM_SEARCH_MODE = "fmz_dm_danmaku_search_mode";
const LS_DM_SEARCH_Q = "fmz_dm_danmaku_search_query";
const LS_GIFT_RATIO = "fmz_dm_gift_panel_ratio";
const LS_GIFT_HEIGHT = "fmz_dm_gift_panel_height_px";
const LS_DM_FEED_POP_RECT = "fmz_dm_feed_pop_float_rect";
const LS_DM_GIFT_POP_RECT = "fmz_dm_gift_pop_float_rect";
const LS_DM_DANMAKU_BAR_VISIBLE = "fmz_dm_danmaku_bar_visible";
const LS_DM_DANMAKU_LAYOUT = "fmz_dm_danmaku_col_layout_v2";
const LS_DM_GIFT_LAYOUT = "fmz_dm_gift_col_layout_v2";
const LS_DM_DANMAKU_FREE_RECT = "fmz_dm_danmaku_free_rect";
const LS_DM_GIFT_FREE_RECT = "fmz_dm_gift_free_rect";

/** 礼物栏已开放（之前仅限开发环境） */
const RELEASE_GIFT_PANEL_DISABLED = false;

/** 弹幕/礼物筛选与布局持久化就绪后再写入 localStorage，避免 hydration 抖动 */
let dmPanelPrefsHydrated = false;

function lsSet(key: string, value: string): void {
  if (!dmPanelPrefsHydrated) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式等 */
  }
}

/** 房间号 SSE/JSON 可能是 string 或 number，统一比较避免「选不中」导致弹幕全被过滤 */
function sameDouyuRoomId(a: string | number | null | undefined, b: string | number | null | undefined): boolean {
  return String(a ?? "") === String(b ?? "");
}


type SubTab = "danmaku" | "triggers" | "log";
const activeSubTab = ref<SubTab>("danmaku");

// Password
const backendUnlocked = ref(!!localStorage.getItem("dm_backend_unlocked"));
const passwordInput = ref("");
const passwordError = ref("");



// Backend capture
const backendRooms = ref<BackendRoomStatus[]>([]);
const backendNewRoomId = ref("");
const backendAutoScroll = ref(true);
const backendSelectedRoom = ref<string | null>(null);
const backendDanmakuList = ref<DanmakuMsg[]>([]);
const backendFeedRef = ref<HTMLElement | null>(null);
const backendError = ref("");

// Shared
const triggers = ref<TriggerConfig[]>([]);
const triggerLog = ref<TriggerLogEntry[]>([]);
let eventSource: EventSource | null = null;

// Gift panel
const showGiftPanel = ref(false);
/** 弹幕分列/列表区域是否显示（独立于弹出态；隐藏时收起内联列与弹幕浮动窗） */
const showDanmakuFeedBar = ref(true);
const giftList = ref<GiftMsg[]>([]);
const giftAutoScroll = ref(true);
const giftFeedRef = ref<HTMLElement | null>(null);
const giftFeedPopRef = ref<HTMLElement | null>(null);
const MAX_GIFT = 300;
// Gift panel ratio: 0 (hidden) to 0.95 (max, never exceeds danmaku width)
const giftPanelRatio = ref(0.33);
const GIFT_RATIO_MAX = 0.95;
const GIFT_RATIO_DRAG_MIN = 0.12;

// Mobile: gift panel height (px) when stacked under danmaku
const giftPanelHeight = ref(200);
const GIFT_HEIGHT_MIN = 80;
const GIFT_HEIGHT_MAX = 500;

/** 礼物 / 弹幕分割条拖拽 */
const dmFeedSplitRef = ref<HTMLElement | null>(null);
const giftSplitterDragging = ref(false);

function clampNum(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function updateGiftRatioFromClientX(clientX: number) {
  const el = dmFeedSplitRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const w = r.width;
  if (w < 48) return;
  const fromLeft = clampNum(clientX - r.left, 0, w);
  const ratio = 1 - fromLeft / w;
  giftPanelRatio.value = +clampNum(ratio, GIFT_RATIO_DRAG_MIN, GIFT_RATIO_MAX).toFixed(3);
}

function onGiftColSplitterPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  giftSplitterDragging.value = true;
  updateGiftRatioFromClientX(e.clientX);
  const onMove = (ev: PointerEvent) => updateGiftRatioFromClientX(ev.clientX);
  const onUp = () => {
    giftSplitterDragging.value = false;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

const isMobile = ref(window.innerWidth <= 600);
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    isMobile.value = window.innerWidth <= 600;
    scheduleEmbedSplitHeightMeasure();
  });
}

/** 单列布局：fixed=嵌入分列卡片；free=视口级悬浮（Teleport 到 body）；popout=独立浏览器窗口挂载（不可用则退回当前页的 fixed Teleport） */
type ColumnLayoutMode = "fixed" | "free" | "popout";

const COLUMN_LAYOUT_OPTS: { value: ColumnLayoutMode; label: string }[] = [
  { value: "fixed", label: "固定" },
  { value: "free", label: "自由" },
  { value: "popout", label: "弹出" },
];

const danmakuColumnMode = ref<ColumnLayoutMode>("fixed");
const giftColumnMode = ref<ColumnLayoutMode>("fixed");

watch(isMobile, (mob) => {
  if (mob) {
    teardownDanmakuPopoutAuxWindow();
    teardownGiftPopoutAuxWindow();
    if (danmakuColumnMode.value === "free" || danmakuColumnMode.value === "popout") danmakuColumnMode.value = "fixed";
    if (giftColumnMode.value === "free" || giftColumnMode.value === "popout") giftColumnMode.value = "fixed";
  }
  nextTick(scheduleEmbedSplitHeightMeasure);
});

const danmakuInFixedSplit = computed(
  () => showDanmakuFeedBar.value && danmakuColumnMode.value === "fixed",
);
const giftInFixedSplit = computed(() => showGiftPanel.value && giftColumnMode.value === "fixed");

const danmakuFreeInBench = computed(
  () => !isMobile.value && showDanmakuFeedBar.value && danmakuColumnMode.value === "free",
);
const giftFreeInBench = computed(
  () => !isMobile.value && showGiftPanel.value && giftColumnMode.value === "free",
);

const benchHasFreeOverlays = computed(() => danmakuFreeInBench.value || giftFreeInBench.value);

/** 桌面：左右分割宽度；移动端：弹幕与礼物纵向堆叠、高度由视口分列统一约束（不设纵向拖拽分割）——仅双栏皆为固定时出现 */
const giftEmbeddedBesideDm = computed(() => danmakuInFixedSplit.value && giftInFixedSplit.value);

const splitHasFixedSlots = computed(
  () =>
    danmakuInFixedSplit.value ||
    giftInFixedSplit.value,
);

/** 仅有礼物固定、弹幕不占分列时礼物拉满宽度 */
const dmFeedSplitGiftOnlyWide = computed(
  () => !danmakuInFixedSplit.value && giftInFixedSplit.value,
);

/** 礼物记录筛选（与弹幕类似：昵称 / 礼物信息 / UID） */
type GiftSearchMode = "nn" | "gift" | "uid";
const giftSearchMode = ref<GiftSearchMode>("nn");
const giftSearchQuery = ref("");

const GIFT_SEARCH_MODE_OPTS = [
  { value: "nn" as const, label: "昵称" },
  { value: "gift" as const, label: "礼物" },
  { value: "uid" as const, label: "UID" },
];

/** 弹幕：搜索方式 */
type DanmakuSearchMode = "nn" | "txt" | "uid";
const danmakuSearchMode = ref<DanmakuSearchMode>("txt");

const DANMAKU_SEARCH_MODE_OPTS = [
  { value: "nn" as const, label: "昵称" },
  { value: "txt" as const, label: "弹幕" },
  { value: "uid" as const, label: "UID" },
];
const danmakuSearchQuery = ref("");
const filteredDanmakuMessages = computed(() => {
  const raw = backendDanmakuList.value;
  const q = danmakuSearchQuery.value.trim();
  if (!q) return raw;
  const mode = danmakuSearchMode.value;
  if (mode === "nn") return raw.filter((m) => (m.nn ?? "").toLowerCase().includes(q.toLowerCase()));
  if (mode === "uid") return raw.filter((m) => String(m.uid ?? "").includes(q.trim()));
  return raw.filter((m) => String(m.txt ?? "").toLowerCase().includes(q.toLowerCase()));
});

const backendFeedPopRef = ref<HTMLElement | null>(null);
/** 画布内自由态弹幕列表挂载点 */
const backendFeedFreeRef = ref<HTMLElement | null>(null);
/** 画布内自由态礼物列表挂载点 */
const giftFeedFreeRef = ref<HTMLElement | null>(null);

/** 单列/自由窗参考高度下限；嵌入式固定分列实际高度主要由视口测量（不受此上限卡住） */
const DANMAKU_PANEL_H_MIN = 296;
const DANMAKU_PANEL_H_MAX = 560;
/** 弹幕栏固定态整块高度（toolbar + 列表 + 底边拖拽条视觉叠层），与并排礼物列同源 */
const dmDanmakuFixedPanelH = ref(368);

function defaultFeedPopRect(): { x: number; y: number; w: number; h: number } {
  if (typeof window === "undefined") return { x: 100, y: 140, w: 420, h: 400 };
  const w = Math.min(520, Math.max(300, Math.floor(window.innerWidth * 0.36)));
  const h = Math.min(480, Math.max(260, Math.floor(window.innerHeight * 0.52)));
  return {
    x: Math.max(48, Math.floor(window.innerWidth * 0.1)),
    y: Math.max(90, Math.floor(window.innerHeight * 0.1)),
    w,
    h,
  };
}

function defaultGiftFloatedShellRect(): { x: number; y: number; w: number; h: number } {
  if (typeof window === "undefined") return { x: 540, y: 160, w: 340, h: 420 };
  const w = Math.min(400, Math.max(268, Math.floor(window.innerWidth * 0.28)));
  const h = Math.min(520, Math.max(240, Math.floor(window.innerHeight * 0.48)));
  return {
    x: Math.min(
      Math.max(48, window.innerWidth - w - 48),
      Math.max(48, Math.floor(window.innerWidth * 0.52)),
    ),
    y: Math.max(88, Math.floor(window.innerHeight * 0.12)),
    w,
    h,
  };
}

/** 自由态：坐标相对浏览器视口（position:fixed） */
function defaultDanmakuFreeViewportRect(): { x: number; y: number; w: number; h: number } {
  if (typeof window === "undefined") {
    return { x: 24, y: 96, w: 480, h: dmDanmakuFixedPanelH.value };
  }
  const pad = 10;
  const w = clampNum(Math.floor(window.innerWidth * 0.4), 280, Math.min(600, window.innerWidth - pad * 2));
  const h = clampNum(dmDanmakuFixedPanelH.value, DANMAKU_PANEL_H_MIN, Math.min(DANMAKU_PANEL_H_MAX, window.innerHeight - pad * 2));
  return {
    x: clampNum(Math.floor(window.innerWidth * 0.04), pad, Math.max(pad, window.innerWidth - w - pad)),
    y: clampNum(Math.floor(window.innerHeight * 0.1), pad, Math.max(pad, window.innerHeight - h - pad)),
    w,
    h,
  };
}

function defaultGiftFreeViewportRect(): { x: number; y: number; w: number; h: number } {
  if (typeof window === "undefined") {
    return { x: 480, y: 96, w: 320, h: 420 };
  }
  const pad = 10;
  const w = clampNum(Math.floor(window.innerWidth * 0.3), 220, Math.min(400, window.innerWidth - pad * 2));
  const h = clampNum(dmDanmakuFixedPanelH.value, 200, Math.min(520, window.innerHeight - pad * 2));
  return {
    x: clampNum(window.innerWidth - w - pad - 24, pad, Math.max(pad, window.innerWidth - w - pad)),
    y: clampNum(Math.floor(window.innerHeight * 0.12), pad, Math.max(pad, window.innerHeight - h - pad)),
    w,
    h,
  };
}

const danmakuFeedPopRect = reactive(defaultFeedPopRect());
const giftFloatedShellRect = reactive(defaultGiftFloatedShellRect());
const danmakuFreeFloatRect = reactive(defaultDanmakuFreeViewportRect());
const giftFreeFloatRect = reactive(defaultGiftFreeViewportRect());

/** 画布根（分列区域）；自由态弹幕/礼物已 Teleport 到 body，仅用分列测量 */
const dmFeedBenchRootRef = ref<HTMLElement | null>(null);
/** 「弹幕流」整块区域上缘 → 视为固定分列可用的垂直起点 */
const dmFeedSectionRootRef = ref<HTMLElement | null>(null);
/** 可见性工具条之下的嵌入区顶端（分列测量起点，不包含「显示弹幕/礼物栏」条） */
const dmEmbeddedMeasureTopRef = ref<HTMLElement | null>(null);
const dmModeContentRef = ref<HTMLElement | null>(null);
/** 固定模式：分列外框高度（弹幕/礼物同高），紧贴视口底部留出边距 */
const dmEmbeddedFixedSplitH = ref(368);

let dmEmbedSplitMeasureRaf: number | null = null;
let dmModeContentResizeObserver: ResizeObserver | null = null;

function refreshDmEmbeddedFixedSplitHeight(): void {
  if (typeof window === "undefined") return;
  if (activeSubTab.value !== "danmaku") return;
  if (!splitHasFixedSlots.value) return;
  const anchor = dmEmbeddedMeasureTopRef.value ?? dmFeedSectionRootRef.value;
  if (!anchor) return;
  const top = anchor.getBoundingClientRect().top;
  const bottomGap = Math.max(10, Math.round(window.innerHeight * 0.015));
  const vv = window.visualViewport;
  const visH = vv ? vv.height : window.innerHeight;
  const viewportBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const raw = viewportBottom - top - bottomGap;
  const minH = isMobile.value ? 160 : 200;
  const maxH = Math.max(minH + 48, Math.floor(visH * 0.9));
  const h = clampNum(Math.floor(raw), minH, maxH);
  dmEmbeddedFixedSplitH.value = h;
  dmDanmakuFixedPanelH.value = clampNum(h, minH, maxH);
}

function scheduleEmbedSplitHeightMeasure(): void {
  if (typeof window === "undefined") return;
  if (dmEmbedSplitMeasureRaf != null) cancelAnimationFrame(dmEmbedSplitMeasureRaf);
  dmEmbedSplitMeasureRaf = requestAnimationFrame(() => {
    dmEmbedSplitMeasureRaf = null;
    refreshDmEmbeddedFixedSplitHeight();
  });
}

const dmFeedSplitBenchStyle = computed(() => {
  const s: Record<string, string> = { height: `${dmEmbeddedFixedSplitH.value}px` };
  if (giftEmbeddedBesideDm.value && !isMobile.value) s["--gift-ratio"] = String(giftPanelRatio.value);
  return s;
});
const danmakuPopoutAuxWin = shallowRef<Window | null>(null);
const danmakuPopoutMountEl = shallowRef<HTMLElement | null>(null);
const giftPopoutAuxWin = shallowRef<Window | null>(null);
const giftPopoutMountEl = shallowRef<HTMLElement | null>(null);

const AUX_POPUP_NAME_DANMAKU = "FMZ_DM_DANMAKU_POPOUT";
const AUX_POPUP_NAME_GIFT = "FMZ_DM_GIFT_POPOUT";

const dmFeedPopDragging = ref(false);
const dmFeedPopResizing = ref(false);
const dmGiftPopDragging = ref(false);
const dmGiftPopResizing = ref(false);
const dmDanmakuFreeDragging = ref(false);
const dmDanmakuFreeResizing = ref(false);
const dmGiftFreeDragging = ref(false);
const dmGiftFreeResizing = ref(false);

const danmakuPopoutTeleportTarget = computed(
  (): HTMLElement | "body" => danmakuPopoutMountEl.value ?? "body",
);
const giftPopoutTeleportTarget = computed(
  (): HTMLElement | "body" => giftPopoutMountEl.value ?? "body",
);

const danmakuFeedPopTeleportDisabled = computed(
  () =>
    isMobile.value ||
    !showDanmakuFeedBar.value ||
    danmakuColumnMode.value !== "popout",
);

const giftPopTeleportDisabled = computed(
  () => isMobile.value || !showGiftPanel.value || giftColumnMode.value !== "popout",
);

function clampFeedPopRect(): void {
  if (typeof window === "undefined") return;
  const m = 10;
  const r = danmakuFeedPopRect;
  const wMin = 280;
  const hMin = 200;
  r.w = clampNum(r.w, wMin, window.innerWidth - m * 2);
  r.h = clampNum(r.h, hMin, window.innerHeight - m * 2);
  r.x = clampNum(r.x, m, window.innerWidth - r.w - m);
  r.y = clampNum(r.y, m, window.innerHeight - r.h - m);
}

function persistFeedPopRectLs(): void {
  clampFeedPopRect();
  lsSet(
    LS_DM_FEED_POP_RECT,
    JSON.stringify({
      x: Math.round(danmakuFeedPopRect.x),
      y: Math.round(danmakuFeedPopRect.y),
      w: Math.round(danmakuFeedPopRect.w),
      h: Math.round(danmakuFeedPopRect.h),
    }),
  );
}

function clampGiftFloatedShellRect(): void {
  if (typeof window === "undefined") return;
  const m = 10;
  const r = giftFloatedShellRect;
  const wMin = 268;
  const hMin = 200;
  r.w = clampNum(r.w, wMin, window.innerWidth - m * 2);
  r.h = clampNum(r.h, hMin, window.innerHeight - m * 2);
  r.x = clampNum(r.x, m, window.innerWidth - r.w - m);
  r.y = clampNum(r.y, m, window.innerHeight - r.h - m);
}

function persistGiftFloatedShellRectLs(): void {
  clampGiftFloatedShellRect();
  lsSet(
    LS_DM_GIFT_POP_RECT,
    JSON.stringify({
      x: Math.round(giftFloatedShellRect.x),
      y: Math.round(giftFloatedShellRect.y),
      w: Math.round(giftFloatedShellRect.w),
      h: Math.round(giftFloatedShellRect.h),
    }),
  );
}

function clampFloatRectToViewport(
  r: { x: number; y: number; w: number; h: number },
  minW = 248,
  minH = 200,
): void {
  if (typeof window === "undefined") return;
  const m = 8;
  const maxW = Math.max(minW + 1, window.innerWidth - m * 2);
  const maxH = Math.max(minH + 1, window.innerHeight - m * 2);
  r.w = clampNum(r.w, minW, maxW);
  r.h = clampNum(r.h, minH, maxH);
  r.x = clampNum(r.x, m, Math.max(m, window.innerWidth - m - r.w));
  r.y = clampNum(r.y, m, Math.max(m, window.innerHeight - m - r.h));
}

function persistDanmakuFreeFloatRectLs(): void {
  clampFloatRectToViewport(danmakuFreeFloatRect);
  lsSet(
    LS_DM_DANMAKU_FREE_RECT,
    JSON.stringify({
      x: Math.round(danmakuFreeFloatRect.x),
      y: Math.round(danmakuFreeFloatRect.y),
      w: Math.round(danmakuFreeFloatRect.w),
      h: Math.round(danmakuFreeFloatRect.h),
    }),
  );
}

function persistGiftFreeFloatRectLs(): void {
  clampFloatRectToViewport(giftFreeFloatRect, 220, 180);
  lsSet(
    LS_DM_GIFT_FREE_RECT,
    JSON.stringify({
      x: Math.round(giftFreeFloatRect.x),
      y: Math.round(giftFreeFloatRect.y),
      w: Math.round(giftFreeFloatRect.w),
      h: Math.round(giftFreeFloatRect.h),
    }),
  );
}

function copyDocumentStylesIntoAuxWindow(aux: Window): void {
  const head = aux.document.head;
  if (!head) return;
  const seen = new Set<string>();
  document.querySelectorAll('link[rel="stylesheet"]').forEach((lnk) => {
    if (!(lnk instanceof HTMLLinkElement)) return;
    const href = lnk.href;
    if (!href || seen.has(`l:${href}`)) return;
    seen.add(`l:${href}`);
    const nl = aux.document.createElement("link");
    nl.rel = "stylesheet";
    nl.href = href;
    if (lnk.media) nl.media = lnk.media;
    head.appendChild(nl);
  });
  document.querySelectorAll("style").forEach((st) => {
    if (!(st instanceof HTMLStyleElement)) return;
    const text = st.textContent ?? "";
    if (!text.trim()) return;
    const key = `s:${text.length}:${text.slice(0, 200)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const ns = aux.document.createElement("style");
    ns.textContent = text;
    head.appendChild(ns);
  });
}

function teardownDanmakuPopoutAuxWindow(): void {
  const w = danmakuPopoutAuxWin.value;
  danmakuPopoutAuxWin.value = null;
  danmakuPopoutMountEl.value = null;
  if (w && !w.closed) {
    try {
      w.close();
    } catch {
      /* */
    }
  }
}

function onDanmakuAuxWindowUnload(): void {
  if (danmakuColumnMode.value !== "popout") return;
  danmakuPopoutAuxWin.value = null;
  danmakuPopoutMountEl.value = null;
  danmakuColumnMode.value = "fixed";
}

function ensureDanmakuPopoutAuxWindow(): boolean {
  const prev = danmakuPopoutAuxWin.value;
  if (prev && !prev.closed) {
    try {
      prev.focus();
    } catch {
      /* */
    }
    const el = prev.document.getElementById("fmz-aux-mount");
    if (el) danmakuPopoutMountEl.value = el;
    return true;
  }
  const r = danmakuFeedPopRect;
  const feat = `popup=yes,width=${Math.round(r.w)},height=${Math.round(r.h)},left=${Math.round(r.x)},top=${Math.round(r.y)}`;
  const w = window.open("", AUX_POPUP_NAME_DANMAKU, feat);
  if (!w) return false;
  danmakuPopoutAuxWin.value = w;
  const doc = w.document;
  doc.open();
  doc.write(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><title>FMZ · 弹幕</title></head><body style="margin:0;background:var(--bg,#0f1115);overflow:hidden;"><div id="fmz-aux-mount" style="box-sizing:border-box;width:100%;height:100vh;min-height:100vh;display:flex;flex-direction:column;"></div></body></html>`,
  );
  doc.close();
  copyDocumentStylesIntoAuxWindow(w);
  const mount = doc.getElementById("fmz-aux-mount");
  if (!mount) {
    teardownDanmakuPopoutAuxWindow();
    return false;
  }
  danmakuPopoutMountEl.value = mount;
  w.addEventListener("beforeunload", onDanmakuAuxWindowUnload, { once: true });
  return true;
}

function teardownGiftPopoutAuxWindow(): void {
  const w = giftPopoutAuxWin.value;
  giftPopoutAuxWin.value = null;
  giftPopoutMountEl.value = null;
  if (w && !w.closed) {
    try {
      w.close();
    } catch {
      /* */
    }
  }
}

function onGiftAuxWindowUnload(): void {
  if (giftColumnMode.value !== "popout") return;
  giftPopoutAuxWin.value = null;
  giftPopoutMountEl.value = null;
  giftColumnMode.value = "fixed";
}

function ensureGiftPopoutAuxWindow(): boolean {
  const prev = giftPopoutAuxWin.value;
  if (prev && !prev.closed) {
    try {
      prev.focus();
    } catch {
      /* */
    }
    const el = prev.document.getElementById("fmz-aux-mount");
    if (el) giftPopoutMountEl.value = el;
    return true;
  }
  const r = giftFloatedShellRect;
  const feat = `popup=yes,width=${Math.round(r.w)},height=${Math.round(r.h)},left=${Math.round(r.x)},top=${Math.round(r.y)}`;
  const w = window.open("", AUX_POPUP_NAME_GIFT, feat);
  if (!w) return false;
  giftPopoutAuxWin.value = w;
  const doc = w.document;
  doc.open();
  doc.write(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><title>FMZ · 礼物</title></head><body style="margin:0;background:var(--bg,#0f1115);overflow:hidden;"><div id="fmz-aux-mount" style="box-sizing:border-box;width:100%;height:100vh;min-height:100vh;display:flex;flex-direction:column;"></div></body></html>`,
  );
  doc.close();
  copyDocumentStylesIntoAuxWindow(w);
  const mount = doc.getElementById("fmz-aux-mount");
  if (!mount) {
    teardownGiftPopoutAuxWindow();
    return false;
  }
  giftPopoutMountEl.value = mount;
  w.addEventListener("beforeunload", onGiftAuxWindowUnload, { once: true });
  return true;
}

let fpDragSession: null | {
  oid: number;
  ox: number;
  oy: number;
  px: number;
  py: number;
  auxWin: Window | null;
};
let fpResizeSession: null | {
  oid: number;
  ow: number;
  oh: number;
  px: number;
  py: number;
  outerW: number;
  outerH: number;
  auxWin: Window | null;
};
let gpDragSession: null | typeof fpDragSession;
let gpResizeSession: null | typeof fpResizeSession;

type BenchDragPick = {
  oid: number;
  grabVX: number;
  grabVY: number;
};
let dfDragPick: BenchDragPick | null = null;
let dfResizePick: null | {
  oid: number;
  ow: number;
  oh: number;
  px: number;
  py: number;
};
let gfDragPick: BenchDragPick | null = null;
let gfResizePick: typeof dfResizePick = null;

function onDanmakuFreeDragPointerDown(e: PointerEvent): void {
  if (danmakuColumnMode.value !== "free" || isMobile.value) return;
  if (dmDanmakuFreeResizing.value) return;
  if (e.button !== 0 || !(e.currentTarget instanceof HTMLElement)) return;
  e.preventDefault();
  dmDanmakuFreeDragging.value = true;
  clampFloatRectToViewport(danmakuFreeFloatRect);
  dfDragPick = {
    oid: e.pointerId,
    grabVX: e.clientX - danmakuFreeFloatRect.x,
    grabVY: e.clientY - danmakuFreeFloatRect.y,
  };
  e.currentTarget.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    if (!dfDragPick || ev.pointerId !== dfDragPick.oid) return;
    danmakuFreeFloatRect.x = ev.clientX - dfDragPick.grabVX;
    danmakuFreeFloatRect.y = ev.clientY - dfDragPick.grabVY;
    clampFloatRectToViewport(danmakuFreeFloatRect);
  };
  const up = (ev: PointerEvent) => {
    if (!dfDragPick || ev.pointerId !== dfDragPick.oid) return;
    dmDanmakuFreeDragging.value = false;
    dfDragPick = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    persistDanmakuFreeFloatRectLs();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function onDanmakuFreeResizePointerDown(e: PointerEvent): void {
  if (danmakuColumnMode.value !== "free" || isMobile.value) return;
  if (dmDanmakuFreeDragging.value) return;
  if (e.button !== 0 || !(e.currentTarget instanceof HTMLElement)) return;
  e.preventDefault();
  e.stopPropagation();
  dmDanmakuFreeResizing.value = true;
  dfResizePick = {
    oid: e.pointerId,
    ow: danmakuFreeFloatRect.w,
    oh: danmakuFreeFloatRect.h,
    px: e.clientX,
    py: e.clientY,
  };
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    if (!dfResizePick || ev.pointerId !== dfResizePick.oid) return;
    danmakuFreeFloatRect.w = dfResizePick.ow + (ev.clientX - dfResizePick.px);
    danmakuFreeFloatRect.h = dfResizePick.oh + (ev.clientY - dfResizePick.py);
    clampFloatRectToViewport(danmakuFreeFloatRect);
  };
  const up = (ev: PointerEvent) => {
    if (!dfResizePick || ev.pointerId !== dfResizePick.oid) return;
    dmDanmakuFreeResizing.value = false;
    dfResizePick = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    persistDanmakuFreeFloatRectLs();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function onGiftFreeDragPointerDown(e: PointerEvent): void {
  if (giftColumnMode.value !== "free" || isMobile.value) return;
  if (dmGiftFreeResizing.value) return;
  if (e.button !== 0 || !(e.currentTarget instanceof HTMLElement)) return;
  e.preventDefault();
  dmGiftFreeDragging.value = true;
  clampFloatRectToViewport(giftFreeFloatRect, 220, 180);
  gfDragPick = {
    oid: e.pointerId,
    grabVX: e.clientX - giftFreeFloatRect.x,
    grabVY: e.clientY - giftFreeFloatRect.y,
  };
  e.currentTarget.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    if (!gfDragPick || ev.pointerId !== gfDragPick.oid) return;
    giftFreeFloatRect.x = ev.clientX - gfDragPick.grabVX;
    giftFreeFloatRect.y = ev.clientY - gfDragPick.grabVY;
    clampFloatRectToViewport(giftFreeFloatRect, 220, 180);
  };
  const up = (ev: PointerEvent) => {
    if (!gfDragPick || ev.pointerId !== gfDragPick.oid) return;
    dmGiftFreeDragging.value = false;
    gfDragPick = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    persistGiftFreeFloatRectLs();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function onGiftFreeResizePointerDown(e: PointerEvent): void {
  if (giftColumnMode.value !== "free" || isMobile.value) return;
  if (dmGiftFreeDragging.value) return;
  if (e.button !== 0 || !(e.currentTarget instanceof HTMLElement)) return;
  e.preventDefault();
  e.stopPropagation();
  dmGiftFreeResizing.value = true;
  gfResizePick = {
    oid: e.pointerId,
    ow: giftFreeFloatRect.w,
    oh: giftFreeFloatRect.h,
    px: e.clientX,
    py: e.clientY,
  };
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    if (!gfResizePick || ev.pointerId !== gfResizePick.oid) return;
    giftFreeFloatRect.w = gfResizePick.ow + (ev.clientX - gfResizePick.px);
    giftFreeFloatRect.h = gfResizePick.oh + (ev.clientY - gfResizePick.py);
    clampFloatRectToViewport(giftFreeFloatRect, 220, 180);
  };
  const up = (ev: PointerEvent) => {
    if (!gfResizePick || ev.pointerId !== gfResizePick.oid) return;
    dmGiftFreeResizing.value = false;
    gfResizePick = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    persistGiftFreeFloatRectLs();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function onDanmakuFeedPopDragPointerDown(e: PointerEvent): void {
  if (danmakuColumnMode.value !== "popout" || isMobile.value) return;
  if (dmFeedPopResizing.value) return;
  if (e.button !== 0 || !(e.currentTarget instanceof HTMLElement)) return;
  e.preventDefault();
  dmFeedPopDragging.value = true;
  fpDragSession = {
    oid: e.pointerId,
    ox: danmakuFeedPopRect.x,
    oy: danmakuFeedPopRect.y,
    px: e.clientX,
    py: e.clientY,
    auxWin: danmakuPopoutAuxWin.value && !danmakuPopoutAuxWin.value.closed ? danmakuPopoutAuxWin.value : null,
  };
  e.currentTarget.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    if (!fpDragSession || ev.pointerId !== fpDragSession.oid) return;
    const s = fpDragSession;
    if (s.auxWin) {
      const dx = ev.clientX - s.px;
      const dy = ev.clientY - s.py;
      try {
        s.auxWin.moveBy(dx, dy);
      } catch {
        /* */
      }
      s.px = ev.clientX;
      s.py = ev.clientY;
      danmakuFeedPopRect.x = s.auxWin.screenX;
      danmakuFeedPopRect.y = s.auxWin.screenY;
      return;
    }
    danmakuFeedPopRect.x = fpDragSession.ox + (ev.clientX - fpDragSession.px);
    danmakuFeedPopRect.y = fpDragSession.oy + (ev.clientY - fpDragSession.py);
    clampFeedPopRect();
  };
  const up = (ev: PointerEvent) => {
    if (!fpDragSession || ev.pointerId !== fpDragSession.oid) return;
    dmFeedPopDragging.value = false;
    fpDragSession = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    persistFeedPopRectLs();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function onDanmakuFeedPopResizePointerDown(e: PointerEvent): void {
  if (danmakuColumnMode.value !== "popout" || isMobile.value) return;
  if (dmFeedPopDragging.value) return;
  if (e.button !== 0 || !(e.currentTarget instanceof HTMLElement)) return;
  e.preventDefault();
  e.stopPropagation();
  dmFeedPopResizing.value = true;
  fpResizeSession = {
    oid: e.pointerId,
    ow: danmakuFeedPopRect.w,
    oh: danmakuFeedPopRect.h,
    px: e.clientX,
    py: e.clientY,
    outerW: danmakuPopoutAuxWin.value && !danmakuPopoutAuxWin.value.closed ? danmakuPopoutAuxWin.value.outerWidth : 0,
    outerH: danmakuPopoutAuxWin.value && !danmakuPopoutAuxWin.value.closed ? danmakuPopoutAuxWin.value.outerHeight : 0,
    auxWin: danmakuPopoutAuxWin.value && !danmakuPopoutAuxWin.value.closed ? danmakuPopoutAuxWin.value : null,
  };
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    if (!fpResizeSession || ev.pointerId !== fpResizeSession.oid) return;
    const s = fpResizeSession;
    if (s.auxWin) {
      const dw = ev.clientX - s.px;
      const dh = ev.clientY - s.py;
      try {
        s.auxWin.resizeTo(Math.max(260, Math.round(s.outerW + dw)), Math.max(200, Math.round(s.outerH + dh)));
      } catch {
        /* */
      }
      danmakuFeedPopRect.w = s.auxWin.innerWidth;
      danmakuFeedPopRect.h = s.auxWin.innerHeight;
      return;
    }
    danmakuFeedPopRect.w = fpResizeSession.ow + (ev.clientX - fpResizeSession.px);
    danmakuFeedPopRect.h = fpResizeSession.oh + (ev.clientY - fpResizeSession.py);
    clampFeedPopRect();
  };
  const up = (ev: PointerEvent) => {
    if (!fpResizeSession || ev.pointerId !== fpResizeSession.oid) return;
    dmFeedPopResizing.value = false;
    fpResizeSession = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    persistFeedPopRectLs();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function onGiftPopShellDragPointerDown(e: PointerEvent): void {
  if (giftColumnMode.value !== "popout" || isMobile.value) return;
  if (dmGiftPopResizing.value) return;
  if (e.button !== 0 || !(e.currentTarget instanceof HTMLElement)) return;
  e.preventDefault();
  dmGiftPopDragging.value = true;
  gpDragSession = {
    oid: e.pointerId,
    ox: giftFloatedShellRect.x,
    oy: giftFloatedShellRect.y,
    px: e.clientX,
    py: e.clientY,
    auxWin: giftPopoutAuxWin.value && !giftPopoutAuxWin.value.closed ? giftPopoutAuxWin.value : null,
  };
  e.currentTarget.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    if (!gpDragSession || ev.pointerId !== gpDragSession.oid) return;
    const s = gpDragSession;
    if (s.auxWin) {
      const dx = ev.clientX - s.px;
      const dy = ev.clientY - s.py;
      try {
        s.auxWin.moveBy(dx, dy);
      } catch {
        /* */
      }
      s.px = ev.clientX;
      s.py = ev.clientY;
      giftFloatedShellRect.x = s.auxWin.screenX;
      giftFloatedShellRect.y = s.auxWin.screenY;
      return;
    }
    giftFloatedShellRect.x = gpDragSession.ox + (ev.clientX - gpDragSession.px);
    giftFloatedShellRect.y = gpDragSession.oy + (ev.clientY - gpDragSession.py);
    clampGiftFloatedShellRect();
  };
  const up = (ev: PointerEvent) => {
    if (!gpDragSession || ev.pointerId !== gpDragSession.oid) return;
    dmGiftPopDragging.value = false;
    gpDragSession = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    persistGiftFloatedShellRectLs();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

function onGiftPopShellResizePointerDown(e: PointerEvent): void {
  if (giftColumnMode.value !== "popout" || isMobile.value) return;
  if (dmGiftPopDragging.value) return;
  if (e.button !== 0 || !(e.currentTarget instanceof HTMLElement)) return;
  e.preventDefault();
  e.stopPropagation();
  dmGiftPopResizing.value = true;
  gpResizeSession = {
    oid: e.pointerId,
    ow: giftFloatedShellRect.w,
    oh: giftFloatedShellRect.h,
    px: e.clientX,
    py: e.clientY,
    outerW: giftPopoutAuxWin.value && !giftPopoutAuxWin.value.closed ? giftPopoutAuxWin.value.outerWidth : 0,
    outerH: giftPopoutAuxWin.value && !giftPopoutAuxWin.value.closed ? giftPopoutAuxWin.value.outerHeight : 0,
    auxWin: giftPopoutAuxWin.value && !giftPopoutAuxWin.value.closed ? giftPopoutAuxWin.value : null,
  };
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    if (!gpResizeSession || ev.pointerId !== gpResizeSession.oid) return;
    const s = gpResizeSession;
    if (s.auxWin) {
      const dw = ev.clientX - s.px;
      const dh = ev.clientY - s.py;
      try {
        s.auxWin.resizeTo(Math.max(240, Math.round(s.outerW + dw)), Math.max(200, Math.round(s.outerH + dh)));
      } catch {
        /* */
      }
      giftFloatedShellRect.w = s.auxWin.innerWidth;
      giftFloatedShellRect.h = s.auxWin.innerHeight;
      return;
    }
    giftFloatedShellRect.w = gpResizeSession.ow + (ev.clientX - gpResizeSession.px);
    giftFloatedShellRect.h = gpResizeSession.oh + (ev.clientY - gpResizeSession.py);
    clampGiftFloatedShellRect();
  };
  const up = (ev: PointerEvent) => {
    if (!gpResizeSession || ev.pointerId !== gpResizeSession.oid) return;
    dmGiftPopResizing.value = false;
    gpResizeSession = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    persistGiftFloatedShellRectLs();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

const danmakuFreeFloatStyle = computed((): Record<string, string> => {
  if (!danmakuFreeInBench.value) return {};
  clampFloatRectToViewport(danmakuFreeFloatRect);
  const r = danmakuFreeFloatRect;
  return {
    position: "fixed",
    left: `${Math.round(r.x)}px`,
    top: `${Math.round(r.y)}px`,
    width: `${Math.round(r.w)}px`,
    height: `${Math.round(r.h)}px`,
    zIndex: "70",
    minWidth: "200px",
  };
});

const giftFreeFloatStyle = computed((): Record<string, string> => {
  if (!giftFreeInBench.value) return {};
  clampFloatRectToViewport(giftFreeFloatRect, 220, 180);
  const r = giftFreeFloatRect;
  return {
    position: "fixed",
    left: `${Math.round(r.x)}px`,
    top: `${Math.round(r.y)}px`,
    width: `${Math.round(r.w)}px`,
    height: `${Math.round(r.h)}px`,
    zIndex: "69",
    minWidth: "200px",
  };
});

const danmakuFeedPopShellStyle = computed((): Record<string, string> => {
  if (isMobile.value || danmakuColumnMode.value !== "popout") return {};
  clampFeedPopRect();
  const aux = danmakuPopoutAuxWin.value;
  if (aux && !aux.closed) {
    return {
      position: "relative",
      flex: "1 1 auto",
      minHeight: "0",
      width: "100%",
      height: "100%",
      boxSizing: "border-box",
    };
  }
  return {
    position: "fixed",
    left: `${Math.round(danmakuFeedPopRect.x)}px`,
    top: `${Math.round(danmakuFeedPopRect.y)}px`,
    width: `${Math.round(danmakuFeedPopRect.w)}px`,
    height: `${Math.round(danmakuFeedPopRect.h)}px`,
    zIndex: "85",
    maxHeight: "calc(100vh - 40px)",
  };
});

const giftFloatedShellStyle = computed((): Record<string, string> => {
  if (isMobile.value || !showGiftPanel.value || giftColumnMode.value !== "popout") return {};
  clampGiftFloatedShellRect();
  const aux = giftPopoutAuxWin.value;
  if (aux && !aux.closed) {
    return {
      position: "relative",
      flex: "1 1 auto",
      minHeight: "0",
      width: "100%",
      height: "100%",
      boxSizing: "border-box",
    };
  }
  return {
    position: "fixed",
    left: `${Math.round(giftFloatedShellRect.x)}px`,
    top: `${Math.round(giftFloatedShellRect.y)}px`,
    width: `${Math.round(giftFloatedShellRect.w)}px`,
    height: `${Math.round(giftFloatedShellRect.h)}px`,
    zIndex: "86",
    maxHeight: "calc(100vh - 40px)",
  };
});

function syncDanmakuFreeHeightFromFixed(): void {
  danmakuFreeFloatRect.h = dmDanmakuFixedPanelH.value;
}

function applyDanmakuColumnMode(mode: ColumnLayoutMode): void {
  if (isMobile.value && (mode === "free" || mode === "popout")) {
    danmakuColumnMode.value = "fixed";
    return;
  }
  const prev = danmakuColumnMode.value;
  if (mode === prev) return;
  if (prev === "popout" && mode !== "popout") teardownDanmakuPopoutAuxWindow();
  if (mode === "popout") {
    if (prev !== "popout") {
      Object.assign(danmakuFeedPopRect, defaultFeedPopRect());
      clampFeedPopRect();
    }
    if (!ensureDanmakuPopoutAuxWindow()) return;
  } else if (mode === "free") {
    syncDanmakuFreeHeightFromFixed();
    nextTick(() => {
      clampFloatRectToViewport(danmakuFreeFloatRect);
      persistDanmakuFreeFloatRectLs();
    });
  }
  danmakuColumnMode.value = mode;
}

function applyGiftColumnMode(mode: ColumnLayoutMode): void {
  if (RELEASE_GIFT_PANEL_DISABLED) {
    giftColumnMode.value = "fixed";
    teardownGiftPopoutAuxWindow();
    return;
  }
  if (isMobile.value && (mode === "free" || mode === "popout")) {
    giftColumnMode.value = "fixed";
    return;
  }
  const prev = giftColumnMode.value;
  if (mode === prev) return;
  if (prev === "popout" && mode !== "popout") teardownGiftPopoutAuxWindow();
  if (mode === "popout") {
    if (prev !== "popout") {
      Object.assign(giftFloatedShellRect, defaultGiftFloatedShellRect());
      clampGiftFloatedShellRect();
    }
    if (!ensureGiftPopoutAuxWindow()) return;
  } else if (mode === "free") {
    nextTick(() => {
      clampFloatRectToViewport(giftFreeFloatRect, 220, 180);
      persistGiftFreeFloatRectLs();
    });
  }
  giftColumnMode.value = mode;
}

function onDanmakuLayoutMenuPick(v: string): void {
  if (v === "fixed" || v === "free" || v === "popout") applyDanmakuColumnMode(v);
}

function onGiftLayoutMenuPick(v: string): void {
  if (v === "fixed" || v === "free" || v === "popout") applyGiftColumnMode(v);
}


function closeDanmakuFeedPopout(): void {
  if (isMobile.value) return;
  applyDanmakuColumnMode("fixed");
}

/** 收起礼物弹出层 → 固定 */
function closeGiftPanelPopout(): void {
  if (isMobile.value) return;
  applyGiftColumnMode("fixed");
}

function toggleDanmakuBarVisible(): void {
  showDanmakuFeedBar.value = !showDanmakuFeedBar.value;
}

function toggleGiftBarVisible(): void {
  if (RELEASE_GIFT_PANEL_DISABLED) return;
  showGiftPanel.value = !showGiftPanel.value;
}

function activeBackendFeedScrollRoot(): HTMLElement | null {
  if (!showDanmakuFeedBar.value) return null;
  if (!isMobile.value && danmakuColumnMode.value === "popout") {
    return backendFeedPopRef.value;
  }
  if (danmakuColumnMode.value === "free") {
    return backendFeedFreeRef.value;
  }
  return backendFeedRef.value;
}

function activeGiftFeedScrollRoot(): HTMLElement | null {
  if (!isMobile.value && showGiftPanel.value && giftColumnMode.value === "popout") {
    return giftFeedPopRef.value ?? null;
  }
  if (giftColumnMode.value === "free") {
    return giftFeedFreeRef.value ?? null;
  }
  return giftFeedRef.value;
}


function dmPanelHydratePrefs(): void {
  try {
    const LEGACY_LS_DM_FEED_POPOUT = "fmz_dm_feed_popout_only";
    const LEGACY_LS_GIFT_POPOUT = "fmz_dm_gift_popout_only";
    const LEGACY_LS_GIFT_DOCK = "fmz_dm_gift_docked_right";

    const gnn = localStorage.getItem(LS_GIFT_SEARCH_NN);
    if (gnn !== null) giftSearchQuery.value = gnn;
    const gsm = localStorage.getItem(LS_GIFT_SEARCH_MODE);
    if (gsm === "nn" || gsm === "gift" || gsm === "uid") giftSearchMode.value = gsm;

    const mode = localStorage.getItem(LS_DM_SEARCH_MODE);
    if (mode === "nn" || mode === "txt" || mode === "uid") danmakuSearchMode.value = mode;

    const dq = localStorage.getItem(LS_DM_SEARCH_Q);
    if (dq !== null) danmakuSearchQuery.value = dq;

    const dmBarVisLs = localStorage.getItem(LS_DM_DANMAKU_BAR_VISIBLE);
    if (dmBarVisLs !== null) showDanmakuFeedBar.value = dmBarVisLs !== "0";

    if (!Number.isNaN(ratioRaw)) giftPanelRatio.value = clampNum(ratioRaw, GIFT_RATIO_DRAG_MIN, GIFT_RATIO_MAX);

    const hRaw = parseInt(String(localStorage.getItem(LS_GIFT_HEIGHT) ?? ""), 10);
    if (!Number.isNaN(hRaw)) giftPanelHeight.value = clampNum(hRaw, GIFT_HEIGHT_MIN, GIFT_HEIGHT_MAX);

    const wantOpen = localStorage.getItem(LS_GIFT_PANEL_OPEN) === "1";

    try {
      const fpRaw = localStorage.getItem(LS_DM_FEED_POP_RECT);
      if (fpRaw) {
        const o = JSON.parse(fpRaw) as Record<string, unknown>;
        const x = Number(o.x),
          y = Number(o.y),
          w = Number(o.w),
          h = Number(o.h);
        if ([x, y, w, h].every((n) => !Number.isNaN(n))) {
          danmakuFeedPopRect.x = x;
          danmakuFeedPopRect.y = y;
          danmakuFeedPopRect.w = w;
          danmakuFeedPopRect.h = h;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const gpr = localStorage.getItem(LS_DM_GIFT_POP_RECT);
      if (gpr) {
        const o = JSON.parse(gpr) as Record<string, unknown>;
        const x = Number(o.x),
          y = Number(o.y),
          w = Number(o.w),
          h = Number(o.h);
        if ([x, y, w, h].every((n) => !Number.isNaN(n))) {
          giftFloatedShellRect.x = x;
          giftFloatedShellRect.y = y;
          giftFloatedShellRect.w = w;
          giftFloatedShellRect.h = h;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const dmf = localStorage.getItem(LS_DM_DANMAKU_FREE_RECT);
      if (dmf) {
        const o = JSON.parse(dmf) as Record<string, unknown>;
        const x = Number(o.x),
          y = Number(o.y),
          w = Number(o.w),
          h = Number(o.h);
        if ([x, y, w, h].every((n) => !Number.isNaN(n))) {
          danmakuFreeFloatRect.x = x;
          danmakuFreeFloatRect.y = y;
          danmakuFreeFloatRect.w = w;
          danmakuFreeFloatRect.h = h;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const gf = localStorage.getItem(LS_DM_GIFT_FREE_RECT);
      if (gf) {
        const o = JSON.parse(gf) as Record<string, unknown>;
        const x = Number(o.x),
          y = Number(o.y),
          w = Number(o.w),
          h = Number(o.h);
        if ([x, y, w, h].every((n) => !Number.isNaN(n))) {
          giftFreeFloatRect.x = x;
          giftFreeFloatRect.y = y;
          giftFreeFloatRect.w = w;
          giftFreeFloatRect.h = h;
        }
      }
    } catch {
      /* ignore */
    }

    danmakuColumnMode.value = "fixed";
    giftColumnMode.value = "fixed";

    const dmLay = localStorage.getItem(LS_DM_DANMAKU_LAYOUT);
    if (!isMobile.value) {
      if (dmLay === "fixed" || dmLay === "free" || dmLay === "popout") danmakuColumnMode.value = dmLay;
      else if (localStorage.getItem(LEGACY_LS_DM_FEED_POPOUT) === "1" && showDanmakuFeedBar.value)
        danmakuColumnMode.value = "popout";
    }

    if (!showDanmakuFeedBar.value) danmakuColumnMode.value = "fixed";

    if (RELEASE_GIFT_PANEL_DISABLED) {
      giftColumnMode.value = "fixed";
      showGiftPanel.value = false;
    } else if (!isMobile.value) {
      const gifLay = localStorage.getItem(LS_DM_GIFT_LAYOUT);
      if (gifLay === "fixed" || gifLay === "free" || gifLay === "popout") giftColumnMode.value = gifLay;
      else if (localStorage.getItem(LEGACY_LS_GIFT_POPOUT) === "1") {
        giftColumnMode.value = "popout";
        showGiftPanel.value = true;
      } else if (localStorage.getItem(LEGACY_LS_GIFT_DOCK) === "1") {
        giftColumnMode.value = "free";
        showGiftPanel.value = true;
      } else if (wantOpen) showGiftPanel.value = true;
    } else if (wantOpen) {
      showGiftPanel.value = true;
    }

    syncDanmakuFreeHeightFromFixed();
  } catch {
    /* ignore */
  }
  dmPanelPrefsHydrated = true;
}

watch(showGiftPanel, (open) => {
  if (RELEASE_GIFT_PANEL_DISABLED) return;
  lsSet(LS_GIFT_PANEL_OPEN, open ? "1" : "0");
  if (!open) {
    teardownGiftPopoutAuxWindow();
    giftColumnMode.value = "fixed";
  }
});

watch(showDanmakuFeedBar, (open) => {
  lsSet(LS_DM_DANMAKU_BAR_VISIBLE, open ? "1" : "0");
  if (!open) {
    teardownDanmakuPopoutAuxWindow();
    danmakuColumnMode.value = "fixed";
  }
});

watch([splitHasFixedSlots, activeSubTab], () => {
  scheduleEmbedSplitHeightMeasure();
});

watch(backendUnlocked, () => {
  scheduleEmbedSplitHeightMeasure();
});

watch(giftSearchQuery, (v) => { lsSet(LS_GIFT_SEARCH_NN, v); });
watch(giftSearchMode, (v) => { lsSet(LS_GIFT_SEARCH_MODE, v); });
watch(danmakuSearchMode, (v) => { lsSet(LS_DM_SEARCH_MODE, v); });
watch(danmakuSearchQuery, (v) => { lsSet(LS_DM_SEARCH_Q, v); });
watch(giftPanelRatio, (v) => { lsSet(LS_GIFT_RATIO, String(+v.toFixed(3))); });
watch(giftPanelHeight, (v) => { lsSet(LS_GIFT_HEIGHT, String(Math.round(v))); });

watch(danmakuColumnMode, (m) => {
  lsSet(LS_DM_DANMAKU_LAYOUT, m);
  persistFeedPopRectLs();
  persistDanmakuFreeFloatRectLs();
  nextTick(scheduleEmbedSplitHeightMeasure);
});

watch(giftColumnMode, (m) => {
  lsSet(LS_DM_GIFT_LAYOUT, m);
  persistGiftFloatedShellRectLs();
  persistGiftFreeFloatRectLs();
  nextTick(scheduleEmbedSplitHeightMeasure);
});

// Gift info mapping (loaded from Douyu API per room)
/**
 * giftInfo: cost/value 已在服务器端换算为元(cost=price/100, value=contribution/10)。
 * isPaid: 是否有主播收益（v3: priceType=YUCHI → true; prop: pc>=100 → true）。
 * from=2 时背包礼不计入总开销。propRaw：道具表本条快照（debug）。
 */
interface GiftInfo {
  name: string;
  icon: string;
  /** 单次礼物开销(元)，已由服务器换算: price/100 或 pc/100 */
  cost: number;
  /** 单次礼物价值(元)，已由服务器换算: contribution/10 或 devote/10 */
  value: number;
  /** 斗鱼礼单条目 from：2＝背包，缺省或其它值＝直连 */
  from?: number;
  /** 是否有主播收益（v3: priceType=YUCHI; prop: pc>=100） */
  isPaid?: boolean;
  /** v3 API 的 priceType: "YUCHI"(鱼翅/付费) 或 "YUWAN"(鱼丸/免费) */
  priceType?: string;
  raw?: Record<string, unknown> | null;
  /** 命中 webconf prop_gift_config 时的原始条目（服务端附加） */
  propRaw?: Record<string, unknown> | null;
}

/** `/gift-list` 内嵌的背包对照行（仅存本房间 CDN from=2 的 gfid） */
interface GiftPropSparseRow {
  name: string;
  pc: number;
  devote: number;
  type: number | null;
  icon: string;
  overlaidFromProp: boolean;
  raw?: Record<string, unknown> | null;
}

function giftInfoFromNorm(info?: GiftInfo | null): number {
  return info?.from === 2 ? 2 : 1;
}

const giftInfoMap = ref<Record<string, GiftInfo>>({});
const giftInfoLoading = ref(false);
const giftBackpackCatalogMap = ref<Record<string, GiftPropSparseRow>>({});
const giftBackpackCatalogStats = ref({
  totalPropKeys: 0,
  roomBackpackGiftIds: 0,
  overlaidFromPropCount: 0,
  propConfigOk: false,
});

// Fallback when API (/gift-list) 尚未就绪或离线；应与 server douyu-danmaku-server GIFT_FALLBACK 语义一致（勿写与斗鱼 CDN 相冲的占位名）
const GIFT_NAMES_FALLBACK: Record<string, string> = {
  "1": "鱼丸",
  "2": "鱼翅",
  "268": "赞",
  "519": "盛典飞机",
  "520": "盛典火箭",
  "824": "火箭",
  "380": "超级火箭",
  "750": "办卡",
  "195": "飞机",
  "196": "跑车",
  "4": "鱼雷",
  "6": "飞吻",
  "3": "弱鸡",
  "714": "怦然心动",
  "713": "告白",
};
function giftName(gfid: string): string {
  const info = giftInfoMap.value[gfid];
  if (info) return info.name;
  return GIFT_NAMES_FALLBACK[gfid] || `#${gfid}`;
}

/** 会话内展示用礼物名：优先斗鱼下行 gfn，否则用语义 giftName(gfid）（礼单/兜底） */
function giftRowDisplayName(g: GiftMsg): string {
  const raw = String(g.gfn ?? "").trim();
  if (raw !== "") return raw;
  return giftName(String(g.gfid ?? ""));
}

/** 礼物记录行：紧挨名称的小号 #gfid */
function giftRecordGfidLabel(g: GiftMsg): string {
  const id = String(g.gfid ?? "").trim();
  return id === "" ? "" : `#${id}`;
}

const giftFilteredList = computed(() => {
  const raw = giftList.value;
  const q = giftSearchQuery.value.trim();
  if (!q) return raw;
  const mode = giftSearchMode.value;
  if (mode === "nn") return raw.filter((g) => (g.nn ?? "").toLowerCase().includes(q.toLowerCase()));
  if (mode === "uid") return raw.filter((g) => String(g.uid ?? "").includes(q.trim()));
  const ql = q.toLowerCase();
  const qt = q.trim();
  return raw.filter((g) => {
    const gid = String(g.gfid ?? "");
    const dn = giftRowDisplayName(g).toLowerCase();
    const gfcntTxt = String(g.gfcnt ?? "");
    const blob = [g.gs, g.hits, g.type].map((x) => String(x ?? "")).join(" ").toLowerCase();
    return dn.includes(ql) || gid.includes(qt) || gfcntTxt.includes(qt) || blob.includes(ql);
  });
});

/** 最近在礼物队列里见过的 gfid→gfn（同名 id 取较新一条），统计「按礼物」行标题优先用之 */
const giftGfnLatestByGfid = computed(() => {
  const out: Record<string, string> = {};
  const list = giftList.value;
  for (let i = list.length - 1; i >= 0; i--) {
    const g = list[i];
    const id = String(g.gfid ?? "").trim();
    const n = String(g.gfn ?? "").trim();
    if (!id || id === "0" || !n) continue;
    if (out[id] === undefined) out[id] = n;
  }
  return out;
});

function giftStatsRowName(gfid: string): string {
  const id = String(gfid ?? "").trim();
  const hint = giftGfnLatestByGfid.value[id];
  if (hint) return hint;
  return giftName(id);
}

/** 与 server `giftPiecesFromStoredRecord` 一致：仅 gfcnt（当次个数），不乘 hits/gs */
function giftPiecesAggregateCount(g: GiftMsg): number {
  const n = Number(g.gfcnt);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

const giftDebugRows = computed(() => [...giftFilteredList.value].reverse());

/** 调试：giftInfoMap 全表明细；与 GET /gift-list 同源 */
const giftCatalogLookupRows = computed(() => {
  return Object.entries(giftInfoMap.value)
    .map(([gfid, info]) => ({
      gfid,
      from: giftInfoFromNorm(info),
      fromLabel: giftInfoFromNorm(info) === 2 ? "2·背包" : "1·直接",
      isPaid: info.isPaid ?? false,
      paidLabel: info.isPaid ? "💰有收益" : "🆓无收益",
      name: info.name?.trim() || "—",
      cost: info.cost ?? 0,
      value: info.value ?? 0,
      icon: info.icon?.trim() || "",
    }))
    .sort((a, b) => String(a.gfid).localeCompare(String(b.gfid), undefined, { numeric: true }));
});

/** debug：prop_gift_config 稀疏对照（仅存本房间 from=2 的 gfid） */
const giftPropCatalogRows = computed(() => {
  return Object.entries(giftBackpackCatalogMap.value)
    .map(([gfid, row]) => ({ gfid, ...row }))
    .sort((a, b) => String(a.gfid).localeCompare(String(b.gfid), undefined, { numeric: true }));
});

const giftPropCatalogEmptyTip = computed(() => {
  if (giftPropCatalogRows.value.length > 0) return "";
  if (!giftBackpackCatalogStats.value.propConfigOk) {
    return "未取得斗鱼 prop_gift_config（网络不可用或仍为首次加载）。请检查出站网络后刷新礼单／切换房间。";
  }
  return "当前房间 CDN gift/v3 礼单里没有 from=2（背包类目）条目。";
});

/** 当前房间斗鱼礼单条目（gfid）：与 giftInfoMap / 服务端 fetch 同源 — 详见列头悬停提示 */
/** isPaid: 是否有主播收益（v3: priceType=YUCHI; prop: pc>=100）。from: 1=直连, 2=背包。 */
const GIFT_FROM_HINT =
  "礼物收益分类：💰isPaid=true 表示主播有实际收益（v3 API: priceType=YUCHI; prop: pc≥100）；🆓isPaid=false 表示无收益（免费礼物/鱼丸等）。from: 1=直连礼物, 2=背包/旧版礼物。cost/value 已在服务器端换算为元。";

const GIFT_STATS_TOTAL_COST_HINT =
  "实际价值仅 Σ(isPaid=true 的礼物 value×件)。无收益礼物(isPaid=false)不包含在内。value=contribution/10，即主播实际收益(元)。";

const GIFT_CATALOG_VALUE_HINT =
  "服务端合并两个数据源：v3 CDN API（新 ID 20000+，priceType 区分收益）+ prop_gift_config（旧 ID，pc≥100 视为有收益）。cost/value 已换算为元。isPaid=true 💰 表示主播有收益。";

const GIFT_PROP_TABLE_HINT =
  "斗鱼 webconf「prop_gift_config」静态 JSON（JSONP）；与站内背包礼配置对齐。表中为 from=2 条目；斗鱼全库键数量见脚注。isPaid 由 pc≥100 启发式判断。";

const GIFT_PROP_OVERLAY_HINT =
  "是否在全站 prop 表中查到该 gfid：**是** 表示用 pc／devote 校准；**否** 表示仅 CDN v3 price／growth 刻度。";

const GIFT_STATS_BY_GIFT_HINT =
  "「值」行仅 isPaid=true 时显示(value×件)；isPaid=false 标「🆓」不写值。value=contribution/10，即主播实际收益(元)。名称优先最晚同 gfid 的 gfn。";

function giftFmtMoneyYuan(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Math.abs(n - Math.round(n)) >= 1e-6 ? n.toFixed(2) : String(Math.round(n));
}

/** 礼单列摘要（礼单价）；显示花费/价值和收益状态 */
function giftCatalogUnitDisplay(gfid: string): string {
  const gid = String(gfid ?? "").trim();
  const inf = giftInfoMap.value[gid];
  if (!inf) return "无礼表";
  const c = inf.cost ?? 0;
  const v = inf.value ?? 0;
  const paid = inf.isPaid ? "💰" : "🆓";

  if (!v) return `${paid}无价`;
  return `${paid}值${giftFmtMoneyYuan(v)}元`;
}

function giftDebugSortKeysDeep(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => giftDebugSortKeysDeep(x));
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = giftDebugSortKeysDeep(o[k]);
  return out;
}

function giftDebugPrettyJson(g: GiftMsg): string {
  try {
    return JSON.stringify(giftDebugSortKeysDeep(g), null, 2);
  } catch {
    return "{}";
  }
}

function giftDebugEscapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 新窗口展示完整 dgb 存档对象（键递归排序、2 空格缩进） */
function openGiftDebugJsonWindow(g: GiftMsg): void {
  const pretty = giftDebugPrettyJson(g);
  const title = `dgb · ts=${String(g.ts)} · gfid=${String(g.gfid ?? "")}`;
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${giftDebugEscapeHtml(title)}</title><style>
body{margin:0;padding:14px 16px 24px;background:#121212;color:#d4d4d4;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace}
h1{margin:0 0 6px;font:600 14px system-ui;color:#f0f0f0}
p{margin:0 0 12px;opacity:.72;font:12px system-ui}
pre{margin:0;white-space:pre-wrap;word-break:break-word}
</style></head><body>
<h1>斗鱼礼物 dgb · 完整 JSON</h1>
<p>键名已递归排序，便于与统计/礼表对照；关闭本页即可。</p>
<pre>${giftDebugEscapeHtml(pretty)}</pre>
</body></html>`;
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank", "noopener,noreferrer,width=840,height=920");
  if (w) {
    w.focus();
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  } else {
    URL.revokeObjectURL(url);
  }
}

function giftCatalogDebugPrettyJson(v: unknown): string {
  try {
    return JSON.stringify(giftDebugSortKeysDeep(v), null, 2);
  } catch {
    return "{}";
  }
}

/** 礼单查找表：CDN 本条原始片段或映射快照（新窗口） */
function openGiftCatalogRawWindow(gfid: string): void {
  const id = String(gfid ?? "").trim();
  const inf = giftInfoMap.value[id];
  if (!inf) return;

  let payload: unknown;
  let lead: string;
  const raw = inf.raw;
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    payload = raw;
    lead = "以下为斗鱼 CDN「gift/v3/web/list」中该 gfid 对应条目的原始 JSON（键已递归排序）；条目含 **from**（1＝直连、2＝背包），并与 cost／value 派生同源。关闭本页即可。";
  } else {
    payload = {
      gfid: id,
      from: giftInfoFromNorm(inf),
      isPaid: inf.isPaid ?? false,
      priceType: inf.priceType || null,
      name: inf.name,
      icon: inf.icon,
      cost: inf.cost,
      value: inf.value,
      propRaw: inf.propRaw ?? null,
      _note: "此为当前 giftInfoMap 可见字段快照。isPaid: 是否有主播收益(v3:priceType=YUCHI / prop:pc≥100)。from：1直连／2背包。",
    };
    lead = "无 CDN 原生片段时的映射快照（键递归排序）；关闭本页即可。";
  }

  const pretty = giftCatalogDebugPrettyJson(payload);
  const title = `礼单条目 · gfid=${id}`;
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${giftDebugEscapeHtml(title)}</title><style>
body{margin:0;padding:14px 16px 24px;background:#121212;color:#d4d4d4;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace}
h1{margin:0 0 6px;font:600 14px system-ui;color:#f0f0f0}
p{margin:0 0 12px;opacity:.72;font:12px system-ui}
pre{margin:0;white-space:pre-wrap;word-break:break-word}
</style></head><body>
<h1>斗鱼礼物礼单 · 原生 / 快照 JSON</h1>
<p>${giftDebugEscapeHtml(lead)}</p>
<pre>${giftDebugEscapeHtml(pretty)}</pre>
</body></html>`;
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank", "noopener,noreferrer,width=840,height=920");
  if (w) {
    w.focus();
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  } else {
    URL.revokeObjectURL(url);
  }
}

/** debug：prop_gift_config 本条 JSON（新窗口） */
function openGiftPropRawWindow(gfid: string): void {
  const id = String(gfid ?? "").trim();
  const row = giftBackpackCatalogMap.value[id];
  let payload: unknown;
  let lead: string;
  const raw = row?.raw;
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    payload = raw;
    lead = "以下为斗鱼 「prop_gift_config」该 gfid 条目的快照（键已递归排序）；与 debug「背包／道具对照」同源。关闭本页即可。";
  } else {
    payload = { gfid: id, ...(row || {}), _note: "无配置文件原生片段时为服务端返回的稀疏对照字段。" };
    lead = "无 prop 本条 raw 时为对照稀疏快照（键递归排序）；关闭本页即可。";
  }
  const pretty = giftCatalogDebugPrettyJson(payload);
  const title = `prop gift · gfid=${id}`;
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${giftDebugEscapeHtml(title)}</title><style>
body{margin:0;padding:14px 16px 24px;background:#121212;color:#d4d4d4;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace}
h1{margin:0 0 6px;font:600 14px system-ui;color:#f0f0f0}
p{margin:0 0 12px;opacity:.72;font:12px system-ui}
pre{margin:0;white-space:pre-wrap;word-break:break-word}
</style></head><body>
<h1>斗鱼 prop_gift_config · JSON</h1>
<p>${giftDebugEscapeHtml(lead)}</p>
<pre>${giftDebugEscapeHtml(pretty)}</pre>
</body></html>`;
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank", "noopener,noreferrer,width=840,height=920");
  if (w) {
    w.focus();
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  } else {
    URL.revokeObjectURL(url);
  }
}

function giftIcon(gfid: string): string {
  return giftInfoMap.value[gfid]?.icon || "";
}
async function loadGiftInfoForRoom(rid: string) {
  giftInfoLoading.value = true;
  try {
    const d = await (await fetch(`${API}/gift-list/${encodeURIComponent(rid)}`)).json();
    if (d.ok && d.gifts) giftInfoMap.value = d.gifts;
    if (d.ok && d.backpackCatalog && typeof d.backpackCatalog === "object") {
      giftBackpackCatalogMap.value = d.backpackCatalog as Record<string, GiftPropSparseRow>;
    } else {
      giftBackpackCatalogMap.value = {};
    }
    if (d.ok && d.backpackCatalogStats && typeof d.backpackCatalogStats === "object") {
      giftBackpackCatalogStats.value = {
        totalPropKeys: Number(d.backpackCatalogStats.totalPropKeys) || 0,
        roomBackpackGiftIds: Number(d.backpackCatalogStats.roomBackpackGiftIds) || 0,
        overlaidFromPropCount: Number(d.backpackCatalogStats.overlaidFromPropCount) || 0,
        propConfigOk: Boolean(d.backpackCatalogStats.propConfigOk),
      };
    } else {
      giftBackpackCatalogStats.value = {
        totalPropKeys: 0,
        roomBackpackGiftIds: 0,
        overlaidFromPropCount: 0,
        propConfigOk: false,
      };
    }
  } catch {
    giftBackpackCatalogMap.value = {};
    giftBackpackCatalogStats.value = {
      totalPropKeys: 0,
      roomBackpackGiftIds: 0,
      overlaidFromPropCount: 0,
      propConfigOk: false,
    };
  }
  giftInfoLoading.value = false;
}

// Badge (fan medal) avatar cache: brid -> avatar URL
const badgeAvatarCache = ref<Record<string, string>>({});
async function loadBadgeAvatar(brid: string) {
  if (!brid || badgeAvatarCache.value[brid] !== undefined) return;
  badgeAvatarCache.value[brid] = ""; // mark as loading
  try {
    const d = await (await fetch(`${API}/badge-avatar/${encodeURIComponent(brid)}`)).json();
    if (d.ok && d.avatar) {
      badgeAvatarCache.value[brid] = d.avatar;
    } else {
      // Fallback: use current room streamer avatar when API fails
      const fallback = streamerAvatarForRoomId(null);
      if (fallback) badgeAvatarCache.value[brid] = fallback;
    }
  } catch {
    // Fallback on network error
    const fallback = streamerAvatarForRoomId(null);
    if (fallback) badgeAvatarCache.value[brid] = fallback;
  }
}
function badgeAvatar(brid: string): string {
  if (!brid) return "";
  if (badgeAvatarCache.value[brid] === undefined) loadBadgeAvatar(brid);
  return badgeAvatarCache.value[brid] || "";
}

/** Open the Douyu live room for the given fan badge room id */
function openBridRoom(brid: string | undefined): void {
  const rid = String(brid ?? "").trim();
  if (!rid) return;
  window.open(`https://www.douyu.com/${rid}`, "_blank");
}

/** Open doseeing fan data page for the given nickname */
function openUserPage(nn: string | undefined): void {
  const name = String(nn ?? "").trim();
  if (!name) return;
  window.open(`https://www.doseeing.com/data/fan/${encodeURIComponent(name)}`, "_blank");
}

/** 解析斗鱼弹幕里的头像/ic 字段；若为 6 位色值则视作等级色而非头像 */
function normalizeDouyuUserAvatarHref(raw: string): string {
  const t = String(raw || "").trim();
  if (!t || /^[a-fA-F0-9]{6}$/.test(t)) return "";
  if (/^https?:\/\//i.test(t)) return t;
  if (t.startsWith("//")) return `https:${t}`;
  const path = t.replace(/^\/+/, "");
  if (/\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(path))
    return path.startsWith("http") ? path : `https://apic.douyucdn.cn/${path}`;
  return `https://apic.douyucdn.cn/upload/${path}`;
}

/** 等级胶囊仅用主播头像；某房间 CDN 失败后该房间本条不再占位 */
const dmStreamerPortraitFailedByRoom = reactive<Record<string, boolean>>({});

/** 当前直播间主播头像（等级胶囊左上角小图） */
function streamerAvatarForRoomId(roomId: string | undefined | null): string {
  let rid = String(roomId ?? "").trim();
  if (!rid) rid = String(backendSelectedRoom.value ?? "");
  const row = backendRooms.value.find((r) => sameDouyuRoomId(r.roomId, rid));
  return normalizeDouyuUserAvatarHref(String(row?.info?.avatar || ""));
}

function streamerAvatarForDanmaku(msg: DanmakuMsg): string {
  return streamerAvatarForRoomId(msg.roomId);
}

function lvlPortraitRoomKey(msg: DanmakuMsg): string {
  return String(msg.roomId ?? "").trim() || String(backendSelectedRoom.value ?? "") || "_";
}

function lvlPortraitSrc(msg: DanmakuMsg): string {
  return streamerAvatarForDanmaku(msg);
}

function lvlPortraitShow(msg: DanmakuMsg): boolean {
  const href = lvlPortraitSrc(msg);
  if (!href) return false;
  return !dmStreamerPortraitFailedByRoom[lvlPortraitRoomKey(msg)];
}

function onLvlPortraitErr(msg: DanmakuMsg): void {
  dmStreamerPortraitFailedByRoom[lvlPortraitRoomKey(msg)] = true;
}

function giftLvlPortraitRoomKey(g: GiftMsg): string {
  return String(g.roomId ?? "").trim() || String(backendSelectedRoom.value ?? "") || "_";
}

function giftLvlPortraitSrc(g: GiftMsg): string {
  return streamerAvatarForRoomId(g.roomId);
}

function giftLvlPortraitShow(g: GiftMsg): boolean {
  const href = giftLvlPortraitSrc(g);
  if (!href) return false;
  return !dmStreamerPortraitFailedByRoom[giftLvlPortraitRoomKey(g)];
}

function onGiftLvlPortraitErr(g: GiftMsg): void {
  dmStreamerPortraitFailedByRoom[giftLvlPortraitRoomKey(g)] = true;
}

function danmakuFanBrid(msg: DanmakuMsg): string {
  const brid = String(msg.brid || "").trim();
  if (brid) return brid;
  // Fallback: use rid (current room) or roomId when brid is missing
  return String(msg.rid || msg.roomId || "").trim();
}

/** 粉丝牌等级色：1–9 灰｜10 青绿｜11–15 蓝｜16–20 紫｜21–23 橙｜24–26 橙红｜27–30 深红｜31–37 玫红｜38 紫粉渐变｜39+ 深蓝紫渐变 */
function fanMedalQualityClass(blStr: string | undefined): string {
  const bl = Math.max(0, parseInt(String(blStr ?? "0"), 10) || 0);
  if (bl <= 9) return "dm-fan-dy0";
  if (bl === 10) return "dm-fan-dy1";
  if (bl <= 15) return "dm-fan-dy2";
  if (bl <= 20) return "dm-fan-dy3";
  if (bl <= 23) return "dm-fan-dy4";
  if (bl <= 26) return "dm-fan-dy5";
  if (bl <= 30) return "dm-fan-dy6";
  if (bl <= 37) return "dm-fan-dy7";
  if (bl === 38) return "dm-fan-dy8";
  return "dm-fan-dy9";
}

/** 斗鱼用户等级 LV 发色分段（与用户提供的对照一致；121+ 炫彩渐变） */
function userLevelQualityClass(levelStr: string): string {
  const lv = Math.max(0, parseInt(String(levelStr), 10) || 0);
  if (lv <= 19) return "dm-ulv-dy0";
  if (lv <= 39) return "dm-ulv-dy1";
  if (lv <= 59) return "dm-ulv-dy2";
  if (lv <= 69) return "dm-ulv-dy3";
  if (lv <= 79) return "dm-ulv-dy4";
  if (lv <= 99) return "dm-ulv-dy5";
  if (lv <= 120) return "dm-ulv-dy6";
  return "dm-ulv-dy7";
}

// Song request panel
const showSongPanel = ref(false);
const songPanelRoomId = ref<string | null>(null);
const songPanelLoading = ref(false);
const songTimeline = ref<SongTimelineEntry[]>([]);
const songSessionStats = ref<Record<string, SongStatEntry>>({});
const songTotalStats = ref<Record<string, SongStatEntry>>({});
const expandedRequesters = ref<string | null>(null); // key of currently expanded row
type SongPanelTab = "timeline" | "session" | "total";
const songPanelTab = ref<SongPanelTab>("timeline");
const songTimelineOrder = ref<"desc" | "asc">("desc"); // desc = newest first



/* ------------------------------------------------------------------ */
/*  Password                                                          */
/* ------------------------------------------------------------------ */

async function unlockBackend() {
  passwordError.value = "";
  try {
    const d = await (await fetch(`${API}/verify-password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: passwordInput.value }) })).json();
    if (d.ok) { backendUnlocked.value = true; localStorage.setItem("dm_backend_unlocked", "1"); localStorage.setItem("dm_backend_pw", passwordInput.value); passwordInput.value = ""; }
    else passwordError.value = "密码错误";
  } catch { passwordError.value = "验证失败"; }
}

function getBackendPw(): string { return localStorage.getItem("dm_backend_pw") || ""; }

/* ------------------------------------------------------------------ */
/*  Room info & recent danmaku                                        */
/* ------------------------------------------------------------------ */

async function fetchRoomInfo(roomId: string): Promise<RoomInfo | null> {
  try { const d = await (await fetch(`${API}/room-info/${encodeURIComponent(roomId)}`)).json(); return d.ok ? d.info : null; } catch { return null; }
}

async function loadRecentDanmaku(roomId: string): Promise<DanmakuMsg[]> {
  try { const d = await (await fetch(`${API}/recent-danmaku/${encodeURIComponent(roomId)}?limit=100`)).json(); return d.ok ? d.messages : []; } catch { return []; }
}

/* ------------------------------------------------------------------ */
/*  Song request panel                                                */
/* ------------------------------------------------------------------ */

async function loadSongData(roomId: string) {
  songPanelLoading.value = true;
  songPanelRoomId.value = roomId;
  expandedRequesters.value = null;
  try {
    const d = await (await fetch(`${API}/song-requests/${encodeURIComponent(roomId)}`)).json();
    if (d.ok) {
      songTimeline.value = d.timeline || [];
      // Normalize stats: support both old format { key: number } and new format { key: { count, requesters } }
      songSessionStats.value = normalizeStats(d.session || {});
      songTotalStats.value = normalizeStats(d.total || {});
      // Enrich requesters from timeline for entries that have empty requesters
      enrichRequestersFromTimeline();
    }
  } catch { /* ignore */ }
  songPanelLoading.value = false;
}

/** Convert old { key: number } format to new { key: { count, requesters } } format */
function normalizeStats(raw: Record<string, any>): Record<string, SongStatEntry> {
  const result: Record<string, SongStatEntry> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === "number") {
      result[key] = { count: val, requesters: [] };
    } else if (val && typeof val === "object") {
      result[key] = { count: val.count || 0, requesters: Array.isArray(val.requesters) ? val.requesters : [] };
    }
  }
  return result;
}

/** Build requesters from timeline data for stats entries that have empty requesters */
function enrichRequestersFromTimeline() {
  const tl = songTimeline.value;
  if (!tl.length) return;
  // Build a map: key -> requester list from timeline
  const tlMap = new Map<string, SongRequester[]>();
  for (const item of tl) {
    const key = item.artist ? `${item.song} ${item.artist}` : item.song;
    if (!tlMap.has(key)) tlMap.set(key, []);
    tlMap.get(key)!.push({ nn: item.nn || "", uid: item.uid || "", ts: item.ts });
  }
  // Enrich session stats
  for (const [key, entry] of Object.entries(songSessionStats.value)) {
    if (entry.requesters.length === 0 && tlMap.has(key)) {
      entry.requesters = tlMap.get(key)!;
    }
  }
  // Enrich total stats
  for (const [key, entry] of Object.entries(songTotalStats.value)) {
    if (entry.requesters.length === 0 && tlMap.has(key)) {
      entry.requesters = tlMap.get(key)!;
    }
  }
}

async function clearSessionStats() {
  if (!songPanelRoomId.value) return;
  try {
    await fetch(`${API}/song-requests/${encodeURIComponent(songPanelRoomId.value)}/clear-session`, { method: "POST" });
    songSessionStats.value = {};
    songTimeline.value = [];
  } catch { /* ignore */ }
}

const sortedTimeline = computed(() => {
  const list = [...songTimeline.value];
  return songTimelineOrder.value === "desc" ? list.reverse() : list;
});

function parseSongKey(key: string): { song: string; artist: string } {
  const idx = key.indexOf(" ");
  return idx > 0 ? { song: key.substring(0, idx), artist: key.substring(idx + 1) } : { song: key, artist: "" };
}

const sortedSessionStats = computed(() => {
  return Object.entries(songSessionStats.value)
    .map(([key, entry]) => ({ key, count: entry.count, requesters: entry.requesters || [], ...parseSongKey(key) }))
    .sort((a, b) => b.count - a.count);
});

const sortedTotalStats = computed(() => {
  return Object.entries(songTotalStats.value)
    .map(([key, entry]) => ({ key, count: entry.count, requesters: entry.requesters || [], ...parseSongKey(key) }))
    .sort((a, b) => b.count - a.count);
});

function toggleRequesters(key: string) {
  expandedRequesters.value = expandedRequesters.value === key ? null : key;
}

function openSongPanel(roomId: string) {
  showSongPanel.value = true;
  loadSongData(roomId);
}

/* ------------------------------------------------------------------ */
/*  Backend capture                                                   */
/* ------------------------------------------------------------------ */

function connectSSE() {
  if (eventSource) { eventSource.close(); eventSource = null; }
  const esUrl = `/__fmz_danmaku/events`;
  const es = new EventSource(esUrl);
  es.addEventListener("rooms", (e) => {
    try {
      const parsed = JSON.parse(e.data) as BackendRoomStatus[];
      const rooms = parsed.map((r) => ({ ...r, roomId: String(r.roomId) }));
      for (const r of rooms) { const ex = backendRooms.value.find((x) => sameDouyuRoomId(x.roomId, r.roomId)); if (ex?.info) r.info = ex.info; }
      backendRooms.value = rooms;
      if (backendSelectedRoom.value && !rooms.some((r) => sameDouyuRoomId(r.roomId, backendSelectedRoom.value))) {
        backendSelectedRoom.value = rooms.length > 0 ? String(rooms[0].roomId) : null;
      }
      if (!backendSelectedRoom.value && rooms.length > 0) {
        void onBackendRoomSelect(String(rooms[0].roomId));
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[danmaku] SSE rooms JSON 解析失败", err);
    }
  });
  es.addEventListener("danmaku", (e) => {
    try {
      const msg: DanmakuMsg = JSON.parse(e.data);
      if (backendSelectedRoom.value && sameDouyuRoomId(msg.roomId, backendSelectedRoom.value)) {
        backendDanmakuList.value.push(msg);
        if (backendDanmakuList.value.length > MAX_DANMAKU) backendDanmakuList.value = backendDanmakuList.value.slice(-MAX_DANMAKU);
        if (backendAutoScroll.value) nextTick(() => scrollEl(activeBackendFeedScrollRoot()));
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[danmaku] SSE danmaku JSON 解析失败", err);
    }
  });
  es.addEventListener("trigger", (e) => {
    try {
      const entry: TriggerLogEntry = JSON.parse(e.data);
      if (backendSelectedRoom.value && sameDouyuRoomId(entry.roomId, backendSelectedRoom.value)) {
        triggerLog.value.unshift(entry);
        if (triggerLog.value.length > 200) triggerLog.value = triggerLog.value.slice(0, 200);
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[danmaku] SSE trigger 解析失败", err);
    }
  });
  es.addEventListener("gift", (e) => {
    try {
      const msg: GiftMsg = JSON.parse(e.data);
      if (backendSelectedRoom.value && sameDouyuRoomId(msg.roomId, backendSelectedRoom.value)) {
        giftList.value.push(msg);
        if (giftList.value.length > MAX_GIFT) giftList.value = giftList.value.slice(-MAX_GIFT);
        if (giftAutoScroll.value) nextTick(() => scrollEl(activeGiftFeedScrollRoot()));
      }
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[danmaku] SSE gift 解析失败", err);
    }
  });
  es.addEventListener("song-request", (e) => {
    try {
      const d = JSON.parse(e.data);
      if (showSongPanel.value && songPanelRoomId.value != null && sameDouyuRoomId(d.roomId, songPanelRoomId.value)) {
        // Update timeline
        songTimeline.value.push({ song: d.song, artist: d.artist, ts: d.ts, uid: "", nn: d.nn || "" });
        // Update session stats
        const key = d.key;
        const requester: SongRequester = { nn: d.nn || "", uid: "", ts: d.ts };
        if (!songSessionStats.value[key]) songSessionStats.value[key] = { count: 0, requesters: [] };
        songSessionStats.value[key].count = d.sessionCount;
        songSessionStats.value[key].requesters.push(requester);
        // Update total stats
        if (!songTotalStats.value[key]) songTotalStats.value[key] = { count: 0, requesters: [] };
        songTotalStats.value[key].count = d.totalCount;
        songTotalStats.value[key].requesters.push(requester);
      }
    } catch { /* */ }
  });
  es.onerror = () => { /* auto-reconnect */ };
  eventSource = es;
}

async function backendAddRoom() {
  const rid = backendNewRoomId.value.trim(); if (!rid) return;
  backendError.value = "";
  try {
    // First verify the room exists on Douyu
    const info = await fetchRoomInfo(rid);
    if (!info) { backendError.value = `直播间 ${rid} 不存在，请检查房间号`; return; }
    const d = await (await fetch(`${API}/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId: rid, password: getBackendPw() }) })).json();
    if (!d.ok) { backendError.value = d.error || "添加失败"; return; }
    backendNewRoomId.value = "";
    if (!backendSelectedRoom.value) backendSelectedRoom.value = rid;
    // Room info already fetched, apply it directly
    const r = backendRooms.value.find((x) => sameDouyuRoomId(x.roomId, rid)); if (r) r.info = info;
  } catch (e: unknown) { backendError.value = e instanceof Error ? e.message : "添加失败"; }
}

async function backendRemoveRoom(rid: string) {
  try { await fetch(`${API}/rooms/${encodeURIComponent(rid)}`, { method: "DELETE", headers: { "X-Password": getBackendPw() } }); } catch { /* */ }
  // Immediately remove from local list and switch selection
  backendRooms.value = backendRooms.value.filter((r) => !sameDouyuRoomId(r.roomId, rid));
  if (backendSelectedRoom.value && sameDouyuRoomId(backendSelectedRoom.value, rid)) {
    const first = backendRooms.value.length > 0 ? backendRooms.value[0].roomId : null;
    backendSelectedRoom.value = first != null ? String(first) : null;
    backendDanmakuList.value = [];
    giftList.value = [];
    if (first) onBackendRoomSelect(first);
  }
}

async function onBackendRoomSelect(rid: string) {
  const ridNorm = String(rid).trim();
  backendSelectedRoom.value = ridNorm;
  backendDanmakuList.value = [];
  triggerLog.value = [];
  giftList.value = [];
  // Load recent 100 danmaku from recording
  const msgs = await loadRecentDanmaku(ridNorm);
  backendDanmakuList.value = msgs;
  nextTick(() => scrollEl(activeBackendFeedScrollRoot()));
  // Reload action log for this room
  loadActionLog();
  // Load gifts for this room
  loadGiftsForRoom(ridNorm);
  // Load gift info (names + icons) from Douyu API
  loadGiftInfoForRoom(ridNorm);
  // Fetch room info if missing
  const r = backendRooms.value.find((x) => sameDouyuRoomId(x.roomId, ridNorm));
  if (r && !r.info) fetchRoomInfo(ridNorm).then(info => { r.info = info; });
}

/* ------------------------------------------------------------------ */
/*  Gift API                                                          */
/* ------------------------------------------------------------------ */

// Gift panel sub-tabs
type GiftSubTab = 'records' | 'stats' | 'debug';
const isDev = import.meta.env.DEV;
const giftSubTab = ref<GiftSubTab>('records');

// Gift stats
type GiftStatsRange = 'today' | 'week' | '7days' | 'month' | '30days';
const GIFT_STATS_RANGES: { label: string; value: GiftStatsRange }[] = [
  { label: '今天', value: 'today' },
  { label: '本周', value: 'week' },
  { label: '近7天', value: '7days' },
  { label: '本月', value: 'month' },
  { label: '近30天', value: '30days' },
];
const giftStatsRange = ref<GiftStatsRange>('today');
interface GiftStatsData {
  totalValue: number;
  totalCount: number;
  byGift: Record<string, { count: number }>;
  byUser: Record<string, { nn: string; level: string; bnn: string; bl: string; brid: string; count: number; gifts: Record<string, number> }>;
}
const giftStats = ref<GiftStatsData | null>(null);
const giftStatsLoading = ref(false);

async function loadGiftStats(rid: string, range: GiftStatsRange) {
  giftStatsLoading.value = true;
  try {
    const d = await (await fetch(`${API}/gifts/${encodeURIComponent(rid)}/stats?range=${range}`)).json();
    if (d.ok) giftStats.value = d.stats;
  } catch { /* */ }
  giftStatsLoading.value = false;
}

// Computed: sorted gift stats by value desc (value = contribution)
const giftStatsByGiftSorted = computed(() => {
  if (!giftStats.value) return [];
  return Object.entries(giftStats.value.byGift)
    .map(([gfid, v]) => {
      const info = giftInfoMap.value[gfid];
      return {
        gfid, count: v.count, name: giftStatsRowName(gfid), icon: giftIcon(gfid),
        cost: (info?.cost || 0), value: (info?.value || 0),
        from: giftInfoFromNorm(info),
        isPaid: info?.isPaid ?? false,
      };
    })
    .sort((a, b) => {
      // isPaid gifts first, then by total revenue desc, then by total cost desc, then by count desc
      if (a.isPaid !== b.isPaid) return a.isPaid ? -1 : 1;
      const revDiff = (b.value * b.count) - (a.value * a.count);
      if (revDiff !== 0) return revDiff;
      const costDiff = (b.cost * b.count) - (a.cost * a.count);
      if (costDiff !== 0) return costDiff;
      return b.count - a.count;
    });
});
const giftStatsByUserSorted = computed(() => {
  if (!giftStats.value) return [];
  // Build a lookup from giftList + danmakuList (live SSE data) for user info fallback
  const liveUserInfo: Record<string, { level: string; bnn: string; bl: string; brid: string }> = {};
  // Collect from danmaku messages first (lower priority)
  for (const m of backendDanmakuList.value) {
    const uid = m.uid || '';
    if (!uid) continue;
    const level = String(m.level || '');
    const bnn = String(m.bnn || '');
    const bl = String(m.bl || '');
    const brid = String(m.brid || '');
    if (level || bnn) liveUserInfo[uid] = { level: level || liveUserInfo[uid]?.level || '', bnn: bnn || liveUserInfo[uid]?.bnn || '', bl: bl || liveUserInfo[uid]?.bl || '', brid: brid || liveUserInfo[uid]?.brid || '' };
  }
  // Collect from gift messages (higher priority, overwrites danmaku)
  for (const g of giftList.value) {
    const uid = g.uid || '';
    if (!uid) continue;
    const level = String(g.level || '');
    const bnn = String(g.bnn || '');
    const bl = String(g.bl || '');
    const brid = String(g.brid || '');
    if (level || bnn) liveUserInfo[uid] = { level: level || liveUserInfo[uid]?.level || '', bnn: bnn || liveUserInfo[uid]?.bnn || '', bl: bl || liveUserInfo[uid]?.bl || '', brid: brid || liveUserInfo[uid]?.brid || '' };
  }
  return Object.entries(giftStats.value.byUser)
    .map(([uid, v]) => {
      // Calculate total revenue (value) and total cost for this user
      let totalValue = 0;
      let totalCost = 0;
      for (const [gfid, cnt] of Object.entries(v.gifts)) {
        const info = giftInfoMap.value[gfid];
        if (info?.isPaid) {
          totalValue += (info.value || 0) * cnt;
          totalCost += (info.cost || 0) * cnt;
        }
      }
      const live = liveUserInfo[uid];
      return {
        uid, nn: v.nn, level: v.level || live?.level || '', bnn: v.bnn || live?.bnn || '', bl: v.bl || live?.bl || '', brid: v.brid || live?.brid || '',
        count: v.count, gifts: v.gifts, totalValue, totalCost,
      };
    })
    .filter(u => u.totalValue > 0 || u.totalCost > 0)
    .sort((a, b) => b.totalValue - a.totalValue || b.totalCost - a.totalCost || b.count - a.count);
});
// 「实际价值」合计(元)：仅 isPaid=true 的礼物 Σ(value×件)，无收益礼物不计入
// value 已在服务器端换算为元（contribution/10），即主播实际收益
const giftStatsTotalCost = computed(() => {
  if (!giftStats.value) return 0;
  let total = 0;
  for (const [gfid, v] of Object.entries(giftStats.value.byGift)) {
    const inf = giftInfoMap.value[gfid];
    if (!inf?.isPaid) continue;
    const value = inf?.value || 0;
    total += value * v.count;
  }
  return total;
});
// 「总花费」合计(元)：仅 isPaid=true 的礼物 Σ(cost×件)
const giftStatsTotalSpend = computed(() => {
  if (!giftStats.value) return 0;
  let total = 0;
  for (const [gfid, v] of Object.entries(giftStats.value.byGift)) {
    const inf = giftInfoMap.value[gfid];
    if (!inf?.isPaid) continue;
    const cost = inf?.cost || 0;
    total += cost * v.count;
  }
  return total;
});

// Watch range change to reload stats
watch(giftStatsRange, (r) => {
  const rid = backendSelectedRoom.value;
  if (rid && giftSubTab.value === 'stats') loadGiftStats(rid, r);
});
watch(giftSubTab, (tab) => {
  const rid = backendSelectedRoom.value;
  if (rid && tab === 'stats') loadGiftStats(rid, giftStatsRange.value);
});

async function loadGiftsForRoom(rid: string) {
  try {
    const d = await (await fetch(`${API}/gifts/${encodeURIComponent(rid)}?limit=200`)).json();
    if (d.ok) { giftList.value = d.gifts; nextTick(() => scrollEl(activeGiftFeedScrollRoot())); }
  } catch { /* */ }
}
async function clearGiftsForRoom() {
  const rid = backendSelectedRoom.value;
  if (!rid) return;
  try { await fetch(`${API}/gifts/${encodeURIComponent(rid)}/clear`, { method: "POST" }); giftList.value = []; } catch { /* */ }
}

/* ------------------------------------------------------------------ */
/*  Shared: Trigger & Log API                                         */
/* ------------------------------------------------------------------ */

async function loadTriggers() { try { const d = await (await fetch(`${API}/triggers`)).json(); if (d.ok) triggers.value = d.triggers; } catch { /* */ } }
async function saveTriggers() { try { await fetch(`${API}/triggers`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ triggers: triggers.value }) }); } catch { /* */ } }
const newTriggerPattern = ref("#");
const newTriggerDesc = ref("");
const newTriggerAction = ref("log");
const ACTION_OPTIONS: { id: string; label: string }[] = [
  { id: "log", label: "展示" },
  { id: "song-request", label: "点歌" },
];
function actionLabel(actionId: string): string {
  return ACTION_OPTIONS.find(a => a.id === actionId)?.label || actionId;
}
const newTriggerRoomIds = ref<string[]>([]);
function roomLabel(rid: string): string { const r = backendRooms.value.find((x) => sameDouyuRoomId(x.roomId, rid)); return r?.info?.owner_name || rid; }
function toggleRoomForTrigger(t: TriggerConfig, rid: string) { if (!t.roomIds) t.roomIds = []; const idx = t.roomIds.indexOf(rid); if (idx >= 0) t.roomIds.splice(idx, 1); else t.roomIds.push(rid); saveTriggers(); }
function toggleNewTriggerRoom(rid: string) { const idx = newTriggerRoomIds.value.indexOf(rid); if (idx >= 0) newTriggerRoomIds.value.splice(idx, 1); else newTriggerRoomIds.value.push(rid); }
async function addTrigger() { const p = newTriggerPattern.value.trim(); if (!p) return; try { const d = await (await fetch(`${API}/triggers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pattern: p, action: newTriggerAction.value, description: newTriggerDesc.value.trim(), enabled: true, roomIds: newTriggerRoomIds.value.length > 0 ? [...newTriggerRoomIds.value] : [] }) })).json(); if (d.ok) { triggers.value.push(d.trigger); newTriggerPattern.value = "#"; newTriggerDesc.value = ""; newTriggerAction.value = "log"; newTriggerRoomIds.value = []; } } catch { /* */ } }
async function deleteTrigger(id: string) { try { await fetch(`${API}/triggers/${encodeURIComponent(id)}`, { method: "DELETE" }); triggers.value = triggers.value.filter(t => t.id !== id); } catch { /* */ } }
async function toggleTrigger(t: TriggerConfig) { t.enabled = !t.enabled; await saveTriggers(); }
async function loadActionLog() { try { const roomParam = backendSelectedRoom.value ? `&roomId=${encodeURIComponent(backendSelectedRoom.value)}` : ''; const d = await (await fetch(`${API}/action-log?limit=100${roomParam}`)).json(); if (d.ok) triggerLog.value = d.log; } catch { /* */ } }
async function clearActionLog() { try { await fetch(`${API}/action-log/clear`, { method: "POST" }); triggerLog.value = []; } catch { /* */ } }

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function formatTime(ts: number): string { return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false }); }
function formatDuration(ms: number): string { const s = Math.floor(ms / 1000); const m = Math.floor(s / 60); const h = Math.floor(m / 60); if (h > 0) return `${h}h${m % 60}m`; if (m > 0) return `${m}m${s % 60}s`; return `${s}s`; }
function formatNum(n: number): string { if (!n) return "0"; if (n >= 10000) return (n / 10000).toFixed(1) + "万"; return String(n); }
function scrollEl(el: HTMLElement | null) { if (el) el.scrollTop = el.scrollHeight; }

const selectedBackendRoom = computed(() => backendRooms.value.find((r) => sameDouyuRoomId(r.roomId, backendSelectedRoom.value)) || null);

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                         */
/* ------------------------------------------------------------------ */

function onDmEscapeCloseFloatingPanels(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  if (showSongPanel.value) return;
  if (activeSubTab.value !== "danmaku") return;
  if (isMobile.value) return;
  if (giftColumnMode.value === "popout" && showGiftPanel.value) {
    e.preventDefault();
    closeGiftPanelPopout();
    return;
  }
  if (danmakuColumnMode.value === "popout" && showDanmakuFeedBar.value) {
    e.preventDefault();
    closeDanmakuFeedPopout();
  }
}

onMounted(() => {
  dmPanelHydratePrefs();
  if (RELEASE_GIFT_PANEL_DISABLED) {
    showGiftPanel.value = false;
    giftColumnMode.value = "fixed";
    teardownGiftPopoutAuxWindow();
  }
  nextTick(() => {
    if (isMobile.value) return;
    if (showDanmakuFeedBar.value && danmakuColumnMode.value === "popout") {
      if (!ensureDanmakuPopoutAuxWindow()) danmakuColumnMode.value = "fixed";
    }
    if (!RELEASE_GIFT_PANEL_DISABLED && showGiftPanel.value && giftColumnMode.value === "popout") {
      if (!ensureGiftPopoutAuxWindow()) giftColumnMode.value = "fixed";
    }
  });
  if (typeof window !== "undefined") {
    window.visualViewport?.addEventListener("resize", scheduleEmbedSplitHeightMeasure);
    window.visualViewport?.addEventListener("scroll", scheduleEmbedSplitHeightMeasure);
  }
  nextTick(() => {
    const root = dmModeContentRef.value;
    if (root && typeof ResizeObserver !== "undefined") {
      dmModeContentResizeObserver = new ResizeObserver(() => scheduleEmbedSplitHeightMeasure());
      dmModeContentResizeObserver.observe(root);
    }
    scheduleEmbedSplitHeightMeasure();
  });
  connectSSE();
  loadTriggers();
  loadActionLog();
  window.addEventListener("keydown", onDmEscapeCloseFloatingPanels);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onDmEscapeCloseFloatingPanels);
  if (typeof window !== "undefined") {
    window.visualViewport?.removeEventListener("resize", scheduleEmbedSplitHeightMeasure);
    window.visualViewport?.removeEventListener("scroll", scheduleEmbedSplitHeightMeasure);
  }
  if (dmModeContentResizeObserver) {
    dmModeContentResizeObserver.disconnect();
    dmModeContentResizeObserver = null;
  }
  if (dmEmbedSplitMeasureRaf != null) {
    cancelAnimationFrame(dmEmbedSplitMeasureRaf);
    dmEmbedSplitMeasureRaf = null;
  }
  teardownDanmakuPopoutAuxWindow();
  teardownGiftPopoutAuxWindow();
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
});

defineExpose({ reload: () => { connectSSE(); loadTriggers(); loadActionLog(); } });

/* ------------------------------------------------------------------ */
/*  UID Tooltip                                                       */
/* ------------------------------------------------------------------ */
const uidTooltip = reactive({ visible: false, text: '', x: 0, y: 0 });
let uidTooltipTimer: ReturnType<typeof setTimeout> | null = null;

function showUidTooltip(e: MouseEvent, uid: string | undefined) {
  if (!uid) return;
  if (uidTooltipTimer) { clearTimeout(uidTooltipTimer); uidTooltipTimer = null; }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  uidTooltip.text = `UID: ${uid}`;
  uidTooltip.x = rect.left + rect.width / 2;
  uidTooltip.y = rect.top - 4;
  uidTooltip.visible = true;
}

function hideUidTooltip() {
  uidTooltipTimer = setTimeout(() => { uidTooltip.visible = false; }, 80);
}
</script>

<template>
  <section class="dm-panel">


    <!-- ==================== Backend capture ==================== -->
    <div ref="dmModeContentRef" class="dm-mode-content">
      <div v-if="!backendUnlocked" class="dm-lock">
        <div class="dm-lock-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
        <p>输入密码解锁后台捕捉</p>
        <div class="dm-lock-row"><input v-model="passwordInput" class="dm-input" type="password" placeholder="密码" @keydown.enter="unlockBackend" /><button class="dm-btn dm-btn--primary" @click="unlockBackend">解锁</button></div>
        <div v-if="passwordError" class="dm-error">{{ passwordError }}</div>
      </div>
      <template v-else>
        <div class="dm-add-row">
          <input v-model="backendNewRoomId" class="dm-input" type="text" placeholder="直播间号" @keydown.enter="backendAddRoom" />
          <button class="dm-btn dm-btn--primary" :disabled="!backendNewRoomId.trim()" @click="backendAddRoom">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
            添加
          </button>
        </div>
        <div v-if="backendError" class="dm-error">{{ backendError }}</div>
        <div v-if="backendRooms.length > 0" class="dm-room-list">
          <div v-for="room in backendRooms" :key="room.roomId" class="dm-room-chip" :class="{ selected: sameDouyuRoomId(backendSelectedRoom, room.roomId) }" @click="onBackendRoomSelect(String(room.roomId))">
            <span class="dm-chip-dot" :class="room.status"></span>
            <span class="dm-chip-name">{{ room.info?.owner_name || room.roomId }}</span>
            <span v-if="room.info?.show_status === 1" class="dm-chip-live">LIVE</span>
            <span class="dm-chip-count">{{ room.stats.total }}</span>
            <button class="dm-chip-close" @click.stop="backendRemoveRoom(room.roomId)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>

        <template v-if="selectedBackendRoom">
          <div v-if="selectedBackendRoom.info" class="dm-room-card">
            <img v-if="selectedBackendRoom.info.avatar" :src="selectedBackendRoom.info.avatar" class="dm-room-avatar" alt="" referrerpolicy="no-referrer" />
            <div class="dm-room-body">
              <div class="dm-room-title">{{ selectedBackendRoom.info.room_name }}</div>
              <div class="dm-room-meta">
                <span>{{ selectedBackendRoom.info.owner_name }}</span>
                <span v-if="selectedBackendRoom.info.game_name" class="dm-meta-tag">{{ selectedBackendRoom.info.game_name }}</span>
                <span v-if="selectedBackendRoom.info.show_status === 1" class="dm-meta-live">● LIVE</span>
                <span v-if="selectedBackendRoom.info.online_num">{{ formatNum(selectedBackendRoom.info.online_num) }} 在线</span>
              </div>
            </div>
<button class="dm-btn dm-btn--outline dm-btn--sm" @click="openSongPanel(selectedBackendRoom.roomId)">🎵 点歌统计</button>
          </div>
          <div class="dm-stats-bar">
            <span>弹幕 <strong>{{ selectedBackendRoom.stats.total }}</strong></span>
            <span>触发 <strong>{{ selectedBackendRoom.stats.triggered }}</strong></span>
            <span v-if="selectedBackendRoom.stats.connected_at">时长 <strong>{{ formatDuration(Date.now() - (selectedBackendRoom.stats.connected_at || 0)) }}</strong></span>
          </div>
        </template>

        <div class="dm-panel-subnav">
        <nav class="dm-tabs">
          <button :class="{ active: activeSubTab === 'danmaku' }" @click="activeSubTab = 'danmaku'">弹幕流</button>
          <button :class="{ active: activeSubTab === 'triggers' }" @click="activeSubTab = 'triggers'">触发器</button>
          <button :class="{ active: activeSubTab === 'log' }" @click="activeSubTab = 'log'">日志 <sup v-if="triggerLog.length" class="dm-badge">{{ triggerLog.length }}</sup></button>
                          </nav>
                        </div>

        <div v-if="activeSubTab === 'danmaku'" ref="dmFeedSectionRootRef" class="dm-feed-section">
          <div class="dm-bench-visibility-strip" role="toolbar" aria-label="固定栏可见性">
            <button
              type="button"
              class="dm-bench-vis-btn"
              :class="{ 'dm-bench-vis-btn--active': showDanmakuFeedBar }"
              :aria-pressed="showDanmakuFeedBar"
              @click.stop="toggleDanmakuBarVisible"
            >
              {{ showDanmakuFeedBar ? '隐藏弹幕栏' : '显示弹幕栏' }}
            </button>
            <button
              v-if="!RELEASE_GIFT_PANEL_DISABLED"
              type="button"
              class="dm-bench-vis-btn"
              :class="{ 'dm-bench-vis-btn--active': showGiftPanel }"
              :aria-pressed="showGiftPanel"
              @click.stop="toggleGiftBarVisible"
            >
              {{ showGiftPanel ? '隐藏礼物栏' : '显示礼物栏' }}
            </button>
          </div>
          <div ref="dmEmbeddedMeasureTopRef" class="dm-feed-embed-slot">
          <div
            v-if="splitHasFixedSlots"
            ref="dmFeedBenchRootRef"
            class="dm-feed-bench-root"
          >
          <div
            v-if="splitHasFixedSlots"
            ref="dmFeedSplitRef"
            class="dm-feed-split"
            :class="{
              'dm-feed-split--open': giftEmbeddedBesideDm,
              'dm-feed-split--mobile': isMobile,
              'dm-feed-split--gift-only-wide': dmFeedSplitGiftOnlyWide,
              'is-dragging': giftSplitterDragging,
            }"
            :style="dmFeedSplitBenchStyle"
          >
            <!-- Left: danmaku feed (固定) -->
            <div v-if="danmakuInFixedSplit" class="dm-feed-left">
              <div class="dm-danmaku-stack dm-danmaku-stack--fixed-h">
                <div class="dm-danmaku-split-head">
                  <div class="dm-danmaku-split-head-toolbar dm-column-head-toolbar">
                    <div class="dm-column-head-toolbar__start dm-column-head-toolbar__start--danmaku">
                      <div class="dm-toolbar-row-first">
                        <div class="dm-toolbar-menu-lead dm-toolbar-menu-lead--danmaku">
                          <label class="dm-check dm-check--toolbar dm-check--toolbar-free-scroll" title="有新弹幕时自动滚到底"><input v-model="backendAutoScroll" type="checkbox" /> 自由滚动</label>
                        </div>
                        <div class="dm-toolbar-mode-cluster">
                          <div class="dm-toolbar-mode-cluster-actions">
                            <button type="button" class="dm-toolbar-soft-btn" title="清空当前弹幕列表" @click="backendDanmakuList = []">清空</button>
                          </div>
                          <div v-if="!isMobile" class="dm-toolbar-layout-slot">
                            <DmToolbarMenuSelect
                              :model-value="danmakuColumnMode"
                              variant="layout"
                              :options="COLUMN_LAYOUT_OPTS"
                              aria-label="弹幕栏布局"
                              title="弹幕栏布局：固定 / 自由 / 弹出"
                              @update:model-value="onDanmakuLayoutMenuPick"
                            />
                          </div>
                        </div>
                      </div>
                      <div class="dm-toolbar-search-slot">
                        <div class="dm-danmu-search dm-danmu-search--toolbar dm-search-pill">
                          <div class="dm-search-pill__mode-slot">
                            <DmToolbarMenuSelect
                              v-model="danmakuSearchMode"
                              variant="pill"
                              :options="DANMAKU_SEARCH_MODE_OPTS"
                              aria-label="弹幕筛选方式"
                            />
                          </div>
                          <input
                            v-model="danmakuSearchQuery"
                            type="search"
                            class="dm-search-pill__q"
                            placeholder="筛选弹幕…"
                            enterkeyhint="search"
                            aria-label="弹幕筛选关键字"
                          />
                          <span class="dm-search-pill__ico" aria-hidden="true">🔍</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div ref="backendFeedRef" class="dm-feed dm-feed--in-danmaku-stack dm-feed--fills-stack">
                <div v-if="backendDanmakuList.length === 0" class="dm-empty">{{ backendRooms.length === 0 ? '请添加直播间' : '点击直播间加载弹幕' }}</div>
                <div v-else-if="filteredDanmakuMessages.length === 0 && danmakuSearchQuery.trim()" class="dm-empty">无匹配的弹幕（可换一种筛选方式或清空）</div>
                <div v-for="(msg, idx) in filteredDanmakuMessages" :key="idx" class="dm-msg" :class="{ 'dm-msg--cmd': String(msg.txt || '').startsWith('#') }">
                  <div class="dm-msg-chatline">
                    <span class="dm-time dm-time--chat">{{ formatTime(msg.ts) }}</span>
                    <span
                      v-if="msg.level"
                      class="dm-chat-pill dm-ulv-el"
                      :class="userLevelQualityClass(msg.level)"
                    >
                      <span class="dm-chat-pill-ulv-num">{{ msg.level }}</span>
                    </span>
                    <span
                      v-if="msg.bnn"
                      class="dm-chat-pill dm-fan-el dm-fan-clickable"
                      :class="fanMedalQualityClass(msg.bl)"
                      @click="openBridRoom(danmakuFanBrid(msg))"
                    >
                      <span class="dm-fan-seg dm-fan-seg--lv">
                        <span class="dm-fan-lv-inner">
                          <span v-if="msg.bl" class="dm-chat-pill-lv">{{ msg.bl }}</span>
                        </span>
                      </span>
                      <span class="dm-fan-seg dm-fan-seg--nm">
                        <span class="dm-chat-pill-bnn">{{ msg.bnn }}</span>
                      </span>
                    </span>
                    <span class="dm-chat-ident">
                      <span class="dm-chat-nick" @mouseenter="showUidTooltip($event, msg.uid)" @mouseleave="hideUidTooltip()" @click="openUserPage(msg.nn)">{{ msg.nn }}</span>
                    </span>
                    <span class="dm-chat-colon">：</span><span class="dm-chat-txt">{{ msg.txt }}</span>
                  </div>
                </div>
                </div>
              </div>
            </div>
            <div
              v-if="giftEmbeddedBesideDm && !isMobile"
              class="dm-feed-splitter dm-feed-splitter--col"
              role="separator"
              aria-orientation="vertical"
              aria-label="拖动调整礼物栏宽度"
              @pointerdown="onGiftColSplitterPointerDown"
            />
            <!-- Right: gift panel (固定) -->
            <div v-if="giftInFixedSplit" class="dm-feed-right">
              <div class="dm-gift-panel">
                <div class="dm-gift-header dm-gift-header--parity">
                  <div class="dm-gift-header-toolbar dm-column-head-toolbar">
                    <div class="dm-column-head-toolbar__start dm-column-head-toolbar__start--gift">
                      <div class="dm-toolbar-row-first">
                        <div class="dm-toolbar-menu-lead dm-toolbar-menu-lead--gift">
                          <nav class="dm-gift-tabs dm-gift-tabs--inline dm-gift-tabs--toolbar">
                            <button type="button" :class="{ active: giftSubTab === 'records' }" @click="giftSubTab = 'records'">记录</button>
                            <button type="button" :class="{ active: giftSubTab === 'stats' }" @click="giftSubTab = 'stats'">统计</button>
<button v-if="isDev" type="button" class="dm-gift-tab-debug" :class="{ active: giftSubTab === 'debug' }" title="下行原始字段与计件明细（调试）" @click="giftSubTab = 'debug'">调试</button>
                          </nav>
                          <label class="dm-check dm-check--toolbar dm-check--toolbar-free-scroll" title="有新礼物时自动滚到底"><input v-model="giftAutoScroll" type="checkbox" /> 自动滚动</label>
                        </div>
                        <div class="dm-toolbar-mode-cluster">
                          <div class="dm-toolbar-mode-cluster-actions">
                            <button
                              v-if="giftSubTab === 'records' || giftSubTab === 'debug'"
                              type="button"
                              class="dm-toolbar-soft-btn"
                              title="重新拉取礼物记录"
                              @click="backendSelectedRoom && loadGiftsForRoom(backendSelectedRoom)"
                            >
                              刷新
                            </button>
                            <button
                              v-else-if="giftSubTab === 'stats'"
                              type="button"
                              class="dm-toolbar-soft-btn"
                              title="刷新礼物统计"
                              @click="backendSelectedRoom && loadGiftStats(backendSelectedRoom, giftStatsRange)"
                            >
                              刷新
                            </button>
                          </div>
                          <div v-if="!isMobile" class="dm-toolbar-layout-slot">
                            <DmToolbarMenuSelect
                              :model-value="giftColumnMode"
                              variant="layout"
                              :options="COLUMN_LAYOUT_OPTS"
                              aria-label="礼物栏布局"
                              title="礼物栏布局：固定 / 自由 / 弹出"
                              @update:model-value="onGiftLayoutMenuPick"
                            />
                          </div>
                        </div>
                      </div>
                      <div v-if="giftSubTab === 'records' || giftSubTab === 'debug'" class="dm-toolbar-search-slot">
                        <div class="dm-danmu-search dm-danmu-search--toolbar dm-search-pill">
                          <div class="dm-search-pill__mode-slot">
                            <DmToolbarMenuSelect
                              v-model="giftSearchMode"
                              variant="pill"
                              :options="GIFT_SEARCH_MODE_OPTS"
                              aria-label="礼物记录筛选方式"
                            />
                          </div>
                          <input
                            v-model="giftSearchQuery"
                            type="search"
                            class="dm-search-pill__q"
                            placeholder="筛选礼物记录…"
                            enterkeyhint="search"
                            aria-label="礼物筛选关键字"
                          />
                          <span class="dm-search-pill__ico" aria-hidden="true">🔍</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div v-if="giftSubTab === 'stats'" class="dm-gift-header-range-row">
                    <div class="dm-gift-range-group dm-gift-range-group--stretch">
                      <button
                        v-for="r in GIFT_STATS_RANGES"
                        :key="r.value"
                        type="button"
                        class="dm-gift-range-btn"
                        :class="{ active: giftStatsRange === r.value }"
                        @click="giftStatsRange = r.value"
                      >
                        {{ r.label }}
                      </button>
                    </div>
                  </div>
                </div>
                <div class="dm-gift-body">
                  <!-- Records view -->
                  <div v-if="giftSubTab === 'records'" ref="giftFeedRef" class="dm-gift-feed">
                    <div v-if="giftList.length === 0" class="dm-empty">暂无礼物记录</div>
                    <div v-else-if="giftFilteredList.length === 0" class="dm-empty">无匹配的礼物记录（可换一种筛选方式或清空关键字）</div>
                    <div v-for="(g, idx) in giftFilteredList" :key="idx" class="dm-gift-item" :class="{ 'dm-gift--big': g.bg === '1' }">
                      <span class="dm-time">{{ formatTime(g.ts) }}</span>
                      <span
                        v-if="g.level != null && String(g.level).trim() !== ''"
                        class="dm-chat-pill dm-ulv-el"
                        :class="userLevelQualityClass(String(g.level))"
                      >
                        <span class="dm-chat-pill-ulv-num">{{ g.level }}</span>
                      </span>
                      <span
                        v-if="g.bnn"
                        class="dm-chat-pill dm-fan-el dm-fan-clickable"
                        :class="fanMedalQualityClass(g.bl)"
                      @click="openBridRoom(g.brid || g.rid || g.roomId || '')">
                        <span class="dm-fan-seg dm-fan-seg--lv">
                          <span class="dm-fan-lv-inner">
                            <span v-if="g.bl" class="dm-chat-pill-lv">{{ g.bl }}</span>
                          </span>
                        </span>
                        <span class="dm-fan-seg dm-fan-seg--nm">
                          <span class="dm-chat-pill-bnn">{{ g.bnn }}</span>
                        </span>
                      </span>
<span class="dm-gift-nick" @mouseenter="showUidTooltip($event, g.uid)" @mouseleave="hideUidTooltip()" @click="openUserPage(g.nn)">{{ g.nn || '' }}</span>
                      <span class="dm-gift-name">{{ giftRowDisplayName(g) }}</span>
                      <span class="dm-gift-cnt">×{{ giftPiecesAggregateCount(g) }}</span>
                    </div>
                  </div>
                  <!-- Stats view -->                  <div v-if="giftSubTab === 'stats'" class="dm-gift-stats">
                    <div v-if="giftStatsLoading" class="dm-empty">加载中...</div>
                    <template v-else-if="giftStats">
                      <div class="dm-gift-stats-summary">
                        <div class="dm-gift-stats-card">
                          <span class="dm-gift-stats-label">总数量</span>
                          <span class="dm-gift-stats-value">{{ giftStats.totalCount }}</span>
                        </div>
                        <div class="dm-gift-stats-card" :title="GIFT_STATS_TOTAL_COST_HINT">
                          <span class="dm-gift-stats-label">收入</span>
                          <span class="dm-gift-stats-value dm-gift-stats-value--gold">{{ giftStatsTotalCost.toFixed(1) }}元</span>
                        </div>
                        <div class="dm-gift-stats-card">
                          <span class="dm-gift-stats-label">花费</span>
                          <span class="dm-gift-stats-value dm-gift-stats-value--cost">{{ giftStatsTotalSpend.toFixed(1) }}元</span>
                        </div>
                        <div class="dm-gift-stats-card">
                          <span class="dm-gift-stats-label">送礼人数</span>
                          <span class="dm-gift-stats-value">{{ giftStatsByUserSorted.length }}</span>
                        </div>
                      </div>
                      <div class="dm-gift-stats-section">
                        <div class="dm-gift-stats-table">
                          <div class="dm-gift-stats-thead">
                            <span class="dm-gift-stats-th dm-gift-stats-th--icon"></span>
                            <span class="dm-gift-stats-th dm-gift-stats-th--name">礼物</span>
                            <span class="dm-gift-stats-th dm-gift-stats-th--cnt">数量</span>
                            <span class="dm-gift-stats-th dm-gift-stats-th--revenue">收入</span>
                            <span class="dm-gift-stats-th dm-gift-stats-th--cost">花费</span>
                          </div>
                          <div v-for="item in giftStatsByGiftSorted" :key="item.gfid" class="dm-gift-stats-trow">
                            <span class="dm-gift-stats-td dm-gift-stats-td--icon">
                              <img v-if="item.icon" :src="item.icon" class="dm-gift-icon-sm" alt="" referrerpolicy="no-referrer" />
                              <span v-else class="dm-gift-icon-sm-placeholder">🎁</span>
                            </span>
                            <span class="dm-gift-stats-td dm-gift-stats-td--name">{{ item.name }}</span>
                            <span class="dm-gift-stats-td dm-gift-stats-td--cnt">×{{ item.count }}</span>
                            <span class="dm-gift-stats-td dm-gift-stats-td--revenue">{{ item.isPaid && item.value ? (item.value * item.count).toFixed(1) : '-' }}</span>
                            <span class="dm-gift-stats-td dm-gift-stats-td--cost">{{ item.isPaid && item.cost ? (item.cost * item.count).toFixed(1) : '-' }}</span>
                          </div>
                        </div>
                        <div v-if="giftStatsByGiftSorted.length === 0" class="dm-empty">暂无数据</div>
                      </div>
                      <div class="dm-gift-stats-section">
                        <div class="dm-gift-stats-user-table">
                          <div class="dm-gift-stats-user-thead">
                            <span class="dm-gift-stats-uth dm-gift-stats-uth--user">用户</span>
                            <span class="dm-gift-stats-uth dm-gift-stats-uth--revenue">收入</span>
                            <span class="dm-gift-stats-uth dm-gift-stats-uth--cost">花费</span>
                          </div>
                          <div v-for="item in giftStatsByUserSorted" :key="item.uid" class="dm-gift-stats-utrow">
                            <span class="dm-gift-stats-utd dm-gift-stats-utd--user">
                              <span
                                v-if="item.level"
                                class="dm-chat-pill dm-ulv-el"
                                :class="userLevelQualityClass(String(item.level))"
                              >
                                <span class="dm-chat-pill-ulv-num">{{ item.level }}</span>
                              </span>
<span class="dm-gift-stats-user-nick" @mouseenter="showUidTooltip($event, item.uid)" @mouseleave="hideUidTooltip()" @click="openUserPage(item.nn || item.uid)">{{ item.nn || item.uid }}</span>
                            </span>
                            <span class="dm-gift-stats-utd dm-gift-stats-utd--revenue">{{ item.totalValue ? item.totalValue.toFixed(1) : '-' }}</span>
                            <span class="dm-gift-stats-utd dm-gift-stats-utd--cost">{{ item.totalCost ? item.totalCost.toFixed(1) : '-' }}</span>
                          </div>
                        </div>
                        <div v-if="giftStatsByUserSorted.length === 0" class="dm-empty">暂无数据</div>
                      </div>
                    </template>
                    <div v-else class="dm-empty">点击刷新加载统计</div>
                  </div>
                  <div v-if="giftSubTab === 'debug'" class="dm-gift-feed dm-gift-debug-feed">
                    <div v-if="giftList.length === 0" class="dm-empty">暂无礼物记录</div>
                    <template v-else>
                      <p class="dm-gift-debug-lead">
                        「计入件」与服务器汇总一致：仅取下行的 <code class="dm-gift-debug-code">gfcnt</code>（当次礼物个数，向下取整）；缺失或非法时按 <code class="dm-gift-debug-code">1</code>，<strong>不乘</strong>
                        hits、gs。下列为当前<strong>筛选</strong>结果，自上而下为<strong>新 → 旧</strong>。<strong>gfid</strong>＝斗鱼礼物 id；<strong>gfn</strong>＝本条下行名称；可与下方「查找表」中礼单名称对照。<strong>礼单价(值)</strong>按 gfid 查当前房间礼单缓存，列表头悬停见详解。下行<strong>完整 JSON</strong>仅在新窗口<strong>打开</strong>查看。
                      </p>
                      <details class="dm-gift-debug-lookup">
                        <summary class="dm-gift-debug-lookup-sum">礼物信息查找表（gfid → 开销(元)／价值(元)）</summary>
                        <p class="dm-gift-debug-lookup-note" :title="GIFT_CATALOG_VALUE_HINT">
                          等价于前端 <strong>giftInfoMap[gfid]</strong>：服务端 <code class="dm-gift-debug-code">GET /gift-list/:房间</code> 拉斗鱼 CDN 清单后写入的映射；<strong>from</strong> 列：<strong>1·直接</strong>／<strong>2·背包</strong>；表中
                          <strong>开销(元)</strong>（giftInfo.cost，已换算为元）与<strong>价值(元)</strong>（giftInfo.value，已换算为元）及<strong>礼单价摘要</strong>同源（列表头悬停）。末列<strong>打开</strong>在新窗口查看该 gfid 的 CDN 本条 JSON（无 <code class="dm-gift-debug-code">raw</code> 时为映射快照）。
                        </p>
                        <div v-if="giftInfoLoading" class="dm-gift-debug-lookup-msg">礼单加载中…</div>
                        <template v-else-if="giftCatalogLookupRows.length">
                          <div class="dm-gift-debug-catalog-scroll">
                            <table class="dm-gift-debug-catalog-table">
                              <thead>
                                <tr>
                                  <th>gfid</th>
                                  <th :title="GIFT_FROM_HINT">from</th>
                                  <th>礼单名</th>
<th title="giftInfo.cost：单次礼物开销(元)，已由服务器换算(price/100)">开销(元)</th>
                                  <th title="giftInfo.value：单次礼物价值，人民币元">价值(元)</th>
                                  <th>图标</th>
                                  <th class="dm-gift-debug-catalog-th-open" title="在新窗口查看 gift/v3 本条 CDN 原生 JSON（无 raw 时为快照）">打开</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr v-for="row in giftCatalogLookupRows" :key="'gcatdbg_' + row.gfid">
                                  <td class="dm-gift-debug-td-num">{{ row.gfid }}</td>
                                  <td class="dm-gift-debug-td-num dm-gift-debug-td-nowrap" :title="GIFT_FROM_HINT">{{ row.fromLabel }}</td>
                                  <td class="dm-gift-debug-td-ell" :title="row.name">{{ row.name }}</td>
                                  <td class="dm-gift-debug-td-num">{{ row.cost }}</td>
                                  <td class="dm-gift-debug-td-num">{{ row.value }}</td>
                                  <td class="dm-gift-debug-catalog-img-cell">
                                    <img v-if="row.icon" :src="row.icon" class="dm-gift-debug-catalog-icon" alt="" referrerpolicy="no-referrer" />
                                    <span v-else class="dm-gift-debug-lookup-dash">—</span>
                                  </td>
                                  <td class="dm-gift-debug-catalog-open-cell">
                                    <button
                                      type="button"
                                      class="dm-gift-debug-json-hit dm-gift-debug-catalog-json-hit"
                                      title="新窗口格式化 JSON（与 dgb「打开」相同交互）"
                                      @click.stop="openGiftCatalogRawWindow(row.gfid)"
                                    >
                                      打开
                                    </button>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </template>
                        <div v-else class="dm-gift-debug-lookup-msg">暂无礼单缓存（打开礼物分区或载入统计时会拉取）。</div>
                      </details>
                      <details class="dm-gift-debug-lookup">
                        <summary class="dm-gift-debug-lookup-sum">背包／道具 prop_gift_config 对照（本房 CDN from=2）</summary>
                        <p class="dm-gift-debug-lookup-note" :title="GIFT_PROP_TABLE_HINT">
                          数据源 <code class="dm-gift-debug-code">webconf.douyucdn.cn · prop_gift_config.json</code>（JSONP）。以下为<strong>本房间 gift/v3</strong>中带 <strong>from=2</strong> 的 gfid；全站条目数见表下脚注。<strong>pc</strong>／<strong>devote</strong> 与覆写后的
                          <code class="dm-gift-debug-code">giftInfo.cost</code>／<code class="dm-gift-debug-code">giftInfo.value</code>同源。<strong>打开</strong>为配置本条 JSON。
                        </p>
                        <div v-if="giftInfoLoading" class="dm-gift-debug-lookup-msg">礼单加载中…</div>
                        <template v-else-if="giftPropCatalogRows.length">
                          <div class="dm-gift-debug-catalog-scroll">
                            <table class="dm-gift-debug-catalog-table">
                              <thead>
                                <tr>
                                  <th>gfid</th>
                                  <th title="配置文件 type（斗鱼分类）">type</th>
                                  <th>配置名</th>
                                  <th title="prop.pc → giftInfo.cost">pc</th>
                                  <th title="prop.devote → giftInfo.value">devote</th>
                                  <th title="是否在 prop 全表命中该行">命中</th>
                                  <th>图标</th>
                                  <th class="dm-gift-debug-catalog-th-open" title="新窗口本条 prop JSON">打开</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr v-for="row in giftPropCatalogRows" :key="'gpropdbg_' + row.gfid">
                                  <td class="dm-gift-debug-td-num">{{ row.gfid }}</td>
                                  <td class="dm-gift-debug-td-num">{{ row.type ?? "—" }}</td>
                                  <td class="dm-gift-debug-td-ell" :title="row.name">{{ row.name || "—" }}</td>
                                  <td class="dm-gift-debug-td-num">{{ row.pc }}</td>
                                  <td class="dm-gift-debug-td-num">{{ row.devote }}</td>
                                  <td class="dm-gift-debug-td-nowrap" :title="GIFT_PROP_OVERLAY_HINT">
                                    {{ row.overlaidFromProp ? "是" : "否" }}
                                  </td>
                                  <td class="dm-gift-debug-catalog-img-cell">
                                    <img v-if="row.icon" :src="row.icon" class="dm-gift-debug-catalog-icon" alt="" referrerpolicy="no-referrer" />
                                    <span v-else class="dm-gift-debug-lookup-dash">—</span>
                                  </td>
                                  <td class="dm-gift-debug-catalog-open-cell">
                                    <button
                                      type="button"
                                      class="dm-gift-debug-json-hit dm-gift-debug-catalog-json-hit"
                                      title="新窗口本条 prop JSON"
                                      @click.stop="openGiftPropRawWindow(row.gfid)"
                                    >
                                      打开
                                    </button>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </template>
                        <div v-else class="dm-gift-debug-lookup-msg">{{ giftPropCatalogEmptyTip }}</div>
                        <p
                          v-if="!giftInfoLoading && giftBackpackCatalogStats.propConfigOk"
                          class="dm-gift-debug-lookup-note dm-gift-debug-prop-meta"
                        >
                          prop 静态表合计约 <strong>{{ giftBackpackCatalogStats.totalPropKeys }}</strong> 个 gfid；本房间礼单中带
                          <strong>from=2</strong>
                          {{ giftBackpackCatalogStats.roomBackpackGiftIds }} 条；其中在全站 prop 命中并覆写刻度
                          <strong>{{ giftBackpackCatalogStats.overlaidFromPropCount }}</strong> 条。
                        </p>
                      </details>
                      <div class="dm-gift-debug-table-scroll">
                        <table class="dm-gift-debug-table">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>时间</th>
                              <th>ts(ms)</th>
                              <th title="斗鱼礼物 ID；礼单计价与归档统计均以 gfid 为键">gfid</th>
                              <th title="斗鱼下行本条礼物名；界面展示优先用它">gfn</th>
                              <th title="本次 dgb 礼物个数（单笔，下行原始）">gfcnt</th>
                              <th title="与服务端 giftPiecesFromStoredRecord 一致：仅 gfcnt，缺省时按 1">计入件</th>
<th :title="GIFT_CATALOG_VALUE_HINT">礼单价(值)</th>
                              <th>昵称</th>
                              <th>uid</th>
                              <th>bg</th>
                              <th>rid</th>
                              <th>lv</th>
                              <th>牌名</th>
                              <th>bl</th>
                              <th>brid</th>
                              <th class="dm-gift-debug-th-json" title="完整 JSON 仅在新窗口查看">打开</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr v-for="(g, ix) in giftDebugRows" :key="'gdk_sp_' + ix + '_' + String(g.ts)">
                              <td class="dm-gift-debug-td-num">{{ ix + 1 }}</td>
                              <td class="dm-gift-debug-td-nowrap">{{ formatTime(g.ts) }}</td>
                              <td class="dm-gift-debug-td-num">{{ g.ts }}</td>
                              <td class="dm-gift-debug-td-num">{{ g.gfid ?? "—" }}</td>
                              <td class="dm-gift-debug-td-ell dm-gift-debug-td-gfn" :title="String(g.gfn ?? '')">{{ g.gfn != null && String(g.gfn).trim() !== '' ? g.gfn : '—' }}</td>
                              <td class="dm-gift-debug-td-num">{{ g.gfcnt ?? "—" }}</td>
                              <td class="dm-gift-debug-td-num dm-gift-debug-td-strong">{{ giftPiecesAggregateCount(g) }}</td>
                              <td class="dm-gift-debug-td-nowrap" :title="GIFT_CATALOG_VALUE_HINT">{{ giftCatalogUnitDisplay(String(g.gfid ?? "")) }}</td>
                              <td class="dm-gift-debug-td-ell" :title="String(g.nn ?? '')">{{ g.nn ?? "—" }}</td>
                              <td class="dm-gift-debug-td-ell">{{ g.uid ?? "—" }}</td>
                              <td class="dm-gift-debug-td-num">{{ g.bg ?? "—" }}</td>
                              <td class="dm-gift-debug-td-ell">{{ g.rid ?? "—" }}</td>
                              <td class="dm-gift-debug-td-num">{{ g.level ?? "—" }}</td>
                              <td class="dm-gift-debug-td-ell">{{ g.bnn ?? "—" }}</td>
                              <td class="dm-gift-debug-td-num">{{ g.bl ?? "—" }}</td>
                              <td class="dm-gift-debug-td-ell">{{ g.brid ?? "—" }}</td>
                              <td class="dm-gift-debug-json-cell">
                                <button
                                  type="button"
                                  class="dm-gift-debug-json-hit"
                                  title="仅在新浏览器窗口打开本条完整格式化 JSON（可复制）"
                                  @click.stop="openGiftDebugJsonWindow(g)"
                                >
                                  打开
                                </button>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </template>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </div>

        <Teleport to="body">
          <div
            v-if="danmakuFreeInBench"
            class="dm-column-float dm-column-float--danmaku"
            :class="{ 'dm-column-float--dragging': dmDanmakuFreeDragging || dmDanmakuFreeResizing }"
            :style="danmakuFreeFloatStyle"
          >
            <div class="dm-column-float-chrome dm-column-float-chrome--dm" title="拖拽移动" @pointerdown.stop="onDanmakuFreeDragPointerDown">
              ⠿ <span class="dm-column-float-chrome-t">弹幕 · 自由</span>
            </div>
            <div class="dm-column-float-body">
              <div class="dm-danmaku-stack dm-danmaku-stack--fill-free">
                <div class="dm-danmaku-split-head">
                  <div class="dm-danmaku-split-head-toolbar dm-column-head-toolbar">
                    <div class="dm-column-head-toolbar__start dm-column-head-toolbar__start--danmaku">
                      <div class="dm-toolbar-row-first">
                        <div class="dm-toolbar-menu-lead dm-toolbar-menu-lead--danmaku">
                          <label class="dm-check dm-check--toolbar dm-check--toolbar-free-scroll" title="有新弹幕时自动滚到底"><input v-model="backendAutoScroll" type="checkbox" /> 自由滚动</label>
                        </div>
                        <div class="dm-toolbar-mode-cluster">
                          <div class="dm-toolbar-mode-cluster-actions">
                            <button type="button" class="dm-toolbar-soft-btn" title="清空当前弹幕列表" @click="backendDanmakuList = []">清空</button>
                          </div>
                          <div class="dm-toolbar-layout-slot">
                            <DmToolbarMenuSelect
                              :model-value="danmakuColumnMode"
                              variant="layout"
                              :options="COLUMN_LAYOUT_OPTS"
                              aria-label="弹幕栏布局"
                              title="弹幕栏布局：固定 / 自由 / 弹出"
                              @update:model-value="onDanmakuLayoutMenuPick"
                            />
                          </div>
                        </div>
                      </div>
                      <div class="dm-toolbar-search-slot">
                        <div class="dm-danmu-search dm-danmu-search--toolbar dm-search-pill">
                          <div class="dm-search-pill__mode-slot">
                            <DmToolbarMenuSelect
                              v-model="danmakuSearchMode"
                              variant="pill"
                              :options="DANMAKU_SEARCH_MODE_OPTS"
                              aria-label="弹幕筛选方式"
                            />
                          </div>
                          <input
                            v-model="danmakuSearchQuery"
                            type="search"
                            class="dm-search-pill__q"
                            placeholder="筛选弹幕…"
                            enterkeyhint="search"
                            aria-label="弹幕筛选关键字"
                          />
                          <span class="dm-search-pill__ico" aria-hidden="true">🔍</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div ref="backendFeedFreeRef" class="dm-feed dm-feed--in-danmaku-stack dm-feed--fills-stack dm-feed--free-body">
                  <div v-if="backendDanmakuList.length === 0" class="dm-empty">{{ backendRooms.length === 0 ? '请添加直播间' : '点击直播间加载弹幕' }}</div>
                  <div v-else-if="filteredDanmakuMessages.length === 0 && danmakuSearchQuery.trim()" class="dm-empty">无匹配的弹幕（可换一种筛选方式或清空）</div>
                  <div v-for="(msg, idx) in filteredDanmakuMessages" :key="'df_' + idx" class="dm-msg" :class="{ 'dm-msg--cmd': String(msg.txt || '').startsWith('#') }">
                    <div class="dm-msg-chatline">
                      <span class="dm-time dm-time--chat">{{ formatTime(msg.ts) }}</span>
                      <span v-if="msg.level" class="dm-chat-pill dm-ulv-el" :class="userLevelQualityClass(msg.level)">
                        <span class="dm-chat-pill-ulv-num">{{ msg.level }}</span>
                      </span>
                      <span v-if="msg.bnn" class="dm-chat-pill dm-fan-el dm-fan-clickable" :class="fanMedalQualityClass(msg.bl)" @click="openBridRoom(danmakuFanBrid(msg))">
                        <span class="dm-fan-seg dm-fan-seg--nm">
                          <span class="dm-chat-pill-bnn">{{ msg.bnn }}</span>
                        </span>
                      </span>
                      <span class="dm-chat-ident">
                      <span class="dm-chat-nick" @mouseenter="showUidTooltip($event, msg.uid)" @mouseleave="hideUidTooltip()" @click="openUserPage(msg.nn)">{{ msg.nn }}</span>
                      </span>
                      <span class="dm-chat-colon">：</span><span class="dm-chat-txt">{{ msg.txt }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <button
              type="button"
              class="dm-column-float-resize-br"
              aria-label="调整大小"
              title="拖动调整大小"
              @pointerdown.stop.prevent="onDanmakuFreeResizePointerDown"
            />
          </div>
        </Teleport>

        <Teleport to="body">
          <div
            v-if="giftFreeInBench"
            class="dm-column-float dm-column-float--gift"
            :class="{ 'dm-column-float--dragging': dmGiftFreeDragging || dmGiftFreeResizing }"
            :style="giftFreeFloatStyle"
          >
            <div class="dm-column-float-chrome dm-column-float-chrome--gift" title="拖拽移动" @pointerdown.stop="onGiftFreeDragPointerDown">
              ⠿ <span class="dm-column-float-chrome-t">礼物 · 自由</span>
            </div>
            <div class="dm-column-float-body dm-column-float-body--gift">
              <div class="dm-gift-panel dm-gift-panel--free-overlay">
                <div class="dm-gift-header dm-gift-header--parity">
                  <div class="dm-gift-header-toolbar dm-column-head-toolbar">
                    <div class="dm-column-head-toolbar__start dm-column-head-toolbar__start--gift">
                      <div class="dm-toolbar-row-first">
                        <div class="dm-toolbar-menu-lead dm-toolbar-menu-lead--gift">
                          <nav class="dm-gift-tabs dm-gift-tabs--inline dm-gift-tabs--toolbar">
                            <button type="button" :class="{ active: giftSubTab === 'records' }" @click="giftSubTab = 'records'">记录</button>
                            <button type="button" :class="{ active: giftSubTab === 'stats' }" @click="giftSubTab = 'stats'">统计</button>
<button v-if="isDev" type="button" class="dm-gift-tab-debug" :class="{ active: giftSubTab === 'debug' }" title="下行原始字段与计件明细（调试）" @click="giftSubTab = 'debug'">调试</button>
                          </nav>
                          <label class="dm-check dm-check--toolbar dm-check--toolbar-free-scroll" title="有新礼物时自动滚到底"><input v-model="giftAutoScroll" type="checkbox" /> 自动滚动</label>
                        </div>
                        <div class="dm-toolbar-mode-cluster">
                          <div class="dm-toolbar-mode-cluster-actions">
                            <button
                              v-if="giftSubTab === 'records' || giftSubTab === 'debug'"
                              type="button"
                              class="dm-toolbar-soft-btn"
                              title="重新拉取礼物记录"
                              @click="backendSelectedRoom && loadGiftsForRoom(backendSelectedRoom)"
                            >
                              刷新
                            </button>
                            <button
                              v-else-if="giftSubTab === 'stats'"
                              type="button"
                              class="dm-toolbar-soft-btn"
                              title="刷新礼物统计"
                              @click="backendSelectedRoom && loadGiftStats(backendSelectedRoom, giftStatsRange)"
                            >
                              刷新
                            </button>
                          </div>
                          <div class="dm-toolbar-layout-slot">
                            <DmToolbarMenuSelect
                              :model-value="giftColumnMode"
                              variant="layout"
                              :options="COLUMN_LAYOUT_OPTS"
                              aria-label="礼物栏布局"
                              title="礼物栏布局：固定 / 自由 / 弹出"
                              @update:model-value="onGiftLayoutMenuPick"
                            />
                          </div>
                        </div>
                      </div>
                      <div v-if="giftSubTab === 'records' || giftSubTab === 'debug'" class="dm-toolbar-search-slot">
                        <div class="dm-danmu-search dm-danmu-search--toolbar dm-search-pill">
                          <div class="dm-search-pill__mode-slot">
                            <DmToolbarMenuSelect
                              v-model="giftSearchMode"
                              variant="pill"
                              :options="GIFT_SEARCH_MODE_OPTS"
                              aria-label="礼物记录筛选方式"
                            />
                          </div>
                          <input
                            v-model="giftSearchQuery"
                            type="search"
                            class="dm-search-pill__q"
                            placeholder="筛选礼物记录…"
                            enterkeyhint="search"
                            aria-label="礼物筛选关键字"
                          />
                          <span class="dm-search-pill__ico" aria-hidden="true">🔍</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div v-if="giftSubTab === 'stats'" class="dm-gift-header-range-row">
                    <div class="dm-gift-range-group dm-gift-range-group--stretch">
                      <button
                        v-for="r in GIFT_STATS_RANGES"
                        :key="'gff-' + r.value"
                        type="button"
                        class="dm-gift-range-btn"
                        :class="{ active: giftStatsRange === r.value }"
                        @click="giftStatsRange = r.value"
                      >
                        {{ r.label }}
                      </button>
                    </div>
                  </div>
                </div>
                <div class="dm-gift-body">
                  <div v-if="giftSubTab === 'records'" ref="giftFeedFreeRef" class="dm-gift-feed">
                    <div v-if="giftList.length === 0" class="dm-empty">暂无礼物记录</div>
                    <div v-else-if="giftFilteredList.length === 0" class="dm-empty">无匹配的礼物记录（可换一种筛选方式或清空关键字）</div>
                    <div v-for="(g, idx) in giftFilteredList" :key="'gff_' + idx" class="dm-gift-item" :class="{ 'dm-gift--big': g.bg === '1' }">
                      <span class="dm-time">{{ formatTime(g.ts) }}</span>
                      <span v-if="g.level != null && String(g.level).trim() !== ''" class="dm-chat-pill dm-ulv-el" :class="userLevelQualityClass(String(g.level))">
                        <span class="dm-chat-pill-ulv-num">{{ g.level }}</span>
                      </span>
<span class="dm-gift-nick" @mouseenter="showUidTooltip($event, g.uid)" @mouseleave="hideUidTooltip()" @click="openUserPage(g.nn)">{{ g.nn || '' }}</span>
                      <span class="dm-gift-name">{{ giftRowDisplayName(g) }}</span>
                      <span class="dm-gift-cnt">×{{ giftPiecesAggregateCount(g) }}</span>
                    </div>
                  </div>
                  <div v-if="giftSubTab === 'stats'" class="dm-gift-stats">
                    <div v-if="giftStatsLoading" class="dm-empty">加载中...</div>
                    <template v-else-if="giftStats">
                      <div class="dm-gift-stats-summary dm-gift-stats-summary--compact">
                        <span>总<strong>{{ giftStats.totalCount }}</strong></span>
                        <span :title="GIFT_STATS_TOTAL_COST_HINT">收入<strong>{{ giftStatsTotalCost.toFixed(1) }}</strong>元</span>
                        <span>花费<strong>{{ giftStatsTotalSpend.toFixed(1) }}</strong>元</span>
                      </div>
                      <div v-if="giftStatsByGiftSorted.length === 0" class="dm-empty">暂无数据</div>
                      <div class="dm-gift-stats-table dm-gift-stats-table--compact">
                        <div v-for="item in giftStatsByGiftSorted" :key="'gfs_' + item.gfid" class="dm-gift-stats-trow">
                          <span class="dm-gift-stats-td dm-gift-stats-td--name">{{ item.name }}</span>
                          <span class="dm-gift-stats-td dm-gift-stats-td--cnt">×{{ item.count }}</span>
                          <span class="dm-gift-stats-td dm-gift-stats-td--revenue">{{ item.isPaid && item.value ? (item.value * item.count).toFixed(1) : '-' }}</span>
                          <span class="dm-gift-stats-td dm-gift-stats-td--cost">{{ item.isPaid && item.cost ? (item.cost * item.count).toFixed(1) : '-' }}</span>
                        </div>
                      </div>
                    </template>
                    <div v-else class="dm-empty">点击刷新加载统计</div>
                  </div>
                  <div v-if="giftSubTab === 'debug'" class="dm-gift-feed dm-gift-debug-feed">
                    <div v-if="giftList.length === 0" class="dm-empty">暂无礼物记录</div>
                    <template v-else>
                      <p class="dm-gift-debug-lead">
                        「计入件」与服务器汇总一致：仅取下行的 <code class="dm-gift-debug-code">gfcnt</code>（当次礼物个数，向下取整）；缺失或非法时按 <code class="dm-gift-debug-code">1</code>，<strong>不乘</strong>
                        hits、gs。下列为当前<strong>筛选</strong>结果，自上而下为<strong>新 → 旧</strong>。<strong>gfid</strong>＝斗鱼礼物 id；<strong>gfn</strong>＝本条下行名称；可与下方「查找表」中礼单名称对照。<strong>礼单价(值)</strong>按 gfid 查当前房间礼单缓存，列表头悬停见详解。下行<strong>完整 JSON</strong>仅在新窗口<strong>打开</strong>查看。
                      </p>
                      <details class="dm-gift-debug-lookup">
                        <summary class="dm-gift-debug-lookup-sum">礼物信息查找表（gfid → 开销(元)／价值(元)）</summary>
                        <p class="dm-gift-debug-lookup-note" :title="GIFT_CATALOG_VALUE_HINT">
                          等价于前端 <strong>giftInfoMap[gfid]</strong>：服务端 <code class="dm-gift-debug-code">GET /gift-list/:房间</code> 拉斗鱼 CDN 清单后写入的映射；<strong>from</strong> 列：<strong>1·直接</strong>／<strong>2·背包</strong>；表中
                          <strong>开销(元)</strong>（giftInfo.cost，已换算为元）与<strong>价值(元)</strong>（giftInfo.value，已换算为元）及<strong>礼单价摘要</strong>同源（列表头悬停）。末列<strong>打开</strong>在新窗口查看该 gfid 的 CDN 本条 JSON（无 <code class="dm-gift-debug-code">raw</code> 时为映射快照）。
                        </p>
                        <div v-if="giftInfoLoading" class="dm-gift-debug-lookup-msg">礼单加载中…</div>
                        <template v-else-if="giftCatalogLookupRows.length">
                          <div class="dm-gift-debug-catalog-scroll">
                            <table class="dm-gift-debug-catalog-table">
                              <thead>
                                <tr>
                                  <th>gfid</th>
                                  <th :title="GIFT_FROM_HINT">from</th>
                                  <th>礼单名</th>
<th title="giftInfo.cost：单次礼物开销(元)，已由服务器换算(price/100)">开销(元)</th>
                                  <th title="giftInfo.value：单次礼物价值，人民币元">价值(元)</th>
                                  <th>图标</th>
                                  <th class="dm-gift-debug-catalog-th-open" title="在新窗口查看 gift/v3 本条 CDN 原生 JSON（无 raw 时为快照）">打开</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr v-for="row in giftCatalogLookupRows" :key="'gcatdbg_' + row.gfid">
                                  <td class="dm-gift-debug-td-num">{{ row.gfid }}</td>
                                  <td class="dm-gift-debug-td-num dm-gift-debug-td-nowrap" :title="GIFT_FROM_HINT">{{ row.fromLabel }}</td>
                                  <td class="dm-gift-debug-td-ell" :title="row.name">{{ row.name }}</td>
                                  <td class="dm-gift-debug-td-num">{{ row.cost }}</td>
                                  <td class="dm-gift-debug-td-num">{{ row.value }}</td>
                                  <td class="dm-gift-debug-catalog-img-cell">
                                    <img v-if="row.icon" :src="row.icon" class="dm-gift-debug-catalog-icon" alt="" referrerpolicy="no-referrer" />
                                    <span v-else class="dm-gift-debug-lookup-dash">—</span>
                                  </td>
                                  <td class="dm-gift-debug-catalog-open-cell">
                                    <button
                                      type="button"
                                      class="dm-gift-debug-json-hit dm-gift-debug-catalog-json-hit"
                                      title="新窗口格式化 JSON（与 dgb「打开」相同交互）"
                                      @click.stop="openGiftCatalogRawWindow(row.gfid)"
                                    >
                                      打开
                                    </button>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </template>
                        <div v-else class="dm-gift-debug-lookup-msg">暂无礼单缓存（打开礼物分区或载入统计时会拉取）。</div>
                      </details>
                      <details class="dm-gift-debug-lookup">
                        <summary class="dm-gift-debug-lookup-sum">背包／道具 prop_gift_config 对照（本房 CDN from=2）</summary>
                        <p class="dm-gift-debug-lookup-note" :title="GIFT_PROP_TABLE_HINT">
                          数据源 <code class="dm-gift-debug-code">webconf.douyucdn.cn · prop_gift_config.json</code>（JSONP）。以下为<strong>本房间 gift/v3</strong>中带 <strong>from=2</strong> 的 gfid；全站条目数见表下脚注。<strong>pc</strong>／<strong>devote</strong> 与覆写后的
                          <code class="dm-gift-debug-code">giftInfo.cost</code>／<code class="dm-gift-debug-code">giftInfo.value</code>同源。<strong>打开</strong>为配置本条 JSON。
                        </p>
                        <div v-if="giftInfoLoading" class="dm-gift-debug-lookup-msg">礼单加载中…</div>
                        <template v-else-if="giftPropCatalogRows.length">
                          <div class="dm-gift-debug-catalog-scroll">
                            <table class="dm-gift-debug-catalog-table">
                              <thead>
                                <tr>
                                  <th>gfid</th>
                                  <th title="配置文件 type（斗鱼分类）">type</th>
                                  <th>配置名</th>
                                  <th title="prop.pc → giftInfo.cost">pc</th>
                                  <th title="prop.devote → giftInfo.value">devote</th>
                                  <th title="是否在 prop 全表命中该行">命中</th>
                                  <th>图标</th>
                                  <th class="dm-gift-debug-catalog-th-open" title="新窗口本条 prop JSON">打开</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr v-for="row in giftPropCatalogRows" :key="'gpropdbg_' + row.gfid">
                                  <td class="dm-gift-debug-td-num">{{ row.gfid }}</td>
                                  <td class="dm-gift-debug-td-num">{{ row.type ?? "—" }}</td>
                                  <td class="dm-gift-debug-td-ell" :title="row.name">{{ row.name || "—" }}</td>
                                  <td class="dm-gift-debug-td-num">{{ row.pc }}</td>
                                  <td class="dm-gift-debug-td-num">{{ row.devote }}</td>
                                  <td class="dm-gift-debug-td-nowrap" :title="GIFT_PROP_OVERLAY_HINT">
                                    {{ row.overlaidFromProp ? "是" : "否" }}
                                  </td>
                                  <td class="dm-gift-debug-catalog-img-cell">
                                    <img v-if="row.icon" :src="row.icon" class="dm-gift-debug-catalog-icon" alt="" referrerpolicy="no-referrer" />
                                    <span v-else class="dm-gift-debug-lookup-dash">—</span>
                                  </td>
                                  <td class="dm-gift-debug-catalog-open-cell">
                                    <button
                                      type="button"
                                      class="dm-gift-debug-json-hit dm-gift-debug-catalog-json-hit"
                                      title="新窗口本条 prop JSON"
                                      @click.stop="openGiftPropRawWindow(row.gfid)"
                                    >
                                      打开
                                    </button>
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </template>
                        <div v-else class="dm-gift-debug-lookup-msg">{{ giftPropCatalogEmptyTip }}</div>
                        <p
                          v-if="!giftInfoLoading && giftBackpackCatalogStats.propConfigOk"
                          class="dm-gift-debug-lookup-note dm-gift-debug-prop-meta"
                        >
                          prop 静态表合计约 <strong>{{ giftBackpackCatalogStats.totalPropKeys }}</strong> 个 gfid；本房间礼单中带
                          <strong>from=2</strong>
                          {{ giftBackpackCatalogStats.roomBackpackGiftIds }} 条；其中在全站 prop 命中并覆写刻度
                          <strong>{{ giftBackpackCatalogStats.overlaidFromPropCount }}</strong> 条。
                        </p>
                      </details>
                      <div class="dm-gift-debug-table-scroll">
                        <table class="dm-gift-debug-table">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>时间</th>
                              <th>ts(ms)</th>
                              <th title="斗鱼礼物 ID；礼单计价与归档统计均以 gfid 为键">gfid</th>
                              <th title="斗鱼下行本条礼物名；界面展示优先用它">gfn</th>
                              <th title="本次 dgb 礼物个数（单笔，下行原始）">gfcnt</th>
                              <th title="与服务端 giftPiecesFromStoredRecord 一致：仅 gfcnt，缺省时按 1">计入件</th>
<th :title="GIFT_CATALOG_VALUE_HINT">礼单价(值)</th>
                              <th>昵称</th>
                              <th>uid</th>
                              <th>bg</th>
                              <th>rid</th>
                              <th>lv</th>
                              <th>牌名</th>
                              <th>bl</th>
                              <th>brid</th>
                              <th class="dm-gift-debug-th-json" title="完整 JSON 仅在新窗口查看">打开</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr v-for="(g, ix) in giftDebugRows" :key="'gdk_ff_' + ix + '_' + String(g.ts)">
                              <td class="dm-gift-debug-td-num">{{ ix + 1 }}</td>
                              <td class="dm-gift-debug-td-nowrap">{{ formatTime(g.ts) }}</td>
                              <td class="dm-gift-debug-td-num">{{ g.ts }}</td>
                              <td class="dm-gift-debug-td-num">{{ g.gfid ?? "—" }}</td>
                              <td class="dm-gift-debug-td-ell dm-gift-debug-td-gfn" :title="String(g.gfn ?? '')">{{ g.gfn != null && String(g.gfn).trim() !== '' ? g.gfn : '—' }}</td>
                              <td class="dm-gift-debug-td-num">{{ g.gfcnt ?? "—" }}</td>
                              <td class="dm-gift-debug-td-num dm-gift-debug-td-strong">{{ giftPiecesAggregateCount(g) }}</td>
                              <td class="dm-gift-debug-td-nowrap" :title="GIFT_CATALOG_VALUE_HINT">{{ giftCatalogUnitDisplay(String(g.gfid ?? "")) }}</td>
                              <td class="dm-gift-debug-td-ell" :title="String(g.nn ?? '')">{{ g.nn ?? "—" }}</td>
                              <td class="dm-gift-debug-td-ell">{{ g.uid ?? "—" }}</td>
                              <td class="dm-gift-debug-td-num">{{ g.bg ?? "—" }}</td>
                              <td class="dm-gift-debug-td-ell">{{ g.rid ?? "—" }}</td>
                              <td class="dm-gift-debug-td-num">{{ g.level ?? "—" }}</td>
                              <td class="dm-gift-debug-td-ell">{{ g.bnn ?? "—" }}</td>
                              <td class="dm-gift-debug-td-num">{{ g.bl ?? "—" }}</td>
                              <td class="dm-gift-debug-td-ell">{{ g.brid ?? "—" }}</td>
                              <td class="dm-gift-debug-json-cell">
                                <button
                                  type="button"
                                  class="dm-gift-debug-json-hit"
                                  title="仅在新浏览器窗口打开本条完整格式化 JSON（可复制）"
                                  @click.stop="openGiftDebugJsonWindow(g)"
                                >
                                  打开
                                </button>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </template>
                  </div>
                </div>
              </div>
            </div>
            <button
              type="button"
              class="dm-column-float-resize-br"
              aria-label="调整礼物栏大小"
              title="拖动调整大小"
              @pointerdown.stop.prevent="onGiftFreeResizePointerDown"
            />
          </div>
        </Teleport>

          <div
            v-if="activeSubTab === 'danmaku' && !splitHasFixedSlots && !benchHasFreeOverlays && !showDanmakuFeedBar && !showGiftPanel"
            class="dm-feed-split-empty"
          >
            <div class="dm-empty">
              {{
                RELEASE_GIFT_PANEL_DISABLED
                  ? '弹幕栏已隐藏。请点击上方的「显示弹幕栏」恢复。'
                  : '弹幕栏与礼物栏均已隐藏。请使用上方的「显示弹幕栏」或「显示礼物栏」恢复。'
              }}
            </div>
          </div>
          <div
            v-else-if="
              activeSubTab === 'danmaku' && !splitHasFixedSlots && !benchHasFreeOverlays && (showDanmakuFeedBar || showGiftPanel)
            "
            class="dm-feed-split-empty"
          >
            <div class="dm-empty">当前两栏均为「弹出」模式（独立浏览器窗口或被拦截时暂留在页面层）。可使用各栏的「嵌回画布」或将布局切回「固定 / 自由」。</div>
          </div>
        </div>
        </div>

        <Teleport :to="danmakuPopoutTeleportTarget" :disabled="danmakuFeedPopTeleportDisabled">
          <div
            v-if="activeSubTab === 'danmaku' && showDanmakuFeedBar && danmakuColumnMode === 'popout'"
            class="dm-feed-pop-shell"
            :class="{
              'dm-feed-pop-shell--dragging': dmFeedPopDragging,
              'dm-feed-pop-shell--resizing': dmFeedPopResizing,
            }"
            :style="danmakuFeedPopShellStyle"
          >
            <div class="dm-feed-pop-head">
              <span
                class="dm-feed-pop-drag"
                title="拖动"
                @pointerdown="onDanmakuFeedPopDragPointerDown"
              >⠿ 弹幕列表</span>
              <button
                type="button"
                class="dm-btn dm-btn--xs dm-btn--primary"
                @click.stop="closeDanmakuFeedPopout"
              >嵌回画布</button>
            </div>
            <div class="dm-danmaku-split-head dm-danmaku-split-head--pop-shell">
              <div class="dm-danmaku-split-head-toolbar dm-column-head-toolbar">
                <div class="dm-column-head-toolbar__start dm-column-head-toolbar__start--danmaku">
                  <div class="dm-toolbar-row-first">
                    <div class="dm-toolbar-menu-lead dm-toolbar-menu-lead--danmaku">
                      <label class="dm-check dm-check--toolbar dm-check--toolbar-free-scroll" title="有新弹幕时自动滚到底"><input v-model="backendAutoScroll" type="checkbox" /> 自由滚动</label>
                    </div>
                    <div class="dm-toolbar-mode-cluster">
                      <div class="dm-toolbar-mode-cluster-actions">
                        <button type="button" class="dm-toolbar-soft-btn" title="清空当前弹幕列表" @click="backendDanmakuList = []">清空</button>
                      </div>
                      <div class="dm-toolbar-layout-slot">
                        <DmToolbarMenuSelect
                          :model-value="danmakuColumnMode"
                          variant="layout"
                          :options="COLUMN_LAYOUT_OPTS"
                          aria-label="弹幕栏布局"
                          title="弹幕栏布局：固定 / 自由 / 弹出"
                          @update:model-value="onDanmakuLayoutMenuPick"
                        />
                      </div>
                    </div>
                  </div>
                  <div class="dm-toolbar-search-slot">
                    <div class="dm-danmu-search dm-danmu-search--toolbar dm-search-pill">
                      <div class="dm-search-pill__mode-slot">
                        <DmToolbarMenuSelect
                          v-model="danmakuSearchMode"
                          variant="pill"
                          :options="DANMAKU_SEARCH_MODE_OPTS"
                          aria-label="弹幕筛选方式"
                        />
                      </div>
                      <input
                        v-model="danmakuSearchQuery"
                        type="search"
                        class="dm-search-pill__q"
                        placeholder="筛选弹幕…"
                        enterkeyhint="search"
                            aria-label="弹幕筛选关键字"
                          />
                          <span class="dm-search-pill__ico" aria-hidden="true">🔍</span>
                        </div>
                      </div>
                </div>
              </div>
            </div>
            <div ref="backendFeedPopRef" class="dm-feed dm-feed--floated dm-feed--in-pop-shell-body">
              <div v-if="backendDanmakuList.length === 0" class="dm-empty">{{ backendRooms.length === 0 ? '请添加直播间' : '点击直播间加载弹幕' }}</div>
              <div v-else-if="filteredDanmakuMessages.length === 0 && danmakuSearchQuery.trim()" class="dm-empty">无匹配的弹幕（可换一种筛选方式或清空）</div>
              <div v-for="(msg, idx) in filteredDanmakuMessages" :key="'pop-' + idx" class="dm-msg" :class="{ 'dm-msg--cmd': String(msg.txt || '').startsWith('#') }">
                <div class="dm-msg-chatline">
                  <span class="dm-time dm-time--chat">{{ formatTime(msg.ts) }}</span>
                  <span
                    v-if="msg.level"
                    class="dm-chat-pill dm-ulv-el"
                    :class="userLevelQualityClass(msg.level)"
                  >
                    <span class="dm-chat-pill-ulv-num">{{ msg.level }}</span>
                  </span>
                  <span
                    v-if="msg.bnn"
                    class="dm-chat-pill dm-fan-el dm-fan-clickable"
                    :class="fanMedalQualityClass(msg.bl)"
                    @click="openBridRoom(danmakuFanBrid(msg))"
                  >
                    <span class="dm-fan-seg dm-fan-seg--lv">
                      <span class="dm-fan-lv-inner">
                        <span v-if="msg.bl" class="dm-chat-pill-lv">{{ msg.bl }}</span>
                      </span>
                    </span>
                    <span class="dm-fan-seg dm-fan-seg--nm">
                      <span class="dm-chat-pill-bnn">{{ msg.bnn }}</span>
                    </span>
                  </span>
                  <span class="dm-chat-ident">
                      <span class="dm-chat-nick" @mouseenter="showUidTooltip($event, msg.uid)" @mouseleave="hideUidTooltip()" @click="openUserPage(msg.nn)">{{ msg.nn }}</span>
                  </span>
                  <span class="dm-chat-colon">：</span><span class="dm-chat-txt">{{ msg.txt }}</span>
                </div>
              </div>
            </div>
            <button
              type="button"
              class="dm-feed-pop-resize-br"
              aria-label="拖动右下角调整弹幕框大小"
              title="拖动调整大小"
              @pointerdown.stop="onDanmakuFeedPopResizePointerDown"
            ></button>
          </div>
        </Teleport>

        <Teleport :to="giftPopoutTeleportTarget" :disabled="giftPopTeleportDisabled">
          <div
            v-if="activeSubTab === 'danmaku' && showGiftPanel && giftColumnMode === 'popout'"
            class="dm-feed-pop-shell"
            :class="{
              'dm-feed-pop-shell--dragging': dmGiftPopDragging,
              'dm-feed-pop-shell--resizing': dmGiftPopResizing,
            }"
            :style="giftFloatedShellStyle"
          >
            <div class="dm-feed-pop-head">
              <span
                class="dm-feed-pop-drag"
                title="拖动"
                @pointerdown="onGiftPopShellDragPointerDown"
              >⠿ 礼物记录</span>
              <button
                type="button"
                class="dm-btn dm-btn--xs dm-btn--primary"
                @click.stop="closeGiftPanelPopout"
              >嵌回画布</button>
              <div class="dm-gift-header dm-gift-header--parity dm-gift-header--pop-shell">
                <div class="dm-gift-header-toolbar dm-column-head-toolbar">
                  <div class="dm-column-head-toolbar__start dm-column-head-toolbar__start--gift">
                    <div class="dm-toolbar-row-first">
                      <div class="dm-toolbar-menu-lead dm-toolbar-menu-lead--gift">
                        <nav class="dm-gift-tabs dm-gift-tabs--inline dm-gift-tabs--toolbar">
                          <button type="button" :class="{ active: giftSubTab === 'records' }" @click="giftSubTab = 'records'">记录</button>
                          <button type="button" :class="{ active: giftSubTab === 'stats' }" @click="giftSubTab = 'stats'">统计</button>
<button v-if="isDev" type="button" class="dm-gift-tab-debug" :class="{ active: giftSubTab === 'debug' }" title="下行原始字段与计件明细（调试）" @click="giftSubTab = 'debug'">调试</button>
                          </nav>
                          <label class="dm-check dm-check--toolbar dm-check--toolbar-free-scroll" title="有新礼物时自动滚到底"><input v-model="giftAutoScroll" type="checkbox" /> 自动滚动</label>
                        </div>
                      <div class="dm-toolbar-mode-cluster">
                        <div class="dm-toolbar-mode-cluster-actions">
                          <button
                            v-if="giftSubTab === 'records' || giftSubTab === 'debug'"
                            type="button"
                            class="dm-toolbar-soft-btn"
                            title="重新拉取礼物记录"
                            @click="backendSelectedRoom && loadGiftsForRoom(backendSelectedRoom)"
                          >
                            刷新
                          </button>
                          <button
                            v-else-if="giftSubTab === 'stats'"
                            type="button"
                            class="dm-toolbar-soft-btn"
                            title="刷新礼物统计"
                            @click="backendSelectedRoom && loadGiftStats(backendSelectedRoom, giftStatsRange)"
                          >
                            刷新
                          </button>
                        </div>
                        <div class="dm-toolbar-layout-slot">
                          <DmToolbarMenuSelect
                            :model-value="giftColumnMode"
                            variant="layout"
                            :options="COLUMN_LAYOUT_OPTS"
                            aria-label="礼物栏布局"
                            title="礼物栏布局：固定 / 自由 / 弹出"
                            @update:model-value="onGiftLayoutMenuPick"
                          />
                        </div>
                      </div>
                    </div>
                    <div v-if="giftSubTab === 'records' || giftSubTab === 'debug'" class="dm-toolbar-search-slot">
                      <div class="dm-danmu-search dm-danmu-search--toolbar dm-search-pill">
                        <div class="dm-search-pill__mode-slot">
                          <DmToolbarMenuSelect
                            v-model="giftSearchMode"
                            variant="pill"
                            :options="GIFT_SEARCH_MODE_OPTS"
                            aria-label="礼物记录筛选方式"
                          />
                        </div>
                        <input
                          v-model="giftSearchQuery"
                          type="search"
                          class="dm-search-pill__q"
                          placeholder="筛选礼物记录…"
                          enterkeyhint="search"
                          aria-label="礼物筛选关键字"
                        />
                          <span class="dm-search-pill__ico" aria-hidden="true">🔍</span>
                        </div>
                      </div>
                  </div>
                </div>
                <div v-if="giftSubTab === 'stats'" class="dm-gift-header-range-row">
                  <div class="dm-gift-range-group dm-gift-range-group--stretch">
                    <button
                      v-for="r in GIFT_STATS_RANGES"
                      :key="'gift-pop-' + r.value"
                      type="button"
                      class="dm-gift-range-btn"
                      :class="{ active: giftStatsRange === r.value }"
                      @click="giftStatsRange = r.value"
                    >
                      {{ r.label }}
                    </button>
                  </div>
                </div>
              </div>
              <div class="dm-gift-body">
                <div v-if="giftSubTab === 'records'" ref="giftFeedPopRef" class="dm-gift-feed">
                  <div v-if="giftList.length === 0" class="dm-empty">暂无礼物记录</div>
                  <div v-else-if="giftFilteredList.length === 0" class="dm-empty">无匹配的礼物记录（可换一种筛选方式或清空关键字）</div>
                  <div v-for="(g, idx) in giftFilteredList" :key="'gift-pop-' + idx" class="dm-gift-item" :class="{ 'dm-gift--big': g.bg === '1' }">
                    <span class="dm-time">{{ formatTime(g.ts) }}</span>
                    <span
                      v-if="g.level != null && String(g.level).trim() !== ''"
                      class="dm-chat-pill dm-ulv-el"
                      :class="userLevelQualityClass(String(g.level))"
                    >
                      <span class="dm-chat-pill-ulv-num">{{ g.level }}</span>
                    </span>
                    <span
                      v-if="g.bnn"
                      class="dm-chat-pill dm-fan-el dm-fan-clickable"
                      :class="fanMedalQualityClass(g.bl)"
                      @click="openBridRoom(g.brid || g.rid || g.roomId || '')">
                      <span class="dm-fan-seg dm-fan-seg--lv">
                        <span class="dm-fan-lv-inner">
                          <span v-if="g.bl" class="dm-chat-pill-lv">{{ g.bl }}</span>
                        </span>
                      </span>
                      <span class="dm-fan-seg dm-fan-seg--nm">
                        <span class="dm-chat-pill-bnn">{{ g.bnn }}</span>
                      </span>
                    </span>
<span class="dm-gift-nick" @mouseenter="showUidTooltip($event, g.uid)" @mouseleave="hideUidTooltip()" @click="openUserPage(g.nn)">{{ g.nn || '' }}</span>
                      <span class="dm-gift-name">{{ giftRowDisplayName(g) }}</span>
                    <span class="dm-gift-cnt">×{{ giftPiecesAggregateCount(g) }}</span>
                  </div>
                </div>
                <div v-if="giftSubTab === 'stats'" class="dm-gift-stats">                  <div v-if="giftStatsLoading" class="dm-empty">加载中...</div>
                  <template v-else-if="giftStats">
                    <div class="dm-gift-stats-summary">
                      <div class="dm-gift-stats-card">
                        <span class="dm-gift-stats-label">总数量</span>
                        <span class="dm-gift-stats-value">{{ giftStats.totalCount }}</span>
                      </div>
                      <div class="dm-gift-stats-card" :title="GIFT_STATS_TOTAL_COST_HINT">
                        <span class="dm-gift-stats-label">收入</span>
                        <span class="dm-gift-stats-value dm-gift-stats-value--gold">{{ giftStatsTotalCost.toFixed(1) }}元</span>
                      </div>
                      <div class="dm-gift-stats-card">
                        <span class="dm-gift-stats-label">花费</span>
                        <span class="dm-gift-stats-value dm-gift-stats-value--cost">{{ giftStatsTotalSpend.toFixed(1) }}元</span>
                      </div>
                      <div class="dm-gift-stats-card">
                        <span class="dm-gift-stats-label">送礼人数</span>
                        <span class="dm-gift-stats-value">{{ giftStatsByUserSorted.length }}</span>
                      </div>
                    </div>
                    <div class="dm-gift-stats-section">
                        <div class="dm-gift-stats-table">
                        <div class="dm-gift-stats-thead">
                          <span class="dm-gift-stats-th dm-gift-stats-th--icon"></span>
                          <span class="dm-gift-stats-th dm-gift-stats-th--name">礼物</span>
                          <span class="dm-gift-stats-th dm-gift-stats-th--cnt">数量</span>
                          <span class="dm-gift-stats-th dm-gift-stats-th--revenue">收入</span>
                          <span class="dm-gift-stats-th dm-gift-stats-th--cost">花费</span>
                        </div>
                        <div v-for="item in giftStatsByGiftSorted" :key="'gift-pop-stats-g-' + item.gfid" class="dm-gift-stats-trow">
                          <span class="dm-gift-stats-td dm-gift-stats-td--icon">
                            <img v-if="item.icon" :src="item.icon" class="dm-gift-icon-sm" alt="" referrerpolicy="no-referrer" />
                            <span v-else class="dm-gift-icon-sm-placeholder">🎁</span>
                          </span>
                          <span class="dm-gift-stats-td dm-gift-stats-td--name">{{ item.name }}</span>
                          <span class="dm-gift-stats-td dm-gift-stats-td--cnt">×{{ item.count }}</span>
                          <span class="dm-gift-stats-td dm-gift-stats-td--revenue">{{ item.isPaid && item.value ? (item.value * item.count).toFixed(1) : '-' }}</span>
                          <span class="dm-gift-stats-td dm-gift-stats-td--cost">{{ item.isPaid && item.cost ? (item.cost * item.count).toFixed(1) : '-' }}</span>
                        </div>
                      </div>
                      <div v-if="giftStatsByGiftSorted.length === 0" class="dm-empty">暂无数据</div>
                    </div>
                    <div class="dm-gift-stats-section">
                        <div class="dm-gift-stats-user-table">
                        <div class="dm-gift-stats-user-thead">
                          <span class="dm-gift-stats-uth dm-gift-stats-uth--user">用户</span>
                          <span class="dm-gift-stats-uth dm-gift-stats-uth--revenue">收入</span>
                          <span class="dm-gift-stats-uth dm-gift-stats-uth--cost">花费</span>
                        </div>
                        <div v-for="item in giftStatsByUserSorted" :key="'gift-pop-stats-u-' + item.uid" class="dm-gift-stats-utrow">
                          <span class="dm-gift-stats-utd dm-gift-stats-utd--user">
                            <span
                              v-if="item.level"
                              class="dm-chat-pill dm-ulv-el"
                              :class="userLevelQualityClass(String(item.level))"
                            >
                              <span class="dm-chat-pill-ulv-num">{{ item.level }}</span>
                            </span>
<span class="dm-gift-stats-user-nick" @mouseenter="showUidTooltip($event, item.uid)" @mouseleave="hideUidTooltip()" @click="openUserPage(item.nn || item.uid)">{{ item.nn || item.uid }}</span>
                          </span>
                          <span class="dm-gift-stats-utd dm-gift-stats-utd--revenue">{{ item.totalValue ? item.totalValue.toFixed(1) : '-' }}</span>
                          <span class="dm-gift-stats-utd dm-gift-stats-utd--cost">{{ item.totalCost ? item.totalCost.toFixed(1) : '-' }}</span>
                        </div>
                      </div>
                      <div v-if="giftStatsByUserSorted.length === 0" class="dm-empty">暂无数据</div>
                    </div>
                  </template>
                  <div v-else class="dm-empty">点击刷新加载统计</div>
                </div>
                <div v-if="giftSubTab === 'debug'" class="dm-gift-feed dm-gift-debug-feed">
                  <div v-if="giftList.length === 0" class="dm-empty">暂无礼物记录</div>
                  <template v-else>
                    <p class="dm-gift-debug-lead">
                      「计入件」与服务器汇总一致：仅取下行的 <code class="dm-gift-debug-code">gfcnt</code>（当次礼物个数，向下取整）；缺失或非法时按 <code class="dm-gift-debug-code">1</code>，<strong>不乘</strong>
                        hits、gs。下列为当前<strong>筛选</strong>结果，自上而下为<strong>新 → 旧</strong>。<strong>gfid</strong>＝斗鱼礼物 id；<strong>gfn</strong>＝本条下行名称；可与下方「查找表」中礼单名称对照。<strong>礼单价(值)</strong>按 gfid 查当前房间礼单缓存，列表头悬停见详解。下行<strong>完整 JSON</strong>仅在新窗口<strong>打开</strong>查看。
                      </p>
                    <details class="dm-gift-debug-lookup">
                        <summary class="dm-gift-debug-lookup-sum">礼物信息查找表（gfid → 开销(元)／价值(元)）</summary>
                      <p class="dm-gift-debug-lookup-note" :title="GIFT_CATALOG_VALUE_HINT">
                          等价于前端 <strong>giftInfoMap[gfid]</strong>：服务端 <code class="dm-gift-debug-code">GET /gift-list/:房间</code> 拉斗鱼 CDN 清单后写入的映射；<strong>from</strong> 列：<strong>1·直接</strong>／<strong>2·背包</strong>；表中
                          <strong>开销(元)</strong>（giftInfo.cost，已换算为元）与<strong>价值(元)</strong>（giftInfo.value，已换算为元）及<strong>礼单价摘要</strong>同源（列表头悬停）。末列<strong>打开</strong>在新窗口查看该 gfid 的 CDN 本条 JSON（无 <code class="dm-gift-debug-code">raw</code> 时为映射快照）。
                      </p>
                      <div v-if="giftInfoLoading" class="dm-gift-debug-lookup-msg">礼单加载中…</div>
                      <template v-else-if="giftCatalogLookupRows.length">
                        <div class="dm-gift-debug-catalog-scroll">
                          <table class="dm-gift-debug-catalog-table">
                            <thead>
                              <tr>
                                <th>gfid</th>
                                <th :title="GIFT_FROM_HINT">from</th>
                                <th>礼单名</th>
<th title="giftInfo.cost：单次礼物开销(元)，已由服务器换算(price/100)">开销(元)</th>
                                <th title="giftInfo.value：单次礼物价值，人民币元">价值(元)</th>
                                <th>图标</th>
                                <th class="dm-gift-debug-catalog-th-open" title="在新窗口查看 gift/v3 本条 CDN 原生 JSON（无 raw 时为快照）">打开</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr v-for="row in giftCatalogLookupRows" :key="'gcatdbg_' + row.gfid">
                                <td class="dm-gift-debug-td-num">{{ row.gfid }}</td>
                                <td class="dm-gift-debug-td-num dm-gift-debug-td-nowrap" :title="GIFT_FROM_HINT">{{ row.fromLabel }}</td>
                                <td class="dm-gift-debug-td-ell" :title="row.name">{{ row.name }}</td>
                                <td class="dm-gift-debug-td-num">{{ row.cost }}</td>
                                <td class="dm-gift-debug-td-num">{{ row.value }}</td>
                                <td class="dm-gift-debug-catalog-img-cell">
                                  <img v-if="row.icon" :src="row.icon" class="dm-gift-debug-catalog-icon" alt="" referrerpolicy="no-referrer" />
                                  <span v-else class="dm-gift-debug-lookup-dash">—</span>
                                </td>
                                <td class="dm-gift-debug-catalog-open-cell">
                                  <button
                                    type="button"
                                    class="dm-gift-debug-json-hit dm-gift-debug-catalog-json-hit"
                                    title="新窗口格式化 JSON（与 dgb「打开」相同交互）"
                                    @click.stop="openGiftCatalogRawWindow(row.gfid)"
                                  >
                                    打开
                                  </button>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </template>
                      <div v-else class="dm-gift-debug-lookup-msg">暂无礼单缓存（打开礼物分区或载入统计时会拉取）。</div>
                    </details>
                    <details class="dm-gift-debug-lookup">
                      <summary class="dm-gift-debug-lookup-sum">背包／道具 prop_gift_config 对照（本房 CDN from=2）</summary>
                      <p class="dm-gift-debug-lookup-note" :title="GIFT_PROP_TABLE_HINT">
                        数据源 <code class="dm-gift-debug-code">webconf.douyucdn.cn · prop_gift_config.json</code>（JSONP）。以下为<strong>本房间 gift/v3</strong>中带 <strong>from=2</strong> 的 gfid；全站条目数见表下脚注。<strong>pc</strong>／<strong>devote</strong> 与覆写后的
                        <code class="dm-gift-debug-code">giftInfo.cost</code>／<code class="dm-gift-debug-code">giftInfo.value</code>同源。<strong>打开</strong>为配置本条 JSON。
                      </p>
                      <div v-if="giftInfoLoading" class="dm-gift-debug-lookup-msg">礼单加载中…</div>
                      <template v-else-if="giftPropCatalogRows.length">
                        <div class="dm-gift-debug-catalog-scroll">
                          <table class="dm-gift-debug-catalog-table">
                            <thead>
                              <tr>
                                <th>gfid</th>
                                <th title="配置文件 type（斗鱼分类）">type</th>
                                <th>配置名</th>
                                <th title="prop.pc → giftInfo.cost">pc</th>
                                <th title="prop.devote → giftInfo.value">devote</th>
                                <th title="是否在 prop 全表命中该行">命中</th>
                                <th>图标</th>
                                <th class="dm-gift-debug-catalog-th-open" title="新窗口本条 prop JSON">打开</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr v-for="row in giftPropCatalogRows" :key="'gpropdbg_bp_' + row.gfid">
                                <td class="dm-gift-debug-td-num">{{ row.gfid }}</td>
                                <td class="dm-gift-debug-td-num">{{ row.type ?? "—" }}</td>
                                <td class="dm-gift-debug-td-ell" :title="row.name">{{ row.name || "—" }}</td>
                                <td class="dm-gift-debug-td-num">{{ row.pc }}</td>
                                <td class="dm-gift-debug-td-num">{{ row.devote }}</td>
                                <td class="dm-gift-debug-td-nowrap" :title="GIFT_PROP_OVERLAY_HINT">{{ row.overlaidFromProp ? "是" : "否" }}</td>
                                <td class="dm-gift-debug-catalog-img-cell">
                                  <img v-if="row.icon" :src="row.icon" class="dm-gift-debug-catalog-icon" alt="" referrerpolicy="no-referrer" />
                                  <span v-else class="dm-gift-debug-lookup-dash">—</span>
                                </td>
                                <td class="dm-gift-debug-catalog-open-cell">
                                  <button
                                    type="button"
                                    class="dm-gift-debug-json-hit dm-gift-debug-catalog-json-hit"
                                    title="新窗口本条 prop JSON"
                                    @click.stop="openGiftPropRawWindow(row.gfid)"
                                  >
                                    打开
                                  </button>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </template>
                      <div v-else class="dm-gift-debug-lookup-msg">{{ giftPropCatalogEmptyTip }}</div>
                      <p
                        v-if="!giftInfoLoading && giftBackpackCatalogStats.propConfigOk"
                        class="dm-gift-debug-lookup-note dm-gift-debug-prop-meta"
                      >
                        prop 静态表合计约 <strong>{{ giftBackpackCatalogStats.totalPropKeys }}</strong> 个 gfid；本房间礼单中带
                        <strong>from=2</strong>
                        {{ giftBackpackCatalogStats.roomBackpackGiftIds }} 条；其中在全站 prop 命中并覆写刻度
                        <strong>{{ giftBackpackCatalogStats.overlaidFromPropCount }}</strong> 条。
                      </p>
                    </details>
                    <div class="dm-gift-debug-table-scroll">
                      <table class="dm-gift-debug-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>时间</th>
                            <th>ts(ms)</th>
                            <th title="斗鱼礼物 ID；礼单计价与归档统计均以 gfid 为键">gfid</th>
                            <th title="斗鱼下行本条礼物名；界面展示优先用它">gfn</th>
                            <th title="本次 dgb 礼物个数（单笔，下行原始）">gfcnt</th>
                            <th title="与服务端 giftPiecesFromStoredRecord 一致：仅 gfcnt，缺省时按 1">计入件</th>
<th :title="GIFT_CATALOG_VALUE_HINT">礼单价(值)</th>
                            <th>昵称</th>
                            <th>uid</th>
                            <th>bg</th>
                            <th>rid</th>
                            <th>lv</th>
                            <th>牌名</th>
                            <th>bl</th>
                            <th>brid</th>
                            <th class="dm-gift-debug-th-json" title="完整 JSON 仅在新窗口查看">打开</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr v-for="(g, ix) in giftDebugRows" :key="'gdk_pp_' + ix + '_' + String(g.ts)">
                            <td class="dm-gift-debug-td-num">{{ ix + 1 }}</td>
                            <td class="dm-gift-debug-td-nowrap">{{ formatTime(g.ts) }}</td>
                            <td class="dm-gift-debug-td-num">{{ g.ts }}</td>
                            <td class="dm-gift-debug-td-num">{{ g.gfid ?? "—" }}</td>
                            <td class="dm-gift-debug-td-ell dm-gift-debug-td-gfn" :title="String(g.gfn ?? '')">{{ g.gfn != null && String(g.gfn).trim() !== '' ? g.gfn : '—' }}</td>
                            <td class="dm-gift-debug-td-num">{{ g.gfcnt ?? "—" }}</td>
                            <td class="dm-gift-debug-td-num dm-gift-debug-td-strong">{{ giftPiecesAggregateCount(g) }}</td>
                            <td class="dm-gift-debug-td-nowrap" :title="GIFT_CATALOG_VALUE_HINT">{{ giftCatalogUnitDisplay(String(g.gfid ?? "")) }}</td>
                            <td class="dm-gift-debug-td-ell" :title="String(g.nn ?? '')">{{ g.nn ?? "—" }}</td>
                            <td class="dm-gift-debug-td-ell">{{ g.uid ?? "—" }}</td>
                            <td class="dm-gift-debug-td-num">{{ g.bg ?? "—" }}</td>
                            <td class="dm-gift-debug-td-ell">{{ g.rid ?? "—" }}</td>
                            <td class="dm-gift-debug-td-num">{{ g.level ?? "—" }}</td>
                            <td class="dm-gift-debug-td-ell">{{ g.bnn ?? "—" }}</td>
                            <td class="dm-gift-debug-td-num">{{ g.bl ?? "—" }}</td>
                            <td class="dm-gift-debug-td-ell">{{ g.brid ?? "—" }}</td>
                            <td class="dm-gift-debug-json-cell">
                              <button
                                type="button"
                                class="dm-gift-debug-json-hit"
                                title="仅在新浏览器窗口打开本条完整格式化 JSON（可复制）"
                                @click.stop="openGiftDebugJsonWindow(g)"
                              >
                                打开
                              </button>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </template>
                </div>
              </div>
            </div>
            <button
              type="button"
              class="dm-feed-pop-resize-br"
              aria-label="拖动右下角调整礼物窗口大小"
              title="拖动调整大小"
              @pointerdown.stop="onGiftPopShellResizePointerDown"
            ></button>
          </div>
        </Teleport>

        <div v-if="activeSubTab === 'triggers'" class="dm-trigger-section">
          <div class="dm-trigger-info">触发器匹配弹幕前缀，提取指令内容。格式：<code>#cmd 参数内容</code>，空格后的内容作为参数传入对应功能。</div>
          <div class="dm-trigger-add">
            <input v-model="newTriggerPattern" class="dm-input dm-input--sm" placeholder="前缀" style="width:80px" />
            <select v-model="newTriggerAction" class="dm-select dm-select--sm">
              <option v-for="opt in ACTION_OPTIONS" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
            </select>
            <input v-model="newTriggerDesc" class="dm-input dm-input--sm" placeholder="描述" style="flex:1" />
            <button class="dm-btn dm-btn--primary dm-btn--sm" @click="addTrigger">添加</button>
          </div>
          <div v-if="backendRooms.length > 0" class="dm-trigger-rooms-row">
            <span class="dm-trigger-rooms-label">绑定直播间：</span>
            <span v-for="room in backendRooms" :key="room.roomId" class="dm-trigger-room-chip" :class="{ active: newTriggerRoomIds.includes(room.roomId) }" @click="toggleNewTriggerRoom(room.roomId)">{{ room.info?.owner_name || room.roomId }}</span>
            <span v-if="newTriggerRoomIds.length === 0" class="dm-trigger-rooms-hint">不选则全部生效</span>
          </div>
          <div class="dm-trigger-list">
            <div v-if="triggers.length === 0" class="dm-empty">暂无触发器</div>
            <div v-for="t in triggers" :key="t.id" class="dm-trigger-item" :class="{ disabled: !t.enabled }">
              <button class="dm-toggle" @click="toggleTrigger(t)"><span :class="t.enabled ? 'toggle-on' : 'toggle-off'"></span></button>
              <div class="dm-trigger-body">
                <code class="dm-pattern">{{ t.pattern }}</code>
                <span class="dm-action-tag" :class="'dm-action--' + t.action">{{ actionLabel(t.action) }}</span>
                <span v-if="t.description" class="dm-trigger-desc">{{ t.description }}</span>
                <span v-if="t.roomIds && t.roomIds.length > 0" class="dm-trigger-bound-rooms">
                  <span v-for="rid in t.roomIds" :key="rid" class="dm-trigger-bound-chip" @click.stop="toggleRoomForTrigger(t, rid)">{{ roomLabel(rid) }} ×</span>
                </span>
                <span v-else class="dm-trigger-bound-all">全部直播间</span>
              </div>
              <div v-if="backendRooms.length > 0" class="dm-trigger-room-edit">
                <span v-for="room in backendRooms" :key="room.roomId" class="dm-trigger-room-chip dm-trigger-room-chip--sm" :class="{ active: t.roomIds && t.roomIds.includes(room.roomId) }" @click.stop="toggleRoomForTrigger(t, room.roomId)">{{ room.info?.owner_name || room.roomId }}</span>
              </div>
              <button class="dm-btn dm-btn--ghost dm-btn--sm" @click="deleteTrigger(t.id)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
            </div>
          </div>
        </div>

        <div v-if="activeSubTab === 'log'" class="dm-log-section">
          <div class="dm-log-toolbar"><span class="dm-log-count">{{ triggerLog.length }} 条</span><button class="dm-btn dm-btn--ghost dm-btn--sm" @click="clearActionLog">清空</button><button class="dm-btn dm-btn--ghost dm-btn--sm" @click="loadActionLog">刷新</button></div>
          <div class="dm-log-list">
            <div v-if="triggerLog.length === 0" class="dm-empty">暂无记录</div>
            <div v-for="(entry, idx) in triggerLog" :key="idx" class="dm-log-item"><span class="dm-time">{{ formatTime(entry.ts) }}</span><span class="dm-nick" @click="openUserPage(entry.nickname)">{{ entry.nickname }}</span><code class="dm-pattern">{{ entry.pattern }}</code><span class="dm-log-text">{{ entry.content }}</span></div>
          </div>
        </div>
      </template>
    </div>

    <!-- ==================== Song Request Panel ==================== -->
    <Teleport to="body">
      <div v-if="showSongPanel" class="dm-overlay" @click.self="showSongPanel = false">
        <div class="dm-stats-panel">
          <div class="dm-stats-header">
            <h3>🎵 点歌统计 <span v-if="songPanelRoomId" class="dm-stats-room">房间 {{ songPanelRoomId }}</span></h3>
            <div class="dm-stats-actions">
              <button class="dm-btn dm-btn--ghost dm-btn--sm" @click="loadSongData(songPanelRoomId!)">刷新</button>
              <button class="dm-stats-close" @click="showSongPanel = false">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
          </div>

          <!-- Song panel sub-tabs -->
          <nav class="dm-song-tabs">
            <button :class="{ active: songPanelTab === 'timeline' }" @click="songPanelTab = 'timeline'">🕐 按时间</button>
            <button :class="{ active: songPanelTab === 'session' }" @click="songPanelTab = 'session'">📋 当前统计</button>
            <button :class="{ active: songPanelTab === 'total' }" @click="songPanelTab = 'total'">📊 总统计</button>
          </nav>

          <div v-if="songPanelLoading" class="dm-empty">加载中…</div>

          <!-- Tab 1: Timeline -->
          <template v-else-if="songPanelTab === 'timeline'">
            <div class="dm-song-toolbar">
              <button class="dm-btn dm-btn--ghost dm-btn--sm" @click="songTimelineOrder = songTimelineOrder === 'desc' ? 'asc' : 'desc'">
                {{ songTimelineOrder === 'desc' ? '↓ 从近到远' : '↑ 从远到近' }}
              </button>
            </div>
            <div v-if="sortedTimeline.length === 0" class="dm-empty">暂无点歌记录</div>
            <div v-else class="dm-stats-table">
              <div class="dm-stats-row dm-stats-row--head">
                <span class="dm-stats-cell dm-stats-cell--time2">时间</span>
                <span class="dm-stats-cell dm-stats-cell--song">歌曲名</span>
                <span class="dm-stats-cell dm-stats-cell--artist">歌手</span>
                <span class="dm-stats-cell dm-stats-cell--requester">点歌人</span>
              </div>
              <div v-for="(item, idx) in sortedTimeline" :key="idx" class="dm-stats-row">
                <span class="dm-stats-cell dm-stats-cell--time2">{{ formatTime(item.ts) }}</span>
                <span class="dm-stats-cell dm-stats-cell--song"><strong>{{ item.song }}</strong></span>
                <span class="dm-stats-cell dm-stats-cell--artist">{{ item.artist || '-' }}</span>
                <span class="dm-stats-cell dm-stats-cell--requester">{{ item.nn || '-' }}</span>
              </div>
            </div>
          </template>

          <!-- Tab 2: Session stats -->
          <template v-else-if="songPanelTab === 'session'">
            <div class="dm-song-toolbar">
              <span class="dm-song-hint">当前会话统计，可手动清空</span>
              <button class="dm-btn dm-btn--ghost dm-btn--sm" @click="clearSessionStats">清空</button>
            </div>
            <div v-if="sortedSessionStats.length === 0" class="dm-empty">暂无统计数据</div>
            <div v-else class="dm-stats-table">
              <div class="dm-stats-row dm-stats-row--head">
                <span class="dm-stats-cell dm-stats-cell--count2">次数</span>
                <span class="dm-stats-cell dm-stats-cell--song">歌曲名</span>
                <span class="dm-stats-cell dm-stats-cell--artist">歌手</span>
                <span class="dm-stats-cell dm-stats-cell--requester">点歌人数</span>
              </div>
              <template v-for="item in sortedSessionStats" :key="item.key">
                <div class="dm-stats-row dm-stats-row--clickable" @click="toggleRequesters('session_' + item.key)">
                  <span class="dm-stats-cell dm-stats-cell--count2"><strong>{{ item.count }}</strong></span>
                  <span class="dm-stats-cell dm-stats-cell--song"><strong>{{ item.song }}</strong></span>
                  <span class="dm-stats-cell dm-stats-cell--artist">{{ item.artist || '-' }}</span>
                  <span class="dm-stats-cell dm-stats-cell--requester dm-stats-cell--expand">
                    <span class="dm-requester-badge">{{ item.requesters.length }}人</span>
                    <svg :class="{ rotated: expandedRequesters === 'session_' + item.key }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                  </span>
                </div>
                <div v-if="expandedRequesters === 'session_' + item.key" class="dm-requesters-dropdown">
                  <div v-for="(r, ri) in item.requesters" :key="ri" class="dm-requester-item">
                    <span class="dm-requester-name">{{ r.nn || '匿名' }}</span>
                    <span class="dm-requester-time">{{ formatTime(r.ts) }}</span>
                  </div>
                </div>
              </template>
            </div>
          </template>

          <!-- Tab 3: Total stats -->
          <template v-else-if="songPanelTab === 'total'">
            <div class="dm-song-toolbar">
              <span class="dm-song-hint">直播间累计总统计（不可清空）</span>
            </div>
            <div v-if="sortedTotalStats.length === 0" class="dm-empty">暂无统计数据</div>
            <div v-else class="dm-stats-table">
              <div class="dm-stats-row dm-stats-row--head">
                <span class="dm-stats-cell dm-stats-cell--count2">总次数</span>
                <span class="dm-stats-cell dm-stats-cell--song">歌曲名</span>
                <span class="dm-stats-cell dm-stats-cell--artist">歌手</span>
                <span class="dm-stats-cell dm-stats-cell--requester">点歌人数</span>
              </div>
              <template v-for="item in sortedTotalStats" :key="item.key">
                <div class="dm-stats-row dm-stats-row--clickable" @click="toggleRequesters('total_' + item.key)">
                  <span class="dm-stats-cell dm-stats-cell--count2"><strong>{{ item.count }}</strong></span>
                  <span class="dm-stats-cell dm-stats-cell--song"><strong>{{ item.song }}</strong></span>
                  <span class="dm-stats-cell dm-stats-cell--artist">{{ item.artist || '-' }}</span>
                  <span class="dm-stats-cell dm-stats-cell--requester dm-stats-cell--expand">
                    <span class="dm-requester-badge">{{ item.requesters.length }}人</span>
                    <svg :class="{ rotated: expandedRequesters === 'total_' + item.key }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
                  </span>
                </div>
                <div v-if="expandedRequesters === 'total_' + item.key" class="dm-requesters-dropdown">
                  <div v-for="(r, ri) in item.requesters" :key="ri" class="dm-requester-item">
                    <span class="dm-requester-name">{{ r.nn || '匿名' }}</span>
                    <span class="dm-requester-time">{{ formatTime(r.ts) }}</span>
                  </div>
                </div>
              </template>
            </div>
          </template>
        </div>
      </div>
    </Teleport>

    <!-- UID Tooltip Bubble -->
    <Teleport to="body">
      <Transition name="dm-uid-tip">
        <div
          v-if="uidTooltip.visible"
          class="dm-uid-tooltip"
          :style="{ left: uidTooltip.x + 'px', top: uidTooltip.y + 'px' }"
        >{{ uidTooltip.text }}</div>
      </Transition>
    </Teleport>
  </section>
</template>

<style scoped>
/* ================================================================== */
/*  窃听宝语 — Modern glassmorphism UI                               */
/* ================================================================== */

.dm-panel {
  padding: 1rem 1.25rem 1.25rem;
  max-width: min(720px, 100%);
  margin: 0 auto;
  /* 面板内按钮/标签统一字色（随主题变量） */
  --dm-ui-muted: color-mix(in srgb, var(--muted) 72%, var(--text));
  --dm-ui-soft: color-mix(in srgb, var(--muted) 82%, var(--text));
  --dm-ui-body: var(--text);
  --dm-ui-strong: color-mix(in srgb, var(--primary) 82%, var(--text));
  --dm-ui-accent: color-mix(in srgb, var(--primary) 74%, var(--text));
  --dm-trigger-label: color-mix(in srgb, var(--primary) 44%, var(--text));
  --dm-trigger-label-hover: color-mix(in srgb, var(--primary) 58%, var(--text));
}

/* ---- Lock screen ---- */
.dm-lock {
  text-align: center; padding: 3.5rem 1rem; color: var(--muted);
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, #fff 6%, var(--border));
  background: color-mix(in srgb, var(--surface) 52%, transparent);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
}
.dm-lock-icon { margin-bottom: 1rem; opacity: 0.3; }
.dm-lock-icon svg { stroke: var(--muted); }
.dm-lock p { margin: 0 0 1.25rem; font-size: 0.92rem; font-weight: 500; }
.dm-lock-row { display: flex; gap: 0.5rem; justify-content: center; }

/* ---- Add room row (capsule search bar) ---- */
.dm-add-row {
  display: flex; gap: 0; align-items: stretch; margin-bottom: 0.85rem;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: color-mix(in srgb, var(--surface) 70%, var(--bg));
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  box-shadow: inset 0 1px 1px rgba(0,0,0,0.05);
  overflow: hidden; min-height: 2.5rem;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.dm-add-row:focus-within {
  border-color: color-mix(in srgb, var(--primary) 50%, var(--border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent),
              inset 0 1px 1px rgba(0,0,0,0.04);
}
.dm-add-row .dm-input {
  flex: 1; min-width: 0; width: 100%; border: none; border-radius: 0;
  background: transparent; padding: 0.5rem 0.85rem; font-size: 0.84rem;
  font-family: inherit;
  outline: none; box-shadow: none; color: var(--dm-ui-body);
}
.dm-add-row .dm-input::placeholder { color: var(--dm-ui-muted); opacity: 0.78; }
.dm-add-row .dm-input:focus { box-shadow: none; border-color: transparent; }
.dm-add-row .dm-btn {
  flex-shrink: 0; border: none;
  border-radius: 0 999px 999px 0;
  background: var(--primary) !important;
  padding: 0 1.1rem; font-size: 0.82rem;
  color: var(--on-primary) !important;
  font-weight: 700; letter-spacing: 0.02em;
  cursor: pointer; position: relative;
  transition: background 0.18s, box-shadow 0.18s;
  filter: none !important;
  box-shadow: none;
}
.dm-add-row .dm-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--primary) 80%, #000) !important;
  box-shadow: 0 3px 12px color-mix(in srgb, var(--primary) 50%, transparent) !important;
  color: var(--on-primary) !important;
  filter: none !important;
}
.dm-add-row .dm-btn:active:not(:disabled) {
  background: color-mix(in srgb, var(--primary) 70%, #000) !important;
}
.dm-add-row .dm-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ---- Room chips ---- */
.dm-room-list { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 0.85rem; }
.dm-room-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 12px; border-radius: 999px;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: color-mix(in srgb, var(--surface) 70%, var(--bg));
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  cursor: pointer; font-size: 0.78rem; color: var(--text);
  transition: all 0.18s; user-select: none;
}
.dm-room-chip:hover {
  border-color: color-mix(in srgb, var(--primary) 40%, var(--border));
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(0,0,0,0.08);
}
.dm-room-chip.selected {
  border-color: color-mix(in srgb, var(--primary) 40%, var(--border));
  background: color-mix(in srgb, var(--primary) 14%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary) 18%, transparent);
}
.dm-chip-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.dm-chip-dot.connected { background: #22c55e; box-shadow: 0 0 5px #22c55e88; }
.dm-chip-dot.connecting { background: #f59e0b; animation: pulse 1s infinite; }
.dm-chip-dot.disconnected { background: #94a3b8; }
.dm-chip-name { max-width: 100px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.dm-chip-live {
  font-size: 0.56rem; font-weight: 700; color: #fff;
  background: linear-gradient(135deg, #22c55e, #16a34a);
  padding: 1px 6px; border-radius: 4px; letter-spacing: 0.5px;
  box-shadow: 0 1px 3px rgba(34,197,94,0.3);
}
.dm-chip-count { font-size: 0.65rem; color: var(--muted); font-variant-numeric: tabular-nums; }
.dm-chip-close { border: none; background: transparent; color: var(--muted); cursor: pointer; padding: 0; line-height: 0; border-radius: 50%; transition: color 0.15s; }
.dm-chip-close:hover { color: #ef4444; }

/* ---- Room info card (glassmorphism) ---- */
.dm-room-card {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.75rem 1rem; margin-bottom: 0.85rem;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, #fff 10%, var(--border));
  background: linear-gradient(195deg,
    color-mix(in srgb, var(--primary) 10%, transparent) 0%,
    color-mix(in srgb, var(--bg) 30%, transparent) 55%,
    color-mix(in srgb, var(--surface) 40%, transparent) 100%);
  box-shadow: 0 4px 20px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.06);
  backdrop-filter: blur(20px) saturate(1.2);
  -webkit-backdrop-filter: blur(20px) saturate(1.2);
}
.dm-room-avatar {
  width: 42px; height: 42px; border-radius: 50%; object-fit: cover; flex-shrink: 0;
  border: 2px solid color-mix(in srgb, #fff 10%, var(--border));
}
.dm-room-body { flex: 1; min-width: 0; }
.dm-room-title { font-size: 0.9rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: 0.01em; }
.dm-room-meta { display: flex; flex-wrap: wrap; gap: 0.4rem 0.75rem; margin-top: 3px; font-size: 0.73rem; color: var(--muted); align-items: center; }
.dm-meta-tag {
  font-size: 0.62rem; font-weight: 600; color: var(--muted);
  background: color-mix(in srgb, #fff 5%, transparent);
  padding: 1px 6px; border-radius: 4px;
  border: 1px solid color-mix(in srgb, #fff 6%, var(--border));
}
.dm-meta-live { color: var(--accent); font-weight: 700; font-size: 0.72rem; }

/* ---- Stats bar ---- */
.dm-stats-bar {
  display: flex; gap: 1.25rem; font-size: 0.78rem; color: var(--muted);
  margin-bottom: 0.75rem; padding: 0 0.25rem;
}
.dm-stats-bar strong { color: var(--text); font-variant-numeric: tabular-nums; }

/* ---- Inputs & buttons ---- */
.dm-input {
  padding: 0.45rem 0.75rem;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 70%, var(--bg));
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  color: var(--dm-ui-body);
  font-family: inherit;
  font-size: 0.85rem;
  outline: none;
  width: 140px;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.dm-input::placeholder { color: var(--dm-ui-muted); opacity: 0.78; }
.dm-input:focus {
  border-color: color-mix(in srgb, var(--primary) 50%, var(--border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent);
}
.dm-input--sm { padding: 0.35rem 0.6rem; font-size: 0.8rem; font-family: inherit; }
.dm-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 0.45rem 0.9rem; border-radius: 10px;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: color-mix(in srgb, var(--surface) 50%, transparent);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  color: var(--dm-ui-body);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.82rem; font-weight: 500;
  white-space: nowrap; transition: all 0.15s;
}
.dm-btn:hover {
  border-color: color-mix(in srgb, var(--primary) 40%, var(--border));
  color: var(--dm-ui-accent);
  background: color-mix(in srgb, var(--primary) 8%, transparent);
}
.dm-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  color: var(--dm-ui-muted);
}
.dm-btn--primary {
  background: linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary) 80%, #000));
  color: var(--on-primary); border-color: color-mix(in srgb, #fff 15%, var(--primary));
  box-shadow: 0 2px 8px color-mix(in srgb, var(--primary) 30%, transparent);
}
.dm-btn--primary:hover { filter: brightness(1.1); color: var(--on-primary); }
.dm-btn--ghost {
  border-color: transparent;
  background: transparent;
  backdrop-filter: none;
  color: var(--dm-ui-soft);
}
.dm-btn--ghost:hover {
  border-color: transparent;
  color: var(--dm-ui-strong);
  background: color-mix(in srgb, var(--text) 6%, transparent);
}
.dm-btn--outline {
  border: 1.5px solid color-mix(in srgb, var(--primary) 50%, var(--border));
  background: color-mix(in srgb, var(--primary) 6%, transparent);
  color: var(--dm-ui-strong); font-weight: 600; backdrop-filter: none;
}
.dm-btn--outline:hover {
  border-color: var(--primary);
  background: color-mix(in srgb, var(--primary) 14%, transparent);
  color: var(--dm-ui-strong);
  box-shadow: 0 1px 6px color-mix(in srgb, var(--primary) 20%, transparent);
}
.dm-btn--sm { padding: 0.3rem 0.6rem; font-size: 0.75rem; font-weight: 500; }
.dm-error { color: var(--danger, #ff6b6b); font-size: 0.8rem; margin: 0.35rem 0; }

/* ---- 顶区：弹幕/礼物切换 + 子标签 — 挤压时收紧字号与间距 ---- */
.dm-panel-subnav {
  container-type: inline-size;
  container-name: dm-subnav;
  display: flex;
  flex-direction: column;
  gap: 0.36rem;
  margin-bottom: 0.62rem;
}
/* ---- Sub-tabs (pill style) ---- */
.dm-tabs {
  display: flex; gap: 3px;
  padding: 2px; border-radius: 10px;
  background: color-mix(in srgb, var(--text) 5%, transparent);
  border: 1px solid color-mix(in srgb, #fff 4%, var(--border));
}
.dm-tabs button {
  flex: 1;
  min-width: 0;
  padding: clamp(0.26rem, 0.08rem + 0.65vw, 0.41rem) clamp(0.4rem, 0.06rem + 1.05vw, 0.74rem);
  border: none; background: transparent;
  color: var(--dm-ui-muted); cursor: pointer;
  font-family: inherit;
  font-size: clamp(0.68rem, 0.15vw + 0.63rem, 0.79rem);
  font-weight: 600;
  border-radius: 8px; transition: all 0.2s; white-space: nowrap;
}
.dm-tabs button.active {
  background: var(--surface); color: var(--dm-ui-body);
  box-shadow: 0 1px 4px rgba(0,0,0,0.1), 0 0 0 1px color-mix(in srgb, #fff 8%, var(--border));
}
.dm-tabs button:hover:not(.active) { color: var(--dm-ui-body); background: color-mix(in srgb, #fff 3%, transparent); }

@container dm-subnav (max-width: 420px) {
  .dm-bench-vis-btn {
    padding: 0.22rem 0.36rem !important;
    font-size: clamp(0.65rem, 0.62rem + 0.3vw, 0.73rem) !important;
    white-space: nowrap;
    max-width: 100%;
  }
  .dm-tabs button {
    padding: 0.26rem 0.42rem;
    font-size: 0.68rem;
  }
}
.dm-badge {
  font-size: 0.56rem; font-weight: 700; color: var(--on-primary);
  background: linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary) 70%, #000));
  border-radius: 6px; padding: 1px 5px; margin-left: 3px; vertical-align: super;
}

/* ---- Feed (glassmorphism card) ---- */
.dm-feed-section {
  display: flex;
  flex-direction: column;
}

.dm-bench-visibility-strip {
  display: flex;
  align-items: stretch;
  gap: 6px;
  margin-bottom: 0.5rem;
  padding: 6px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, #fff 10%, var(--border));
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--surface) 62%, transparent) 0%,
    color-mix(in srgb, var(--surface) 42%, var(--bg) 58%) 100%
  );
  box-sizing: border-box;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

.dm-bench-vis-btn {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 0.32rem 0.5rem;
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, #fff 12%, var(--border));
  background: color-mix(in srgb, var(--bg) 35%, transparent);
  color: var(--dm-ui-muted);
  font-family: inherit;
  font-size: 0.74rem;
  font-weight: 650;
  cursor: pointer;
  transition:
    background 0.14s ease,
    color 0.14s ease,
    border-color 0.14s ease,
    box-shadow 0.14s ease;
}

.dm-bench-vis-btn:hover {
  color: var(--dm-ui-body);
  background: color-mix(in srgb, var(--text) 8%, transparent);
}

.dm-bench-vis-btn--active {
  color: var(--dm-ui-strong);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--primary) 16%, var(--surface) 84%) 0%,
    color-mix(in srgb, var(--primary) 7%, var(--surface) 93%) 100%
  );
  border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
  box-shadow:
    0 1px 4px rgba(0, 0, 0, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.12);
}

.dm-feed-embed-slot {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

.dm-feed-bench-root {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.dm-feed-bench-root--free {
  min-height: min(520px, 72vh);
}

.dm-danmaku-stack--fixed-h {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  align-self: stretch;
}
.dm-danmaku-stack--fill-free {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.dm-feed.dm-feed--fills-stack {
  flex: 1 1 auto;
  min-height: 0;
  height: auto !important;
  max-height: none;
}

.dm-gift-panel.dm-gift-panel--free-overlay {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.dm-gift-panel.dm-gift-panel--free-overlay .dm-gift-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.dm-column-float {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, #fff 10%, var(--border));
  background: linear-gradient(
    195deg,
    color-mix(in srgb, var(--primary) 4%, transparent) 0%,
    color-mix(in srgb, var(--bg) 22%, transparent) 55%,
    color-mix(in srgb, var(--surface) 38%, transparent) 100%
  );
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.12);
  overflow: hidden;
  touch-action: none;
}

.dm-column-float--dragging {
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.16);
}

.dm-column-float-chrome {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0.32rem 0.48rem;
  cursor: grab;
  user-select: none;
  font-size: 0.74rem;
  font-weight: 650;
  color: color-mix(in srgb, var(--text) 88%, var(--muted));
  border-bottom: 1px solid color-mix(in srgb, #fff 6%, var(--border));
  background: color-mix(in srgb, var(--surface) 52%, transparent);
}

.dm-column-float-chrome:active,
.dm-column-float--dragging .dm-column-float-chrome {
  cursor: grabbing;
}

.dm-column-float-chrome-t {
  flex: 1;
  min-width: 0;
}

.dm-column-float-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.dm-column-float-body--gift {
  min-height: 0;
}

.dm-column-float-inner-fill {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.dm-column-float-resize-br {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 18px;
  height: 18px;
  z-index: 5;
  padding: 0;
  margin: 0;
  border: none;
  border-radius: 0;
  cursor: nwse-resize;
  touch-action: none;
  background: transparent;
}

.dm-column-float-resize-br:hover {
  background: color-mix(in srgb, var(--primary) 14%, transparent);
}

.dm-gift-stats-summary--compact {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 0.35rem 0.45rem;
  font-size: 0.74rem;
  color: var(--muted);
}
.dm-gift-stats-summary--compact strong {
  color: var(--text);
  margin-left: 3px;
}
/* Teleport body: 工作台浮动 / 右侧固定 */
.dm-feed-section.dm-feed-section--float-detached {
  box-sizing: border-box;
  min-height: 0;
  gap: 0;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, #fff 10%, var(--border));
  background: linear-gradient(
    195deg,
    color-mix(in srgb, var(--primary) 6%, transparent) 0%,
    color-mix(in srgb, var(--surface) 72%, var(--bg) 28%) 100%
  );
  box-shadow:
    0 16px 48px rgba(0, 0, 0, 0.14),
    0 0 0 1px color-mix(in srgb, #fff 6%, transparent);
  overflow: hidden;
  backdrop-filter: blur(12px) saturate(1.15);
  -webkit-backdrop-filter: blur(12px) saturate(1.15);
}
.dm-feed-section--float-detached .dm-feed-toolbar {
  flex-shrink: 0;
  padding-left: 0.55rem;
  padding-right: 0.55rem;
}
.dm-feed-section--float-detached .dm-feed-split {
  flex: 1;
  min-height: 0;
}
.dm-feed-section--wb-dragging {
  cursor: grabbing;
  user-select: none;
}
.dm-workbench-chrome {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  flex-shrink: 0;
  padding: 0.38rem 0.55rem;
  border-bottom: 1px solid color-mix(in srgb, #fff 6%, var(--border));
  background: color-mix(in srgb, var(--surface) 58%, transparent);
  user-select: none;
}
.dm-workbench-chrome-drag {
  cursor: grab;
  touch-action: none;
  padding: 0.15rem 0.4rem;
  margin: -0.15rem 0;
  border-radius: 8px;
  line-height: 1;
  font-size: 1rem;
  color: var(--muted);
  transition: background 0.12s, color 0.12s;
}
.dm-workbench-chrome-drag:hover:not(.dm-workbench-chrome-drag--inactive) {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text);
}
.dm-feed-section--wb-dragging .dm-workbench-chrome-drag:not(.dm-workbench-chrome-drag--inactive) {
  cursor: grabbing;
}
.dm-workbench-chrome-drag--inactive {
  opacity: 0.38;
  cursor: default;
  pointer-events: none;
}
.dm-workbench-chrome-title {
  flex: 1;
  min-width: 0;
  font-size: 0.78rem;
  font-weight: 650;
  color: color-mix(in srgb, var(--text) 90%, var(--muted));
  letter-spacing: -0.01em;
}
.dm-feed-toolbar { display: flex; align-items: center; gap: 0.5rem 0.75rem; margin-bottom: 0.5rem; }
.dm-feed-toolbar--wrap {
  flex-wrap: wrap;
  align-items: center;
}
.dm-feed-toolbar-spacer {
  flex: 1 0 72px;
  min-width: 48px;
}
.dm-danmaku-stack {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  align-self: stretch;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: linear-gradient(
    195deg,
    color-mix(in srgb, var(--primary) 4%, transparent) 0%,
    color-mix(in srgb, var(--bg) 25%, transparent) 55%,
    color-mix(in srgb, var(--surface) 40%, transparent) 100%
  );
  box-shadow:
    0 4px 20px rgba(0, 0, 0, 0.1),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
}

.dm-danmaku-split-head {
  flex-shrink: 0;
  padding: 0.34rem 0.45rem;
  border-bottom: 1px solid color-mix(in srgb, #fff 6%, var(--border));
  background: color-mix(in srgb, var(--surface) 46%, transparent);
}

.dm-danmaku-split-head-toolbar {
  margin-bottom: 0;
}

/* 弹幕 / 礼物栏工具条：首行左侧操作 + 右侧布局下拉；第二行胶囊筛选（对齐忽闻宝声） */
.dm-column-head-toolbar.dm-gift-header-toolbar,
.dm-column-head-toolbar.dm-danmaku-split-head-toolbar {
  container-type: inline-size;
  container-name: dm-col-toolbar;
  display: flex;
  flex-wrap: nowrap;
  align-items: stretch;
  min-width: 0;
  width: 100%;
  /* 两栏共用：字号、行高；行高不用 cqw，避免固定分列时左右栏宽度不同导致两行区域高度不一致 */
  --dm-toolbar-stack-gap: 0.26rem;
  /* 上限与礼物统计区间按钮 .dm-gift-range-btn（0.58rem）一致 */
  --dm-toolbar-fs: clamp(0.52rem, 0.21vw + 0.458rem, 0.58rem);
  --dm-toolbar-lh: 1.2;
  --dm-toolbar-row-h: clamp(1.334rem, 1.26rem + 0.38vw, 1.418rem);
}

.dm-column-head-toolbar__start {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  align-content: flex-start;
  gap: var(--dm-toolbar-stack-gap) 0.38rem;
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
}

/* 首行：左侧操作 + 右侧固定「布局」下拉（忽闻宝声式工具条分行） */
.dm-toolbar-row-first {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  width: 100%;
  flex: 1 1 100%;
  min-width: 0;
  min-height: var(--dm-toolbar-row-h);
  gap: clamp(0.2rem, 0.06rem + 0.92cqw, 0.4rem);
}

/* ---- 弹幕 / 礼物菜单控件：同款字号与高（仅列头工具条内）---- */
:is(.dm-column-head-toolbar.dm-gift-header-toolbar, .dm-column-head-toolbar.dm-danmaku-split-head-toolbar)
  .dm-column-head-toolbar__start
  .dm-check.dm-check--toolbar {
  gap: 4px;
  align-items: center;
  font-size: var(--dm-toolbar-fs);
  line-height: var(--dm-toolbar-lh);
  min-height: var(--dm-toolbar-row-h);
  box-sizing: border-box;
  color: var(--dm-ui-muted);
}


:is(.dm-column-head-toolbar.dm-gift-header-toolbar, .dm-column-head-toolbar.dm-danmaku-split-head-toolbar)
  .dm-column-head-toolbar__start
  :is(.dm-btn.dm-btn--toolbar, .dm-gift-tabs.dm-gift-tabs--toolbar button) {
  box-sizing: border-box;
  min-height: var(--dm-toolbar-row-h);
  padding-block: 0 !important;
  padding-inline: 0.34rem !important;
  border-radius: 7px !important;
  font-size: var(--dm-toolbar-fs) !important;
  line-height: var(--dm-toolbar-lh);
  font-family: inherit !important;
  font-weight: 600 !important;
}

:is(.dm-column-head-toolbar.dm-gift-header-toolbar, .dm-column-head-toolbar.dm-danmaku-split-head-toolbar)
  .dm-column-head-toolbar__start
  .dm-btn.dm-btn--toolbar.dm-btn--ghost {
  border-color: color-mix(in srgb, var(--border) 78%, var(--text) 12%) !important;
  border-width: 1px !important;
  border-style: solid !important;
  background: color-mix(in srgb, var(--surface) 52%, transparent) !important;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 0 0 1px rgba(0, 0, 0, 0.04);
  color: var(--dm-ui-muted) !important;
}

:is(.dm-column-head-toolbar.dm-gift-header-toolbar, .dm-column-head-toolbar.dm-danmaku-split-head-toolbar)
  .dm-column-head-toolbar__start
  .dm-btn.dm-btn--toolbar.dm-btn--ghost:hover {
  border-color: color-mix(in srgb, var(--primary) 36%, var(--border)) !important;
  background: color-mix(in srgb, var(--text) 9%, transparent) !important;
  color: var(--dm-ui-strong) !important;
}

/* 礼物 记录｜统计：与布局模式分段同风格的圆角轨 */
.dm-gift-tabs.dm-gift-tabs--inline.dm-gift-tabs--toolbar {
  margin-left: 0;
  flex-shrink: 0;
  display: inline-flex;
  flex-wrap: nowrap;
  align-items: stretch;
  align-self: center;
  gap: 1px;
  padding: 1px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: color-mix(in srgb, var(--surface) 42%, transparent);
  box-sizing: border-box;
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.04);
  min-height: var(--dm-toolbar-row-h);
  height: var(--dm-toolbar-row-h);
}

:is(.dm-column-head-toolbar.dm-gift-header-toolbar, .dm-column-head-toolbar.dm-danmaku-split-head-toolbar)
  .dm-gift-tabs.dm-gift-tabs--toolbar button {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  flex: 1 1 0 !important;
  min-width: 0 !important;
  min-height: 0 !important;
  padding-inline: 0.42rem !important;
  margin: 0 !important;
  border: none !important;
  border-radius: 999px !important;
  font-size: var(--dm-toolbar-fs) !important;
  line-height: var(--dm-toolbar-lh) !important;
  box-shadow: none !important;
  color: var(--dm-ui-muted) !important;
  background: transparent !important;
  cursor: pointer;
  transition:
    background 0.14s ease,
    color 0.14s ease,
    transform 0.1s ease;
}

:is(.dm-column-head-toolbar.dm-gift-header-toolbar, .dm-column-head-toolbar.dm-danmaku-split-head-toolbar)
  .dm-gift-tabs.dm-gift-tabs--toolbar button:hover:not(.active) {
  color: var(--dm-ui-body) !important;
  background: color-mix(in srgb, var(--text) 6%, transparent) !important;
}

:is(.dm-column-head-toolbar.dm-gift-header-toolbar, .dm-column-head-toolbar.dm-danmaku-split-head-toolbar)
  .dm-gift-tabs.dm-gift-tabs--toolbar button.active {
  color: var(--dm-ui-strong) !important;
  font-weight: 650 !important;
  background: linear-gradient(
    168deg,
    color-mix(in srgb, var(--surface) 52%, transparent) 0%,
    color-mix(in srgb, var(--primary) 20%, transparent) 112%
  ) !important;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.055),
    0 0 0 1px color-mix(in srgb, var(--primary) 32%, transparent) !important;
}

:is(.dm-column-head-toolbar.dm-gift-header-toolbar, .dm-column-head-toolbar.dm-danmaku-split-head-toolbar)
  .dm-gift-tabs.dm-gift-tabs--toolbar button:focus-visible {
  z-index: 1;
  outline: none !important;
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--primary) 44%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.055) !important;
}

.dm-toolbar-menu-lead {
  display: inline-flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: clamp(0.2rem, 0.06rem + 0.92cqw, 0.4rem);
  flex: 1 1 auto;
  min-width: 0;
}

.dm-toolbar-menu-lead .dm-btn.dm-btn--toolbar {
  flex-shrink: 1;
}

.dm-toolbar-mode-cluster {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: clamp(0.18rem, 0.04rem + 1cqw, 0.46rem);
  flex-shrink: 0;
  min-width: 0;
  max-width: 100%;
}

.dm-toolbar-mode-cluster-actions {
  display: inline-flex;
  align-items: center;
  gap: clamp(0.12rem, 0.04rem + 0.78cqw, 0.32rem);
  flex-shrink: 0;
}

.dm-toolbar-soft-btn {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
  padding: 0.16em 0.28em;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  font-size: var(--dm-toolbar-fs);
  font-weight: 600;
  line-height: var(--dm-toolbar-lh);
  letter-spacing: 0.02em;
  color: var(--dm-ui-muted);
  text-decoration: underline solid transparent;
  text-decoration-thickness: 1.25px;
  text-underline-offset: 0.2em;
  white-space: nowrap;
  transition:
    color 0.14s ease,
    text-decoration-color 0.14s ease,
    background 0.14s ease,
    transform 0.1s ease;
}

.dm-toolbar-soft-btn:hover {
  color: var(--dm-ui-body);
  text-decoration-color: color-mix(in srgb, var(--primary) 52%, transparent);
  background: color-mix(in srgb, var(--text) 6%, transparent);
}

.dm-toolbar-soft-btn:active {
  transform: scale(0.98);
}

.dm-toolbar-soft-btn:focus-visible {
  outline: none;
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--primary) 40%, transparent),
    0 0 0 3px color-mix(in srgb, var(--primary) 24%, transparent);
}

.dm-toolbar-mode-cluster .dm-toolbar-layout-slot {
  flex: 0 1 auto;
  min-width: 0;
}

.dm-toolbar-layout-slot {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

.dm-toolbar-search-slot {
  flex: 1 1 100%;
  width: 100%;
  min-width: 0;
}

.dm-column-head-toolbar__start > .dm-toolbar-search-slot .dm-danmu-search.dm-danmu-search--toolbar {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}

/* 胶囊筛选：与首行同色高，略扁（仍可 focus-within 高亮） */
.dm-search-pill.dm-danmu-search--toolbar {
  position: relative;
  display: flex;
  align-items: stretch;
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  gap: 0;
  overflow: hidden;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: color-mix(in srgb, var(--surface) 45%, transparent);
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.05);
  min-height: var(--dm-toolbar-row-h);
  height: var(--dm-toolbar-row-h);
  box-sizing: border-box;
  transition:
    border-color 0.18s,
    box-shadow 0.18s,
    background 0.18s;
}

.dm-search-pill.dm-danmu-search--toolbar:focus-within {
  background: color-mix(in srgb, var(--surface) 55%, transparent);
  border-color: color-mix(in srgb, var(--primary) 50%, var(--border));
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--primary) 20%, transparent),
    inset 0 1px 1px rgba(0, 0, 0, 0.04);
}

/* 胶囊左侧：筛选方式下拉 */
.dm-search-pill__mode-slot {
  flex-shrink: 0;
  align-self: stretch;
  display: flex;
  align-items: stretch;
  box-sizing: border-box;
  border-right: 1px solid color-mix(in srgb, var(--text) 9%, transparent);
  background: color-mix(in srgb, var(--text) 3.5%, transparent);
  padding: 1px 0 1px 3px;
}

.dm-search-pill__q {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  align-self: stretch;
  box-sizing: border-box;
  margin: 0;
  padding: 0 1.6rem 0 0.42rem !important;
  border: none;
  border-radius: 0 !important;
  background: transparent;
  color: var(--dm-ui-body);
  font-family: inherit;
  font-size: var(--dm-toolbar-fs) !important;
  line-height: var(--dm-toolbar-lh);
  outline: none;
  appearance: none;
  -webkit-appearance: none;
}
.dm-search-pill__q::placeholder {
  color: var(--dm-ui-muted);
  opacity: 0.78;
}
.dm-search-pill__q::-webkit-search-decoration,
.dm-search-pill__q::-webkit-search-cancel-button {
  appearance: none;
  -webkit-appearance: none;
}
.dm-search-pill__ico {
  position: absolute;
  right: 0.52rem;
  top: 50%;
  transform: translateY(-50%);
  font-size: var(--dm-toolbar-fs);
  opacity: 0.42;
  pointer-events: none;
  line-height: 1;
}

@container dm-col-toolbar (max-width: 600px) {
  .dm-input.dm-input--toolbar-search {
    max-width: none;
  }
}

@container dm-col-toolbar (max-width: 520px) {
  .dm-column-head-toolbar.dm-gift-header-toolbar,
  .dm-column-head-toolbar.dm-danmaku-split-head-toolbar {
    --dm-toolbar-fs: clamp(0.492rem, 0.378rem + 0.74cqw, 0.58rem);
    --dm-toolbar-lh: 1.18;
    --dm-toolbar-row-h: clamp(1.282rem, 1.22rem + 0.38vw, 1.348rem);
  }

  .dm-toolbar-row-first {
    gap: 0.16rem;
  }

  :is(.dm-column-head-toolbar.dm-gift-header-toolbar, .dm-column-head-toolbar.dm-danmaku-split-head-toolbar)
    .dm-column-head-toolbar__start :is(.dm-btn.dm-btn--toolbar, .dm-gift-tabs.dm-gift-tabs--toolbar button) {
    padding-inline: 0.26rem !important;
    border-radius: 6px !important;
  }

  .dm-search-pill__mode-slot {
    padding-left: 2px;
  }

  .dm-search-pill__q {
    padding: 0 1.45rem 0 0.34rem !important;
  }
}

@container dm-col-toolbar (max-width: 400px) {
  .dm-column-head-toolbar.dm-gift-header-toolbar,
  .dm-column-head-toolbar.dm-danmaku-split-head-toolbar {
    --dm-toolbar-fs: clamp(0.478rem, 0.394rem + 0.71cqw, 0.58rem);
    --dm-toolbar-row-h: clamp(1.22rem, 1.14rem + 0.32vw, 1.29rem);
  }

  :is(.dm-column-head-toolbar.dm-gift-header-toolbar, .dm-column-head-toolbar.dm-danmaku-split-head-toolbar)
    .dm-column-head-toolbar__start .dm-btn.dm-btn--toolbar,
  :is(.dm-column-head-toolbar.dm-gift-header-toolbar, .dm-column-head-toolbar.dm-danmaku-split-head-toolbar)
    .dm-column-head-toolbar__start .dm-gift-tabs.dm-gift-tabs--toolbar button {
    padding-inline: 0.2rem !important;
    border-radius: 6px !important;
  }
}

.dm-check.dm-check--toolbar-free-scroll {
  flex-shrink: 0;
  white-space: nowrap;
}
.dm-input.dm-input--toolbar-search {
  flex: 1 1 auto;
  width: auto;
  min-width: 52px;
  max-width: 11rem;
  padding: 0.2rem 0.42rem !important;
  font-family: inherit !important;
  font-size: clamp(0.64rem, 0.42vw + 0.56rem, 0.73rem) !important;
  border-radius: 7px !important;
}
.dm-input.dm-input--gift-search-toolbar {
  flex: 1 1 72px;
  min-width: 0;
  max-width: 10rem;
  width: auto;
  font-family: inherit;
}

.dm-danmaku-split-head--pop-shell {
  background: color-mix(in srgb, var(--surface) 44%, transparent);
}

.dm-danmaku-stack .dm-feed.dm-feed--in-danmaku-stack,
.dm-danmaku-stack .dm-feed.dm-feed--popped-placeholder {
  border-radius: 0;
  border: none;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  background: transparent;
}
.dm-feed-split-empty {
  flex: 1;
  min-height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.85rem 1rem;
  border-radius: 14px;
  border: 1px dashed color-mix(in srgb, #fff 10%, var(--border));
}
.dm-danmu-search {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 160px;
  min-width: 120px;
}
.dm-select--compact {
  flex-shrink: 0;
  padding: 0.28rem 0.45rem !important;
  font-family: inherit !important;
  font-size: 0.76rem !important;
  border-radius: 8px !important;
  min-width: 4.75rem;
}
.dm-input--compact {
  flex: 1;
  width: auto;
  max-width: 220px;
  min-width: 88px;
  padding: 0.28rem 0.52rem !important;
  font-family: inherit !important;
  font-size: 0.78rem !important;
  border-radius: 8px !important;
}
.dm-check { display: inline-flex; align-items: center; gap: 5px; font-size: 0.8rem; color: var(--dm-ui-muted); cursor: pointer; font-family: inherit; }
.dm-check input { accent-color: var(--primary); }

/* Split layout: danmaku left, gift right */
.dm-feed-split {
  display: flex; gap: 0; min-height: 0; align-items: stretch;
}
.dm-feed-split .dm-feed-left {
  flex: 1; min-width: 0; display: flex; flex-direction: column;
}
.dm-feed-split--open .dm-feed-left {
  flex: calc(1 - var(--gift-ratio, 0.333));
}
.dm-feed-split .dm-feed-right {
  flex: var(--gift-ratio, 0.333);
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.dm-feed-split .dm-feed-right > .dm-gift-panel:not(.dm-gift-panel--docked-right):not(.dm-gift-panel--floated-pop) {
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  max-height: none;
}
.dm-feed-split.dm-feed-split--gift-only-wide .dm-feed-right {
  flex: 1 1 auto !important;
  width: 100%;
  max-width: 100%;
  min-width: 0 !important;
}
.dm-feed-split.dm-feed-split--gift-only-wide.dm-feed-split--mobile .dm-feed-right {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  height: auto;
}
.dm-feed-split--open:not(.is-dragging) .dm-feed-right {
  transition: flex 0.18s ease;
}
/* Mobile vertical layout */
.dm-feed-split .dm-feed-right.dm-feed-right--docked-only {
  flex: 0 0 0 !important;
  width: 0 !important;
  min-width: 0 !important;
  max-width: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
  border: none !important;
  overflow: visible !important;
}

.dm-feed-split--mobile {
  flex-direction: column;
}
.dm-feed-split--mobile .dm-feed-left {
  flex: 1 1 0;
  min-height: 0;
}
.dm-feed-split--mobile.dm-feed-split--open .dm-feed-left {
  flex: 1 1 0;
  min-height: 0;
}
.dm-feed-split--mobile.dm-feed-split--open .dm-feed-right {
  flex: 1 1 0;
  min-height: 0;
  height: auto;
}
.dm-feed-split--mobile.dm-feed-split--open:not(.is-dragging) .dm-feed-right {
  transition: flex 0.18s ease;
}

.dm-feed-splitter {
  touch-action: none;
  flex-shrink: 0;
  user-select: none;
  align-self: stretch;
}
.dm-feed-splitter--col {
  flex: 0 0 8px;
  margin: 0 2px;
  cursor: col-resize;
  position: relative;
  z-index: 2;
  background: transparent;
}
.dm-feed-splitter--col::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 24px;
  bottom: 24px;
  transform: translateX(-50%);
  width: 3px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--border) 88%, transparent);
  pointer-events: none;
}
.dm-feed-splitter--col:hover::after,
.dm-feed-split.is-dragging .dm-feed-splitter--col::after {
  background: color-mix(in srgb, var(--primary) 42%, var(--border));
}
.dm-feed-splitter--row {
  flex: 0 0 10px;
  width: 100%;
  margin: 2px 0;
  cursor: row-resize;
  position: relative;
  z-index: 2;
  background: transparent;
}
.dm-feed-splitter--row::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 18px;
  right: 18px;
  height: 3px;
  transform: translateY(-50%);
  border-radius: 2px;
  background: color-mix(in srgb, var(--border) 88%, transparent);
  pointer-events: none;
}
.dm-feed-splitter--row:hover::after,
.dm-feed-split.is-dragging .dm-feed-splitter--row::after {
  background: color-mix(in srgb, var(--primary) 42%, var(--border));
}

.dm-feed {
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: linear-gradient(195deg,
    color-mix(in srgb, var(--primary) 4%, transparent) 0%,
    color-mix(in srgb, var(--bg) 25%, transparent) 55%,
    color-mix(in srgb, var(--surface) 40%, transparent) 100%);
  box-shadow: 0 4px 20px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.05);
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  height: 368px; overflow-y: auto; padding: 0.5rem;
  font-family:
    ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Segoe UI Variable",
    Roboto,
    "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", "Microsoft YaHei UI",
    "Noto Sans CJK SC", sans-serif;
  font-size: 0.8rem;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--primary) 30%, var(--border)) transparent;
}
.dm-feed::-webkit-scrollbar:vertical {
  width: 5px;
}
.dm-feed::-webkit-scrollbar:horizontal {
  height: 4px;
}
.dm-feed::-webkit-scrollbar-track {
  background: transparent;
}
.dm-feed::-webkit-scrollbar-track:vertical {
  margin: 8px 0;
}
.dm-feed::-webkit-scrollbar-track:horizontal {
  margin: 0 8px;
}
.dm-feed::-webkit-scrollbar-thumb {
  border-radius: 100px;
  background: color-mix(in srgb, var(--primary) 35%, var(--border));
}
.dm-feed::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--primary) 55%, var(--border));
}
/* 弹幕列表单独弹出 */
.dm-feed-pop-shell {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-height: 0;
  overflow: hidden;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, #fff 10%, var(--border));
  background: linear-gradient(
    195deg,
    color-mix(in srgb, var(--primary) 5%, transparent) 0%,
    color-mix(in srgb, var(--bg) 22%, transparent) 55%,
    color-mix(in srgb, var(--surface) 42%, transparent) 100%
  );
  box-shadow:
    0 14px 44px rgba(0, 0, 0, 0.16),
    0 0 0 1px color-mix(in srgb, #fff 8%, var(--border));
  backdrop-filter: blur(14px) saturate(1.2);
  -webkit-backdrop-filter: blur(14px) saturate(1.2);
}
.dm-feed-pop-shell--dragging {
  box-shadow:
    0 18px 52px rgba(0, 0, 0, 0.2),
    0 0 0 1px color-mix(in srgb, var(--primary) 22%, var(--border));
}
.dm-feed-pop-shell--resizing {
  user-select: none;
}
.dm-feed-pop-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid color-mix(in srgb, #fff 6%, var(--border));
  background: color-mix(in srgb, var(--surface) 52%, transparent);
  user-select: none;
}
.dm-feed-pop-drag {
  flex: 1;
  min-width: 0;
  cursor: grab;
  touch-action: none;
  font-size: 0.78rem;
  font-weight: 650;
  color: color-mix(in srgb, var(--text) 88%, var(--muted));
  padding: 0.2rem 0.35rem;
  margin: -0.2rem 0;
  border-radius: 8px;
}
.dm-feed-pop-drag:active,
.dm-feed-pop-shell--dragging .dm-feed-pop-drag {
  cursor: grabbing;
}
.dm-feed-pop-resize-br {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 20px;
  height: 20px;
  z-index: 8;
  padding: 0;
  margin: 0;
  border: none;
  border-radius: 0 0 12px 0;
  cursor: nwse-resize;
  touch-action: none;
  background: transparent;
  box-sizing: border-box;
}
.dm-feed-pop-resize-br:hover,
.dm-feed-pop-shell--resizing .dm-feed-pop-resize-br {
  background: color-mix(in srgb, var(--primary) 14%, transparent);
}
.dm-feed-pop-resize-br::after {
  content: "";
  position: absolute;
  right: 5px;
  bottom: 5px;
  width: 9px;
  height: 9px;
  border-right: 2px solid color-mix(in srgb, var(--muted) 70%, transparent);
  border-bottom: 2px solid color-mix(in srgb, var(--muted) 70%, transparent);
  pointer-events: none;
  box-sizing: border-box;
}

.dm-feed.dm-feed--floated {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  border-radius: 0;
  border: none;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.dm-feed.dm-feed--popped-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  min-height: 160px;
  height: 368px;
  padding: 1rem 1.25rem;
}
.dm-feed.dm-feed--popped-placeholder .dm-empty {
  max-width: 22rem;
  line-height: 1.55;
  color: var(--muted);
}

/* Gift panel */
.dm-gift-panel {
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, #fff 6%, var(--border));
  background: color-mix(in srgb, var(--surface) 50%, transparent);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  overflow: hidden;
  display: flex; flex-direction: column; height: 368px;
  font-family:
    ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Segoe UI Variable",
    Roboto,
    "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", "Microsoft YaHei UI",
    "Noto Sans CJK SC", sans-serif;
}
.dm-gift-panel.dm-gift-panel--docked-right {
  position: fixed;
  z-index: 42;
  top: clamp(68px, 12vh, 128px);
  bottom: clamp(12px, 3vh, 36px);
  right: max(12px, calc((100vw - min(720px, 100vw)) / 2));
  width: min(348px, max(276px, 27vw));
  height: auto !important;
  max-height: min(540px, calc(100vh - 88px));
  box-shadow:
    0 14px 44px rgba(0, 0, 0, 0.16),
    0 0 0 1px color-mix(in srgb, #fff 12%, var(--border));
}
.dm-gift-panel.dm-gift-panel--floated-pop {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
  border-radius: 0;
  border: none;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.dm-gift-header {
  display: flex; flex-direction: column; gap: 4px;
  padding: 0.4rem 0.6rem; user-select: none; flex-shrink: 0;
  border-bottom: 1px solid color-mix(in srgb, #fff 4%, var(--border));
}
.dm-gift-header.dm-gift-header--parity {
  --dm-toolbar-stack-gap: 0.26rem;
  padding: 0.34rem 0.45rem;
  gap: var(--dm-toolbar-stack-gap);
  background: color-mix(in srgb, var(--surface) 46%, transparent);
  border-bottom: 1px solid color-mix(in srgb, #fff 6%, var(--border));
}
.dm-gift-header.dm-gift-header--parity.dm-gift-header--pop-shell {
  background: color-mix(in srgb, var(--surface) 40%, transparent);
}
.dm-gift-header-toolbar {
  display: flex;
  align-items: center;
  gap: 6px 8px;
  flex-wrap: wrap;
}
.dm-gift-toolbar-spacer {
  flex: 1;
  min-width: 8px;
}
.dm-gift-tabs--inline {
  margin-left: 0;
  flex-shrink: 0;
}
.dm-input.dm-input--gift-search {
  flex: 1 1 118px;
  min-width: 86px;
  max-width: 220px;
  width: auto;
  padding: 0.26rem 0.5rem;
  font-family: inherit;
  font-size: 0.76rem;
  border-radius: 8px;
}
.dm-gift-header-range-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 2px;
}
.dm-gift-range-group--stretch {
  flex: 1;
  flex-wrap: wrap;
}
.dm-gift-header-row1 {
  display: flex; align-items: center; gap: 5px;
}
.dm-gift-header-row2 {
  display: flex; align-items: center; gap: 5px;
}
.dm-gift-chevron { transition: transform 0.2s; flex-shrink: 0; color: var(--muted); }
.dm-gift-chevron.open { transform: rotate(90deg); }
.dm-gift-header-icon { font-size: 0.9rem; }
.dm-gift-header-title { font-size: 0.78rem; font-weight: 600; color: var(--text); }
.dm-btn--xs {
  font-family: inherit;
  font-size: 0.65rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 6px;
  color: var(--dm-ui-body);
}
.dm-btn--xs.dm-btn--primary {
  color: var(--on-primary);
}
.dm-btn--xs.dm-btn--outline {
  color: var(--dm-ui-strong);
}
.dm-btn--xs.dm-btn--ghost {
  color: var(--dm-ui-soft);
}
.dm-gift-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  container-type: inline-size;
}
.dm-gift-feed {
  height: 100%; overflow-y: auto; overflow-x: auto; padding: 0.35rem 0.5rem;
  scroll-behavior: smooth;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--primary) 30%, var(--border)) transparent;
}
.dm-gift-feed::-webkit-scrollbar:vertical {
  width: 4px;
}
.dm-gift-feed::-webkit-scrollbar:horizontal {
  height: 4px;
}
.dm-gift-feed::-webkit-scrollbar-track {
  background: transparent;
}
.dm-gift-feed::-webkit-scrollbar-thumb {
  border-radius: 100px;
  background: color-mix(in srgb, var(--primary) 30%, var(--border));
}
.dm-gift-feed::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--primary) 45%, var(--border));
}

.dm-gift-debug-feed.dm-gift-feed {
  padding-top: 0.28rem;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.dm-gift-debug-lead {
  margin: 0 0 0.45rem;
  font-size: clamp(0.48rem, 2.9cqw, 0.58rem);
  line-height: 1.42;
  color: var(--muted);
}
.dm-gift-debug-lead strong {
  color: color-mix(in srgb, var(--muted) 40%, var(--text));
}
.dm-gift-debug-code {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 0.9em;
  color: var(--dm-ui-body);
  word-break: break-all;
  white-space: normal;
}
.dm-gift-debug-lookup {
  margin: 0 0 0.5rem;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  background: color-mix(in srgb, var(--surface) 30%, transparent);
  padding: 0.38rem 0.45rem 0.5rem;
}
.dm-gift-debug-lookup-sum {
  cursor: pointer;
  font-size: clamp(0.52rem, 3cqw, 0.62rem);
  font-weight: 650;
  color: color-mix(in srgb, var(--muted) 28%, var(--text));
}
.dm-gift-debug-lookup-note {
  margin: 0.32rem 0 0.4rem;
  font-size: clamp(0.45rem, 2.7cqw, 0.54rem);
  line-height: 1.42;
  color: var(--muted);
}
.dm-gift-debug-lookup-msg {
  font-size: clamp(0.45rem, 2.65cqw, 0.52rem);
  color: color-mix(in srgb, var(--muted) 88%, var(--text));
  padding: 0.2rem 0 0;
}
.dm-gift-debug-prop-meta {
  margin-top: 0.42rem;
  padding-top: 0.38rem;
  border-top: 1px dashed color-mix(in srgb, var(--border) 50%, transparent);
}
.dm-gift-debug-lookup-dash { opacity: 0.62; font-size: 0.92em; }
.dm-gift-debug-catalog-scroll {
  max-height: 11rem;
  overflow: auto;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
}
.dm-gift-debug-catalog-table {
  border-collapse: collapse;
  width: max-content;
  min-width: 100%;
  font-size: clamp(0.43rem, 2.55cqw, 0.51rem);
}
.dm-gift-debug-catalog-table th,
.dm-gift-debug-catalog-table td {
  padding: 3px 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  vertical-align: middle;
}
.dm-gift-debug-catalog-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  font-weight: 650;
  text-align: left;
}
.dm-gift-debug-catalog-img-cell {
  width: 28px;
  text-align: center;
}
.dm-gift-debug-catalog-icon {
  width: 22px;
  height: 22px;
  object-fit: contain;
  border-radius: 3px;
  vertical-align: middle;
}
.dm-gift-debug-catalog-th-open,
.dm-gift-debug-catalog-open-cell {
  white-space: nowrap;
  text-align: center;
  vertical-align: middle;
}
.dm-gift-debug-table-scroll {
  max-width: 100%;
  width: 100%;
  min-width: 0;
  min-height: 12rem;
  flex: 1;
  overflow: auto;
  overflow-x: auto;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
  background: color-mix(in srgb, var(--surface) 35%, transparent);
}
.dm-gift-debug-table {
  border-collapse: separate;
  border-spacing: 0;
  font-size: clamp(0.46rem, 2.6cqw, 0.54rem);
  line-height: 1.35;
  width: max-content;
  min-width: 100%;
}
.dm-gift-debug-table th,
.dm-gift-debug-table td {
  border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  padding: 3px 5px;
  vertical-align: top;
  white-space: nowrap;
}
.dm-gift-debug-table th.dm-gift-debug-th-json {
  white-space: nowrap;
  min-width: 2.85rem;
  max-width: 4.5rem;
  width: auto;
  text-align: center;
  position: sticky;
  right: 0;
  top: 0;
  z-index: 3;
  box-shadow:
    inset 1px 0 0 color-mix(in srgb, var(--border) 55%, transparent),
    -10px 0 18px -10px rgba(0, 0, 0, 0.28);
}
.dm-gift-debug-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  font-weight: 650;
  text-align: left;
  color: var(--dm-ui-strong);
  background: color-mix(in srgb, var(--surface) 88%, var(--muted) 4%);
}
.dm-gift-debug-table tbody tr:hover td {
  background: color-mix(in srgb, var(--primary) 6%, transparent);
}
.dm-gift-debug-table tbody tr:hover td.dm-gift-debug-json-cell {
  background: color-mix(in srgb, var(--primary) 10%, color-mix(in srgb, var(--surface) 93%, transparent));
}
.dm-gift-debug-td-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.dm-gift-debug-td-nowrap {
  white-space: nowrap;
}
.dm-gift-debug-td-ell {
  max-width: 5rem;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dm-gift-debug-json-cell {
  position: sticky;
  right: 0;
  z-index: 2;
  min-width: 2.85rem;
  max-width: 4.5rem;
  width: auto;
  background: color-mix(in srgb, var(--surface) 93%, transparent);
  box-shadow:
    inset 1px 0 0 color-mix(in srgb, var(--border) 55%, transparent),
    -10px 0 18px -10px rgba(0, 0, 0, 0.22);
  vertical-align: middle;
  text-align: center;
  padding: 3px !important;
}
.dm-gift-debug-json-hit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 2px 6px;
  border: none;
  border-radius: 999px;
  background: color-mix(in srgb, var(--primary) 22%, transparent);
  color: var(--dm-ui-strong);
  font-family: inherit;
  font-weight: 650;
  font-size: clamp(0.4rem, 2.35cqw, 0.52rem);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  vertical-align: middle;
  transition:
    background 0.13s ease,
    color 0.13s ease,
    transform 0.09s ease;
}
.dm-gift-debug-json-hit:hover {
  background: color-mix(in srgb, var(--primary) 34%, transparent);
  color: var(--text);
}
.dm-gift-debug-json-hit:active {
  transform: scale(0.97);
}
.dm-gift-debug-json-hit:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 42%, transparent);
}
.dm-gift-debug-td-gfn {
  max-width: 6.5rem;
}
.dm-gift-debug-td-strong {
  font-weight: 750;
  color: color-mix(in srgb, var(--primary) 58%, var(--text));
}

.dm-gift-item {
  display: flex; align-items: center; gap: 0.3rem; padding: 0.2rem 0.35rem;
  border-radius: 6px; margin-bottom: 1px; white-space: nowrap;
  font-size: clamp(0.5rem, 3cqw, 0.72rem); transition: background 0.12s;
  overflow: hidden; min-width: max-content;
}
.dm-gift-item:hover { background: color-mix(in srgb, var(--primary) 5%, var(--surface) 40%); }
.dm-gift--big { background: color-mix(in srgb, #ffd700 6%, transparent); }
.dm-gift--big:hover { background: color-mix(in srgb, #ffd700 12%, transparent); }
.dm-gift-icon {
  width: clamp(14px, 6cqw, 22px); height: clamp(14px, 6cqw, 22px); border-radius: 4px; flex-shrink: 0;
  object-fit: contain; background: color-mix(in srgb, var(--surface) 60%, transparent);
}
.dm-gift-icon-placeholder {
  width: clamp(14px, 6cqw, 22px); height: clamp(14px, 6cqw, 22px); display: flex; align-items: center; justify-content: center;
  font-size: clamp(0.5rem, 3cqw, 0.75rem); flex-shrink: 0; border-radius: 4px;
  background: color-mix(in srgb, var(--surface) 60%, transparent);
}
.dm-gift-item .dm-time { font-size: clamp(0.45rem, 2.5cqw, 0.6rem); min-width: auto; flex-shrink: 0; }
.dm-gift-item .dm-chat-pill.dm-ulv-el,
.dm-gift-item .dm-chat-pill.dm-fan-el {
  flex-shrink: 0;
  margin-right: 5px;
}
.dm-gift-nick { color: var(--primary); font-weight: 600; font-size: clamp(0.5rem, 2.8cqw, 0.68rem); max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1; min-width: 20px; }
.dm-gift-name {
  font-weight: 600; color: #f0a020; font-size: clamp(0.48rem, 2.6cqw, 0.66rem); flex-shrink: 0;
}
.dm-gift-cnt {
  font-weight: 700; color: var(--accent); font-size: clamp(0.48rem, 2.6cqw, 0.64rem); flex-shrink: 0; margin-left: 0.2rem;
}
.dm-gift-gfid-hint {
  flex-shrink: 0;
  margin-left: 0.26rem;
  font-size: clamp(0.36rem, 2.05cqw, 0.5rem);
  font-weight: 600;
  color: color-mix(in srgb, var(--muted) 74%, var(--text));
  letter-spacing: 0.015em;
  opacity: 0.95;
}
.dm-gift-combo {
  font-size: clamp(0.48rem, 2.6cqw, 0.64rem); font-weight: 700; color: var(--danger); flex-shrink: 0;
}
/* Gift sub-tabs */
.dm-gift-tabs {
  display: inline-flex; gap: 0; margin-left: 4px;
}
.dm-gift-tabs button {
  font-size: 0.68rem; padding: 2px 8px; border: none; background: transparent;
  color: var(--dm-ui-muted); cursor: pointer;
  font-family: inherit;
  font-weight: 600; border-radius: 4px;
  transition: color 0.14s ease, background 0.14s ease;
}
.dm-gift-tabs button.active {
  color: var(--dm-ui-strong); font-weight: 700;
  background: color-mix(in srgb, var(--primary) 10%, transparent);
}
.dm-gift-tabs button:hover:not(.active) { color: var(--dm-ui-body); }
/* Gift stats range buttons */
.dm-gift-range-group {
  display: inline-flex; gap: 2px;
}
.dm-gift-range-btn {
  font-size: 0.58rem;
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  background: transparent;
  color: var(--dm-ui-muted);
  cursor: pointer;
  font-family: inherit;
  font-weight: 600;
  transition: border-color 0.14s ease, background 0.14s ease, color 0.14s ease;
  line-height: 1.2;
}
.dm-gift-range-btn.active {
  background: color-mix(in srgb, var(--primary) 14%, transparent);
  border-color: color-mix(in srgb, var(--primary) 55%, var(--border));
  color: var(--dm-ui-strong); font-weight: 650;
}
.dm-gift-range-btn:hover:not(.active) {
  border-color: color-mix(in srgb, var(--primary) 38%, var(--border));
  color: var(--dm-ui-body);
}
/* Gift stats view */
.dm-gift-stats {
  height: 100%; overflow-y: auto; padding: 0.4rem 0.5rem;
}
.dm-gift-stats-summary {
  display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 6px; margin-bottom: 0.6rem;
}
.dm-gift-stats-card {
  display: flex; flex-direction: column; align-items: center; padding: 6px 4px;
  border-radius: 8px; background: color-mix(in srgb, var(--surface) 60%, transparent);
  border: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
}
.dm-gift-stats-label { font-size: 0.55rem; color: var(--muted); }
.dm-gift-stats-value { font-size: 0.82rem; font-weight: 700; color: var(--text); }
.dm-gift-stats-value--gold { color: #f0a020; }
.dm-gift-stats-value--cost { color: var(--danger); }
.dm-gift-stats-section { margin-bottom: 0.5rem; }
.dm-gift-stats-section-title {
  font-size: 0.62rem; font-weight: 600; color: var(--muted); margin-bottom: 4px;
  padding-bottom: 2px; border-bottom: 1px solid color-mix(in srgb, var(--border) 30%, transparent);
}
.dm-gift-stats-source-hint {
  margin: 0 0 5px;
  font-size: 0.53rem;
  line-height: 1.38;
  color: color-mix(in srgb, var(--muted) 94%, var(--text));
}
.dm-gift-stats-source-hint--compact {
  margin-top: -1px;
  margin-bottom: 4px;
}
.dm-gift-stats-row {
  display: flex; align-items: center; gap: 0.3rem; padding: 2px 4px;
  border-radius: 4px; font-size: 0.68rem;
}
.dm-gift-stats-row:hover { background: color-mix(in srgb, var(--primary) 5%, transparent); }
.dm-gift-icon-sm { width: 16px; height: 16px; border-radius: 3px; object-fit: contain; flex-shrink: 0; }
.dm-gift-icon-sm-placeholder { width: 16px; height: 16px; font-size: 0.6rem; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.dm-gift-stats-name { font-weight: 500; color: var(--text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-gift-stats-gfid { font-size: 0.56rem; font-weight: 500; color: var(--muted); margin-left: 0.2rem; opacity: 0.95; }
.dm-gift-stats-nick { font-weight: 500; color: var(--primary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-gift-stats-cnt { font-weight: 600; color: var(--accent); font-size: 0.65rem; flex-shrink: 0; }
.dm-gift-stats-price { font-size: 0.58rem; color: #f0a020; font-weight: 500; flex-shrink: 0; }
.dm-gift-stats-from-badge {
  flex-shrink: 0;
  font-size: 0.52rem;
  font-weight: 700;
  color: color-mix(in srgb, var(--accent) 62%, var(--muted));
}
.dm-gift-stats-cost { font-size: 0.58rem; color: var(--muted); font-weight: 400; flex-shrink: 0; }
/* Gift stats table layout */
.dm-gift-stats-table {
  display: grid;
  grid-template-columns: 20px 1fr auto auto auto;
  gap: 0;
  font-size: 0.66rem;
}
.dm-gift-stats-table--compact {
  grid-template-columns: 1fr auto auto auto;
}
.dm-gift-stats-thead {
  display: contents;
}
.dm-gift-stats-th {
  font-size: 0.54rem;
  font-weight: 600;
  color: var(--muted);
  padding: 2px 4px 3px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 30%, transparent);
  white-space: nowrap;
}
.dm-gift-stats-th--icon { padding: 2px 2px 3px; }
.dm-gift-stats-th--name { text-align: left; }
.dm-gift-stats-th--cnt { text-align: right; }
.dm-gift-stats-th--revenue { text-align: right; color: #f0a020; }
.dm-gift-stats-th--cost { text-align: right; color: var(--danger); }
.dm-gift-stats-trow {
  display: contents;
}
.dm-gift-stats-trow:hover > .dm-gift-stats-td {
  background: color-mix(in srgb, var(--primary) 5%, transparent);
}
.dm-gift-stats-td {
  padding: 2px 4px;
  display: flex;
  align-items: center;
  min-width: 0;
  border-radius: 0;
}
.dm-gift-stats-td--icon {
  padding: 2px 2px;
  justify-content: center;
}
.dm-gift-stats-td--name {
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-gift-stats-td--cnt {
  font-weight: 600;
  color: var(--accent);
  font-size: 0.64rem;
  justify-content: flex-end;
  white-space: nowrap;
}
.dm-gift-stats-td--revenue {
  font-weight: 500;
  color: #f0a020;
  font-size: 0.60rem;
  justify-content: flex-end;
  white-space: nowrap;
}
.dm-gift-stats-td--cost {
  font-weight: 500;
  color: var(--danger);
  font-size: 0.60rem;
  justify-content: flex-end;
  white-space: nowrap;
  opacity: 0.85;
}
/* Gift stats user table (grid aligned like byGift) */
.dm-gift-stats-user-table {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 0;
  font-size: 0.66rem;
}
.dm-gift-stats-user-thead {
  display: contents;
}
.dm-gift-stats-uth {
  font-size: 0.54rem;
  font-weight: 600;
  color: var(--muted);
  padding: 2px 4px 3px;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 30%, transparent);
  white-space: nowrap;
}
.dm-gift-stats-uth--user { text-align: left; }
.dm-gift-stats-uth--revenue { text-align: right; color: #f0a020; }
.dm-gift-stats-uth--cost { text-align: right; color: var(--danger); }
.dm-gift-stats-utrow {
  display: contents;
}
.dm-gift-stats-utrow:hover > .dm-gift-stats-utd {
  background: color-mix(in srgb, var(--primary) 5%, transparent);
}
.dm-gift-stats-utd {
  padding: 2px 4px;
  display: flex;
  align-items: center;
  min-width: 0;
}
.dm-gift-stats-utd--user {
  display: flex;
  align-items: center;
  gap: 1px;
  min-width: 0;
  overflow: hidden;
}
.dm-gift-stats-utd--user .dm-chat-pill {
  font-size: 0.46rem;
  margin-right: 1px;
  transform: scale(0.85);
  transform-origin: left center;
}
.dm-gift-stats-utd--user .dm-chat-pill.dm-ulv-el {
  min-height: 0.95rem;
  padding: 0px 4px;
  gap: 0;
}
.dm-gift-stats-utd--user .dm-chat-pill.dm-fan-el {
  width: 7.5em;
  min-width: 7.5em;
  max-width: 7.5em;
}
.dm-gift-stats-utd--user .dm-fan-seg {
  min-height: 0.95rem;
}
.dm-gift-stats-utd--user .dm-fan-seg--lv {
  flex: 0 0 2.2em;
  width: 2.2em;
  min-width: 2.2em;
  max-width: 2.2em;
}
.dm-gift-stats-utd--user .dm-fan-seg--nm {
  flex: 0 0 4.3em;
  width: 4.3em;
  min-width: 4.3em;
  max-width: 4.3em;
  padding: 1px 3px;
}
.dm-gift-stats-utd--user .dm-fan-seg-avatar {
  width: 11px;
  height: 11px;
}
.dm-gift-stats-user-nick {
  font-weight: 500;
  color: var(--primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
}
.dm-gift-stats-utd--revenue {
  font-weight: 500;
  color: #f0a020;
  font-size: 0.60rem;
  justify-content: flex-end;
  white-space: nowrap;
}
.dm-gift-stats-utd--cost {
  font-weight: 500;
  color: var(--danger);
  font-size: 0.60rem;
  justify-content: flex-end;
  white-space: nowrap;
  opacity: 0.85;
}
.dm-empty { text-align: center; color: var(--muted); padding: 2.5rem 1rem; font-size: 0.85rem; }
/* 弹幕行：徽章在前 → 昵称区（头像+名）→ 冒号 → 正文 */
.dm-msg {
  padding: 0.32rem 0.45rem; border-radius: 8px;
  margin-bottom: 2px;
  transition: background 0.12s;
}
.dm-msg:hover { background: color-mix(in srgb, var(--primary) 5%, var(--surface) 40%); }
.dm-msg--cmd {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border-left: 2.5px solid var(--accent);
}
.dm-msg-chatline {
  display: block;
  font-size: 0.72rem;
  line-height: 1.52;
  word-break: break-word;
  overflow-wrap: anywhere;
  color: color-mix(in srgb, var(--text) 92%, #fff);
}
.dm-time--chat {
  display: inline;
  margin-right: 0.4rem;
  font-size: 0.54rem;
  font-weight: 500;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  vertical-align: baseline;
  opacity: 0.85;
}
.dm-chat-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-right: 5px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 0.58rem;
  font-weight: 600;
  line-height: 1.35;
  vertical-align: middle;
  white-space: nowrap;
}
/* 品质胶囊基底：用户等级（小圆角）/ 粉丝牌（旗帜形）共用 */
.dm-ulv-el,
.dm-fan-el {
  border: 1px solid color-mix(in srgb, currentColor 22%, rgba(255, 255, 255, 0.28));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.2),
    inset 0 -1px 0 rgba(0, 0, 0, 0.07);
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
  backdrop-filter: blur(8px) saturate(1.22);
  -webkit-backdrop-filter: blur(8px) saturate(1.22);
  text-shadow:
    0 0 1px rgba(0, 0, 0, 0.65),
    0 1px 3px rgba(0, 0, 0, 0.38);
}
.dm-ulv-el {
  border-radius: 4px;
}
.dm-fan-el {
  border-radius: 3px;
  border: none;
}
.dm-ulv-el.dm-ulv-dy3,
.dm-ulv-el.dm-ulv-dy4,
.dm-ulv-el.dm-ulv-dy5,
.dm-ulv-el.dm-ulv-dy6,
.dm-ulv-el.dm-ulv-dy7,
.dm-fan-el.dm-fan-dy1,
.dm-fan-el.dm-fan-dy2,
.dm-fan-el.dm-fan-dy3,
.dm-fan-el.dm-fan-dy4,
.dm-fan-el.dm-fan-dy5,
.dm-fan-el.dm-fan-dy6,
.dm-fan-el.dm-fan-dy7,
.dm-fan-el.dm-fan-dy8,
.dm-fan-el.dm-fan-dy9 {
  backdrop-filter: blur(11px) saturate(1.38);
  -webkit-backdrop-filter: blur(11px) saturate(1.38);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.24),
    inset 0 -1px 0 rgba(0, 0, 0, 0.09),
    0 1px 4px rgba(0, 0, 0, 0.14);
}
.dm-chat-pill.dm-ulv-el {
  padding: 1px 5px;
  gap: 0;
  justify-content: center;
  font-weight: 700;
  align-items: center;
  min-height: 1.1rem;
  box-sizing: border-box;
}
/* portrait styles kept for potential future use */
.dm-chat-ulv-portrait {
  display: none;
}
.dm-chat-pill-ulv-num {
  display: inline-block;
  box-sizing: border-box;
  min-width: 2ch;
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-style: normal;
  font-weight: 600;
  font-size: 0.9em;
}
/* 粉丝牌：旗帜/徽章造型 — 左段盾形等级 + 右段旗尾牌名 */
.dm-chat-pill.dm-fan-el {
  padding: 0;
  gap: 0;
  width: 7.5em;
  min-width: 7.5em;
  max-width: 7.5em;
  overflow: visible;
  font-weight: 600;
  align-items: stretch;
  flex-shrink: 0;
  box-sizing: border-box;
  border-radius: 3px;
  border: none;
  box-shadow: 0 1px 3px rgba(0,0,0,0.18);
  position: relative;
}
.dm-fan-seg {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-height: 1.1rem;
  align-self: stretch;
}
.dm-fan-seg--lv {
  flex: 0 0 2.2em;
  width: 2.2em;
  min-width: 2.2em;
  max-width: 2.2em;
  padding: 1px 4px 1px 3px;
  border-radius: 3px 0 0 3px;
  position: relative;
  /* Shield / pennant shape: rectangle with a right-pointing arrow */
  clip-path: polygon(0 0, calc(100% - 5px) 0, 100% 50%, calc(100% - 5px) 100%, 0 100%);
  margin-right: 2px;
}
/* Remove old ::after pseudo-element approach */
.dm-fan-seg--lv::after {
  display: none;
}
.dm-fan-seg--nm {
  flex: 1 1 auto;
  min-width: 0;
  padding: 1px 4px 1px 4px;
  border-radius: 0 3px 3px 0;
  border-left: none;
}
.dm-fan-lv-inner {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 100%;
  min-width: 0;
}
.dm-fan-seg-avatar {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}
.dm-fan-clickable {
  cursor: pointer;
}
.dm-fan-clickable:hover {
  filter: brightness(1.15);
}
/* 粉丝牌：左略深 — 右侧主色用表内 rgba(, , , 0.8)（灰档整段中性灰） */
.dm-fan-el.dm-fan-dy0 .dm-fan-seg--lv {
  background: rgba(82, 82, 82, 0.88);
}
.dm-fan-el.dm-fan-dy0 .dm-fan-seg--nm {
  background: rgba(102, 102, 102, 0.8);
}
.dm-fan-el.dm-fan-dy1 .dm-fan-seg--lv {
  background: rgba(31, 138, 128, 0.88);
}
.dm-fan-el.dm-fan-dy1 .dm-fan-seg--nm {
  background: rgba(38, 166, 154, 0.8);
}
.dm-fan-el.dm-fan-dy2 .dm-fan-seg--lv {
  background: rgba(44, 99, 162, 0.85);
}
.dm-fan-el.dm-fan-dy2 .dm-fan-seg--nm {
  background: rgba(54, 123, 202, 0.8);
}
.dm-fan-el.dm-fan-dy3 .dm-fan-seg--lv {
  background: rgba(88, 52, 155, 0.85);
}
.dm-fan-el.dm-fan-dy3 .dm-fan-seg--nm {
  background: rgba(111, 66, 193, 0.8);
}
.dm-fan-el.dm-fan-dy4 .dm-fan-seg--lv {
  background: rgba(184, 65, 0, 0.85);
}
.dm-fan-el.dm-fan-dy4 .dm-fan-seg--nm {
  background: rgba(230, 81, 0, 0.8);
}
.dm-fan-el.dm-fan-dy5 .dm-fan-seg--lv {
  background: rgba(196, 65, 24, 0.85);
}
.dm-fan-el.dm-fan-dy5 .dm-fan-seg--nm {
  background: rgba(244, 81, 30, 0.8);
}
.dm-fan-el.dm-fan-dy6 .dm-fan-seg--lv {
  background: rgba(169, 38, 38, 0.85);
}
.dm-fan-el.dm-fan-dy6 .dm-fan-seg--nm {
  background: rgba(211, 47, 47, 0.8);
}
.dm-fan-el.dm-fan-dy7 .dm-fan-seg--lv {
  background: rgba(173, 22, 77, 0.85);
}
.dm-fan-el.dm-fan-dy7 .dm-fan-seg--nm {
  background: rgba(216, 27, 96, 0.8);
}
/* 38 级紫粉渐变、39 级深蓝紫渐变：整胶囊一条渐变，左右段透明以保持连续过渡 */
.dm-chat-pill.dm-fan-el.dm-fan-dy8 {
  background: linear-gradient(90deg, #6f42c1, #e040fb);
}
.dm-chat-pill.dm-fan-el.dm-fan-dy9 {
  background: linear-gradient(90deg, #1a237e, #6f42c1);
}
.dm-fan-el.dm-fan-dy8 .dm-fan-seg--lv,
.dm-fan-el.dm-fan-dy8 .dm-fan-seg--nm,
.dm-fan-el.dm-fan-dy9 .dm-fan-seg--lv,
.dm-fan-el.dm-fan-dy9 .dm-fan-seg--nm {
  background: transparent;
}

.dm-fan-el.dm-fan-dy0 {
  color: #f5f5f5;
  text-shadow:
    0 0 1px rgba(0, 0, 0, 0.5),
    0 1px 2px rgba(0, 0, 0, 0.35);
}
.dm-fan-el.dm-fan-dy1,
.dm-fan-el.dm-fan-dy2,
.dm-fan-el.dm-fan-dy3,
.dm-fan-el.dm-fan-dy4,
.dm-fan-el.dm-fan-dy5,
.dm-fan-el.dm-fan-dy6,
.dm-fan-el.dm-fan-dy7,
.dm-fan-el.dm-fan-dy8,
.dm-fan-el.dm-fan-dy9 {
  color: #ffffff;
}
.dm-ulv-el.dm-ulv-dy0 {
  text-shadow:
    0 0 1px rgba(0, 0, 0, 0.55),
    0 1px 2px rgba(0, 0, 0, 0.35);
}
.dm-ulv-dy0 {
  background: color-mix(in srgb, #b8864f 70%, transparent);
  color: #ffffff;
}
.dm-ulv-dy1 {
  background: color-mix(in srgb, #33cc66 62%, transparent);
  color: #ffffff;
}
.dm-ulv-dy2 {
  background: color-mix(in srgb, #3399ff 62%, transparent);
  color: #ffffff;
}
.dm-ulv-dy3 {
  background: color-mix(in srgb, #7a43b7 64%, transparent);
  color: #ffffff;
}
.dm-ulv-dy4 {
  background: color-mix(in srgb, #9933ff 60%, transparent);
  color: #ffffff;
}
.dm-ulv-dy5 {
  background: color-mix(in srgb, #ff3399 58%, transparent);
  color: #ffffff;
}
.dm-ulv-dy6 {
  background: color-mix(in srgb, #ff3333 56%, transparent);
  color: #ffffff;
}
.dm-ulv-dy7 {
  background: linear-gradient(90deg, #ff1e50 0%, #9b2ef7 100%);
  color: #ffffff;
}

/* 礼物行粉丝牌 / 用户等级胶囊与弹幕行一致 */
.dm-gift-item .dm-chat-pill.dm-fan-el {
  border-radius: 3px;
  border: none;
  padding: 0;
  gap: 0;
  font-weight: 600;
  width: 7.5em;
  min-width: 7.5em;
  max-width: 7.5em;
  overflow: visible;
  align-items: stretch;
  flex-shrink: 0;
  box-sizing: border-box;
}
.dm-gift-item .dm-chat-pill.dm-fan-el .dm-fan-seg--nm {
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow: hidden;
}
.dm-chat-pill-lv { font-weight: 600; opacity: 0.95; font-size: 0.9em; }
.dm-chat-pill.dm-fan-el .dm-chat-pill-lv {
  opacity: 1;
  font-style: normal;
  flex-shrink: 0;
  box-sizing: border-box;
  min-width: 2ch;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.dm-chat-pill-bnn {
  font-weight: 700;
  font-style: normal;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
  max-width: 100%;
  text-align: center;
}
.dm-chat-ident {
  display: inline-flex;
  align-items: center;
  gap: 0.32rem;
  vertical-align: middle;
  margin-right: 0;
}
.dm-chat-nick {
  display: inline;
  font-weight: 600;
  color: color-mix(in srgb, var(--text) 78%, #c8d0e0);
  margin-right: 0;
  vertical-align: middle;
}
.dm-chat-colon {
  display: inline;
  font-weight: 600;
  color: color-mix(in srgb, var(--muted) 58%, var(--text));
  margin-right: 0.06em;
  vertical-align: baseline;
}
.dm-chat-txt {
  display: inline;
  font-weight: 400;
  color: color-mix(in srgb, var(--text) 90%, #e8ecf4);
  vertical-align: baseline;
}
.dm-time { color: var(--muted); font-size: 0.7rem; flex-shrink: 0; min-width: 58px; font-variant-numeric: tabular-nums; }

/* ---- Trigger section ---- */
.dm-trigger-section { display: flex; flex-direction: column; gap: 0.75rem; }
.dm-trigger-info {
  font-size: 0.8rem; color: var(--muted);
  border-radius: 12px; padding: 0.6rem 0.85rem;
  border: 1px solid color-mix(in srgb, #fff 6%, var(--border));
  background: color-mix(in srgb, var(--surface) 50%, transparent);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
.dm-trigger-add { display: flex; gap: 0.5rem; align-items: center; }
.dm-trigger-list { display: flex; flex-direction: column; gap: 6px; }
.dm-trigger-item {
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  padding: 0.55rem 0.75rem; border-radius: 12px;
  background: color-mix(in srgb, var(--surface) 50%, transparent);
  border: 1px solid color-mix(in srgb, #fff 6%, var(--border));
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  transition: background 0.15s, border-color 0.15s;
}
.dm-trigger-item:hover {
  background: color-mix(in srgb, var(--primary) 5%, var(--surface) 50%);
  border-color: color-mix(in srgb, var(--primary) 20%, var(--border));
}
.dm-trigger-item.disabled { opacity: 0.45; }
.dm-toggle { border: none; background: transparent; cursor: pointer; padding: 0; line-height: 0; }
.toggle-on, .toggle-off { display: inline-block; width: 34px; height: 20px; border-radius: 10px; position: relative; transition: background 0.2s; }
.toggle-on { background: linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary) 70%, #000)); }
.toggle-on::after { content: ''; position: absolute; top: 3px; left: 17px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
.toggle-off { background: color-mix(in srgb, var(--text) 15%, var(--border)); }
.toggle-off::after { content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.15); }
.dm-trigger-body { flex: 1; min-width: 0; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.dm-pattern {
  background: color-mix(in srgb, var(--primary) 8%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--primary) 15%, var(--border));
  padding: 2px 8px; border-radius: 6px; font-size: 0.82rem; font-weight: 600; color: var(--primary);
}
.dm-action-tag { font-size: 0.65rem; padding: 2px 7px; border-radius: 5px; font-weight: 600; }
.dm-action--log { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }
.dm-action--song-request { background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); }
.dm-trigger-desc { font-size: 0.75rem; color: var(--muted); }

/* Trigger room binding */
.dm-trigger-rooms-row {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 0.35rem 0; font-size: 0.75rem;
}
.dm-trigger-rooms-label { color: var(--muted); font-weight: 500; flex-shrink: 0; }
.dm-trigger-rooms-hint { color: var(--muted); font-size: 0.68rem; opacity: 0.7; font-style: italic; }
.dm-trigger-room-chip {
  display: inline-flex; align-items: center; padding: 2px 8px;
  border-radius: 999px; font-size: 0.68rem; font-weight: 500;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: color-mix(in srgb, var(--surface) 50%, transparent);
  color: var(--muted); cursor: pointer; transition: all 0.15s; user-select: none;
}
.dm-trigger-room-chip:hover { border-color: color-mix(in srgb, var(--primary) 40%, var(--border)); color: var(--text); }
.dm-trigger-room-chip.active {
  background: color-mix(in srgb, var(--primary) 14%, transparent);
  border-color: color-mix(in srgb, var(--primary) 40%, var(--border));
  color: var(--primary); font-weight: 600;
}
.dm-trigger-room-chip--sm { font-size: 0.62rem; padding: 1px 6px; }
.dm-trigger-room-edit { display: flex; gap: 4px; flex-wrap: wrap; margin-left: auto; flex-shrink: 0; }
.dm-trigger-bound-rooms { display: inline-flex; gap: 3px; flex-wrap: wrap; }
.dm-trigger-bound-chip {
  display: inline-flex; align-items: center; padding: 1px 6px;
  border-radius: 999px; font-size: 0.62rem; font-weight: 600;
  background: color-mix(in srgb, var(--primary) 10%, transparent);
  color: var(--primary); cursor: pointer; transition: all 0.15s;
}
.dm-trigger-bound-chip:hover { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); }
.dm-trigger-bound-all { font-size: 0.65rem; color: var(--muted); opacity: 0.7; font-style: italic; }
.dm-select {
  padding: 0.35rem 0.5rem;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface) 50%, transparent);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  color: var(--text); font-size: 0.82rem; outline: none; cursor: pointer;
  transition: border-color 0.15s; appearance: auto;
}
.dm-select:focus { border-color: color-mix(in srgb, var(--primary) 50%, var(--border)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent); }
.dm-select--sm { padding: 0.3rem 0.45rem; font-size: 0.78rem; }

/* ---- Log section ---- */
.dm-log-section { display: flex; flex-direction: column; }
.dm-log-toolbar { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
.dm-log-count { font-size: 0.8rem; color: var(--muted); flex: 1; }
.dm-log-list {
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: linear-gradient(195deg,
    color-mix(in srgb, var(--primary) 4%, transparent) 0%,
    color-mix(in srgb, var(--bg) 25%, transparent) 55%,
    color-mix(in srgb, var(--surface) 40%, transparent) 100%);
  box-shadow: 0 4px 20px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.05);
  backdrop-filter: blur(16px) saturate(1.2);
  -webkit-backdrop-filter: blur(16px) saturate(1.2);
  max-height: 420px; overflow-y: auto;
}
.dm-log-item {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.5rem 0.85rem;
  border-bottom: 1px solid color-mix(in srgb, #fff 4%, var(--border));
  font-size: 0.8rem;
}
.dm-log-item:last-child { border-bottom: none; }
.dm-log-item .dm-nick {
  color: var(--primary);
  font-weight: 600;
  flex-shrink: 0;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.dm-log-text { color: var(--accent); font-weight: 600; word-break: break-all; }

/* Song panel overlay — frosted glass (modern music app style) */
.dm-overlay {
  position: fixed; inset: 0; z-index: 9999;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(12px) saturate(1.4);
  -webkit-backdrop-filter: blur(12px) saturate(1.4);
  animation: fadeIn 0.2s ease-out;
}
.dm-stats-panel {
  width: 640px; max-width: 92vw; max-height: 82vh;
  display: flex; flex-direction: column;
  border-radius: 20px;
  border: 1px solid color-mix(in srgb, #fff 12%, var(--border));
  background: linear-gradient(
    160deg,
    color-mix(in srgb, var(--surface) 88%, var(--primary) 4%) 0%,
    color-mix(in srgb, var(--surface) 95%, transparent) 100%
  );
  backdrop-filter: blur(24px) saturate(1.3);
  -webkit-backdrop-filter: blur(24px) saturate(1.3);
  box-shadow:
    0 24px 80px rgba(0, 0, 0, 0.28),
    0 8px 24px rgba(0, 0, 0, 0.12),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.dm-stats-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1.1rem 1.35rem 0.65rem;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
}
.dm-stats-header h3 {
  margin: 0; font-size: 1.05rem; font-weight: 700; color: var(--text);
  display: flex; align-items: center; gap: 0.5rem;
  letter-spacing: -0.01em;
}
.dm-stats-room { font-size: 0.72rem; color: var(--muted); font-weight: 500; opacity: 0.8; }
.dm-stats-actions { display: flex; gap: 0.4rem; align-items: center; }
.dm-stats-close {
  border: none; cursor: pointer; line-height: 0;
  width: 30px; height: 30px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--muted); transition: all 0.15s;
}
.dm-stats-close:hover { background: color-mix(in srgb, var(--text) 12%, transparent); color: var(--text); transform: scale(1.05); }

/* Song panel tabs — pill style */
.dm-song-tabs {
  display: flex; gap: 4px; margin: 0.65rem 1.25rem 0.5rem;
  padding: 3px; border-radius: 10px;
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
.dm-song-tabs button {
  flex: 1; padding: 0.4rem 0.6rem; border: none; background: transparent;
  color: var(--dm-ui-muted); cursor: pointer;
  font-family: inherit;
  font-size: 0.76rem; font-weight: 600;
  border-radius: 8px; transition: all 0.2s; white-space: nowrap;
}
.dm-song-tabs button.active {
  background: var(--surface); color: var(--dm-ui-body);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1), 0 0 0 1px color-mix(in srgb, #fff 8%, var(--border));
}
.dm-song-tabs button:hover:not(.active) { color: var(--dm-ui-body); background: color-mix(in srgb, var(--text) 4%, transparent); }

.dm-song-toolbar {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.35rem 1.25rem 0.5rem;
}
.dm-song-hint { font-size: 0.72rem; color: var(--muted); flex: 1; opacity: 0.8; }

.dm-stats-info { font-size: 0.72rem; color: var(--muted); padding: 0 1.25rem 0.6rem; opacity: 0.8; }
.dm-stats-table {
  overflow-y: auto; padding: 0 0.75rem 0.85rem; flex: 1;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--primary) 30%, var(--border)) transparent;
}
.dm-stats-table::-webkit-scrollbar:vertical {
  width: 5px;
}
.dm-stats-table::-webkit-scrollbar:horizontal {
  height: 4px;
}
.dm-stats-table::-webkit-scrollbar-track {
  background: transparent;
  margin: 4px 0;
}
.dm-stats-table::-webkit-scrollbar-track:horizontal {
  margin: 0 6px 4px;
}
.dm-stats-table::-webkit-scrollbar-thumb {
  border-radius: 100px;
  background: color-mix(in srgb, var(--primary) 30%, var(--border));
}
.dm-stats-table::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--primary) 50%, var(--border));
}
.dm-stats-row {
  display: flex; align-items: center;
  padding: 0.5rem 0.65rem; border-radius: 10px; font-size: 0.82rem;
  margin-bottom: 2px; transition: background 0.12s;
}
.dm-stats-row:hover:not(.dm-stats-row--head) {
  background: color-mix(in srgb, var(--primary) 6%, var(--surface));
}
.dm-stats-row--head {
  font-size: 0.68rem; color: var(--muted); font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.6px;
  margin-bottom: 4px; padding-bottom: 0.4rem;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
}
.dm-stats-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-stats-cell--rank { width: 30px; flex-shrink: 0; color: var(--muted); font-variant-numeric: tabular-nums; }
.dm-stats-cell--key { flex: 1; min-width: 0; }
.dm-stats-cell--key code { background: color-mix(in srgb, var(--primary) 8%, var(--bg)); padding: 2px 8px; border-radius: 5px; font-size: 0.82rem; font-weight: 600; color: var(--primary); }
.dm-stats-cell--count { width: 60px; flex-shrink: 0; text-align: right; font-variant-numeric: tabular-nums; }
.dm-stats-cell--count strong { color: var(--primary); }
.dm-stats-cell--time { width: 70px; flex-shrink: 0; text-align: right; color: var(--muted); font-size: 0.72rem; font-variant-numeric: tabular-nums; }

/* Song-specific cells */
.dm-stats-cell--time2 { width: 72px; flex-shrink: 0; color: var(--muted); font-size: 0.72rem; font-variant-numeric: tabular-nums; }
.dm-stats-cell--song { flex: 1; min-width: 0; color: var(--text); }
.dm-stats-cell--song strong { color: var(--primary); font-weight: 600; }
.dm-stats-cell--artist { width: 90px; flex-shrink: 0; color: var(--muted); text-align: center; font-size: 0.78rem; }
.dm-stats-cell--count2 { width: 50px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.dm-stats-cell--count2 strong { color: var(--primary); font-size: 0.92rem; font-weight: 700; }

/* Requester column & dropdown */
.dm-stats-cell--requester { width: 90px; flex-shrink: 0; text-align: center; font-size: 0.75rem; color: var(--muted); }
.dm-stats-cell--expand { display: inline-flex; align-items: center; justify-content: center; gap: 4px; cursor: pointer; }
.dm-stats-cell--expand svg { transition: transform 0.2s; color: var(--muted); }
.dm-stats-cell--expand svg.rotated { transform: rotate(180deg); }
.dm-requester-badge {
  display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 0.68rem; font-weight: 600;
  background: color-mix(in srgb, var(--primary) 12%, transparent); color: var(--primary);
}
.dm-stats-row--clickable { cursor: pointer; }
.dm-stats-row--clickable:hover { background: color-mix(in srgb, var(--primary) 8%, var(--surface)); }
.dm-requesters-dropdown {
  margin: 0 0.75rem 6px 0.75rem; padding: 0.4rem 0.65rem;
  border-radius: 10px; background: color-mix(in srgb, var(--text) 4%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  max-height: 140px; overflow-y: auto;
}
.dm-requester-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 3px 4px; font-size: 0.74rem; border-radius: 4px;
}
.dm-requester-item:hover { background: color-mix(in srgb, var(--primary) 6%, transparent); }
.dm-requester-name { color: var(--text); font-weight: 500; }
.dm-requester-time { color: var(--muted); font-size: 0.68rem; font-variant-numeric: tabular-nums; }

@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

@media (max-width: 600px) {
  .dm-panel { padding: 0.75rem 0.75rem 4rem; }
  .dm-input { width: 100px; font-size: 0.8rem; font-family: inherit; }
  .dm-feed { height: 300px; font-size: 0.72rem; }
  .dm-tabs button {
    padding: 0.3rem 0.48rem;
    font-size: 0.7rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dm-stats-panel { width: 96vw; max-width: 96vw; border-radius: 14px; }
  .dm-song-tabs { margin: 0.5rem 0.85rem 0.4rem; }
  .dm-song-toolbar { padding: 0.25rem 0.85rem 0.4rem; }
  .dm-room-card { flex-wrap: wrap; }
  .dm-feed-split { flex-direction: column; }
  .dm-feed-split .dm-feed-right {
    flex: 1 1 0;
    min-height: 0;
    height: auto;
  }
  .dm-gift-panel { height: 100%; }
  .dm-gift-item { font-size: 0.68rem; }
}

/* ---- UID tooltip (hover on nicknames) ---- */
.dm-chat-nick,
.dm-gift-nick,
.dm-gift-stats-user-nick {
  cursor: pointer;
}
</style>

<!-- Global styles for UID tooltip (Teleported to body, outside scoped) -->
<style>
.dm-uid-tooltip {
  position: fixed;
  z-index: 2147483647;
  transform: translate(-50%, -100%);
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(30, 30, 40, 0.82);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: #e0e4ec;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.08) inset;
  line-height: 1.5;
}
.dm-uid-tooltip::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 100%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: rgba(30, 30, 40, 0.82);
}
/* Transition */
.dm-uid-tip-enter-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.dm-uid-tip-leave-active { transition: opacity 0.1s ease, transform 0.1s ease; }
.dm-uid-tip-enter-from,
.dm-uid-tip-leave-to {
  opacity: 0;
  transform: translate(-50%, -100%) translateY(4px);
}
</style>
