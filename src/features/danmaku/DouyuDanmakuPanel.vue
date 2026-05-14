<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from "vue";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface DanmakuMsg { type: string; uid: string; nn: string; txt: string; level: string; ts: number; roomId?: string; }
interface TriggerConfig { id: string; pattern: string; action: string; enabled: boolean; description: string; roomIds?: string[]; }
interface TriggerLogEntry { triggerId: string; pattern: string; action: string; content: string; nickname: string; uid: string; fullText: string; ts: number; source?: string; roomId?: string; }
interface RoomInfo { room_id: number; room_name: string; owner_name: string; owner_uid: string | number; show_status: number; game_name: string; cate_name: string; online_num: number; fans_num: number; room_thumb: string; start_time: number; avatar: string; }
interface GiftMsg { type?: string; uid?: string; nn?: string; gfid?: string; gfcnt?: string; hits?: string; gs?: string; bg?: string; bnn?: string; bl?: string; brid?: string; level?: string; ic?: string; rid?: string; roomId: string; ts: number; [key: string]: unknown; }
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
const giftList = ref<GiftMsg[]>([]);
const giftAutoScroll = ref(true);
const giftFeedRef = ref<HTMLElement | null>(null);
const MAX_GIFT = 300;
// Gift panel ratio: 0 (hidden) to 0.95 (max, never exceeds danmaku width)
const giftPanelRatio = ref(0.33);
const GIFT_RATIO_STEP = 0.1;
const GIFT_RATIO_MIN = 0;
const GIFT_RATIO_MAX = 0.95;
function giftPanelWider() { giftPanelRatio.value = Math.min(GIFT_RATIO_MAX, +(giftPanelRatio.value + GIFT_RATIO_STEP).toFixed(2)); }
function giftPanelNarrower() {
  const next = +(giftPanelRatio.value - GIFT_RATIO_STEP).toFixed(2);
  if (next <= 0.05) { giftPanelRatio.value = 0; showGiftPanel.value = false; }
  else { giftPanelRatio.value = next; }
}
// Mobile: height ratio for vertical layout
const giftPanelHeight = ref(200); // px
const GIFT_HEIGHT_STEP = 50;
const GIFT_HEIGHT_MIN = 80;
const GIFT_HEIGHT_MAX = 500;
function giftPanelTaller() { giftPanelHeight.value = Math.min(GIFT_HEIGHT_MAX, giftPanelHeight.value + GIFT_HEIGHT_STEP); }
function giftPanelShorter() {
  const next = giftPanelHeight.value - GIFT_HEIGHT_STEP;
  if (next < GIFT_HEIGHT_MIN) { giftPanelHeight.value = GIFT_HEIGHT_MIN; showGiftPanel.value = false; }
  else { giftPanelHeight.value = next; }
}
const isMobile = ref(window.innerWidth <= 600);
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => { isMobile.value = window.innerWidth <= 600; });
}

// Gift info mapping (loaded from Douyu API per room)
interface GiftInfo { name: string; icon: string; cost: number; value: number; }
const giftInfoMap = ref<Record<string, GiftInfo>>({});
const giftInfoLoading = ref(false);

// Fallback well-known gift names (used when API unavailable)
const GIFT_NAMES_FALLBACK: Record<string, string> = {
  "1": "鱼丸", "2": "鱼翅", "268": "赞", "519": "呵呵", "520": "稳",
  "824": "火箭", "380": "超级火箭", "750": "办卡", "195": "飞机", "196": "跑车",
  "4": "鱼雷", "6": "飞吻", "3": "弱鸡", "714": "怦然心动", "713": "告白",
};
function giftName(gfid: string): string {
  const info = giftInfoMap.value[gfid];
  if (info) return info.name;
  return GIFT_NAMES_FALLBACK[gfid] || `#${gfid}`;
}
function giftIcon(gfid: string): string {
  return giftInfoMap.value[gfid]?.icon || "";
}
async function loadGiftInfoForRoom(rid: string) {
  giftInfoLoading.value = true;
  try {
    const d = await (await fetch(`${API}/gift-list/${encodeURIComponent(rid)}`)).json();
    if (d.ok && d.gifts) giftInfoMap.value = d.gifts;
  } catch { /* */ }
  giftInfoLoading.value = false;
}

// Badge (fan medal) avatar cache: brid -> avatar URL
const badgeAvatarCache = ref<Record<string, string>>({});
async function loadBadgeAvatar(brid: string) {
  if (!brid || badgeAvatarCache.value[brid] !== undefined) return;
  badgeAvatarCache.value[brid] = ""; // mark as loading
  try {
    const d = await (await fetch(`${API}/badge-avatar/${encodeURIComponent(brid)}`)).json();
    if (d.ok && d.avatar) badgeAvatarCache.value[brid] = d.avatar;
  } catch { /* */ }
}
function badgeAvatar(brid: string): string {
  if (!brid) return "";
  if (badgeAvatarCache.value[brid] === undefined) loadBadgeAvatar(brid);
  return badgeAvatarCache.value[brid] || "";
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
  const es = new EventSource(`${API}/events`);
  es.addEventListener("rooms", (e) => {
    try {
      const rooms: BackendRoomStatus[] = JSON.parse(e.data);
      for (const r of rooms) { const ex = backendRooms.value.find(x => x.roomId === r.roomId); if (ex?.info) r.info = ex.info; }
      backendRooms.value = rooms;
      if (backendSelectedRoom.value && !rooms.some(r => r.roomId === backendSelectedRoom.value)) backendSelectedRoom.value = rooms.length > 0 ? rooms[0].roomId : null;
    } catch { /* */ }
  });
  es.addEventListener("danmaku", (e) => {
    try {
      const msg: DanmakuMsg = JSON.parse(e.data);
      if (backendSelectedRoom.value && msg.roomId === backendSelectedRoom.value) {
        backendDanmakuList.value.push(msg);
        if (backendDanmakuList.value.length > MAX_DANMAKU) backendDanmakuList.value = backendDanmakuList.value.slice(-MAX_DANMAKU);
        if (backendAutoScroll.value) nextTick(() => scrollEl(backendFeedRef.value));
      }
    } catch { /* */ }
  });
  es.addEventListener("trigger", (e) => { try { const entry: TriggerLogEntry = JSON.parse(e.data); if (backendSelectedRoom.value && entry.roomId === backendSelectedRoom.value) { triggerLog.value.unshift(entry); if (triggerLog.value.length > 200) triggerLog.value = triggerLog.value.slice(0, 200); } } catch { /* */ } });
  es.addEventListener("gift", (e) => {
    try {
      const msg: GiftMsg = JSON.parse(e.data);
      if (backendSelectedRoom.value && msg.roomId === backendSelectedRoom.value) {
        giftList.value.push(msg);
        if (giftList.value.length > MAX_GIFT) giftList.value = giftList.value.slice(-MAX_GIFT);
        if (giftAutoScroll.value) nextTick(() => scrollEl(giftFeedRef.value));
      }
    } catch { /* */ }
  });
  es.addEventListener("song-request", (e) => {
    try {
      const d = JSON.parse(e.data);
      if (showSongPanel.value && songPanelRoomId.value === d.roomId) {
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
    const r = backendRooms.value.find(x => x.roomId === rid); if (r) r.info = info;
  } catch (e: unknown) { backendError.value = e instanceof Error ? e.message : "添加失败"; }
}

async function backendRemoveRoom(rid: string) {
  try { await fetch(`${API}/rooms/${encodeURIComponent(rid)}`, { method: "DELETE", headers: { "X-Password": getBackendPw() } }); } catch { /* */ }
  // Immediately remove from local list and switch selection
  backendRooms.value = backendRooms.value.filter(r => r.roomId !== rid);
  if (backendSelectedRoom.value === rid) {
    const first = backendRooms.value.length > 0 ? backendRooms.value[0].roomId : null;
    backendSelectedRoom.value = first;
    backendDanmakuList.value = [];
    giftList.value = [];
    if (first) onBackendRoomSelect(first);
  }
}

async function onBackendRoomSelect(rid: string) {
  backendSelectedRoom.value = rid;
  backendDanmakuList.value = [];
  triggerLog.value = [];
  giftList.value = [];
  // Load recent 100 danmaku from recording
  const msgs = await loadRecentDanmaku(rid);
  backendDanmakuList.value = msgs;
  nextTick(() => scrollEl(backendFeedRef.value));
  // Reload action log for this room
  loadActionLog();
  // Load gifts for this room
  loadGiftsForRoom(rid);
  // Load gift info (names + icons) from Douyu API
  loadGiftInfoForRoom(rid);
  // Fetch room info if missing
  const r = backendRooms.value.find(x => x.roomId === rid);
  if (r && !r.info) fetchRoomInfo(rid).then(info => { r.info = info; });
}

/* ------------------------------------------------------------------ */
/*  Gift API                                                          */
/* ------------------------------------------------------------------ */

// Gift panel sub-tabs
type GiftSubTab = 'records' | 'stats';
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
  byUser: Record<string, { nn: string; count: number; gifts: Record<string, number> }>;
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
        gfid, count: v.count, name: giftName(gfid), icon: giftIcon(gfid),
        cost: (info?.cost || 0), value: (info?.value || 0),
      };
    })
    .sort((a, b) => (b.value * b.count) - (a.value * a.count));
});
const giftStatsByUserSorted = computed(() => {
  if (!giftStats.value) return [];
  return Object.entries(giftStats.value.byUser)
    .map(([uid, v]) => ({ uid, nn: v.nn, count: v.count, gifts: v.gifts }))
    .sort((a, b) => b.count - a.count);
});
// Total cost (开销) and total value (价值) in 元
const giftStatsTotalCost = computed(() => {
  if (!giftStats.value) return 0;
  let total = 0;
  for (const [gfid, v] of Object.entries(giftStats.value.byGift)) {
    const cost = giftInfoMap.value[gfid]?.cost || 0;
    total += cost * v.count;
  }
  return total / 10; // 10鱼翅=1元
});
const giftStatsTotalValue = computed(() => {
  if (!giftStats.value) return 0;
  let total = 0;
  for (const [gfid, v] of Object.entries(giftStats.value.byGift)) {
    const value = giftInfoMap.value[gfid]?.value || 0;
    total += value * v.count;
  }
  return total / 10; // 10贡献=1元
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
    if (d.ok) { giftList.value = d.gifts; nextTick(() => scrollEl(giftFeedRef.value)); }
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
function roomLabel(rid: string): string { const r = backendRooms.value.find(x => x.roomId === rid); return r?.info?.owner_name || rid; }
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

const selectedBackendRoom = computed(() => backendRooms.value.find(r => r.roomId === backendSelectedRoom.value) || null);

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                         */
/* ------------------------------------------------------------------ */

onMounted(() => {
  connectSSE(); loadTriggers(); loadActionLog();
});

onUnmounted(() => {
  if (eventSource) { eventSource.close(); eventSource = null; }
});

defineExpose({ reload: () => { loadTriggers(); loadActionLog(); } });
</script>

<template>
  <section class="dm-panel">


    <!-- ==================== Backend capture ==================== -->
    <div class="dm-mode-content">
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
          <div v-for="room in backendRooms" :key="room.roomId" class="dm-room-chip" :class="{ selected: backendSelectedRoom === room.roomId }" @click="onBackendRoomSelect(room.roomId)">
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

        <nav class="dm-tabs">
          <button :class="{ active: activeSubTab === 'danmaku' }" @click="activeSubTab = 'danmaku'">弹幕流</button>
          <button :class="{ active: activeSubTab === 'triggers' }" @click="activeSubTab = 'triggers'">触发器</button>
          <button :class="{ active: activeSubTab === 'log' }" @click="activeSubTab = 'log'">日志 <sup v-if="triggerLog.length" class="dm-badge">{{ triggerLog.length }}</sup></button>
        </nav>

        <div v-if="activeSubTab === 'danmaku'" class="dm-feed-section">
          <div class="dm-feed-toolbar">
            <label class="dm-check"><input v-model="backendAutoScroll" type="checkbox" /> 自动滚动</label>
            <button class="dm-btn dm-btn--ghost dm-btn--sm" @click="backendDanmakuList = []">清空</button>
            <span style="flex:1"></span>
            <button class="dm-btn dm-btn--sm" :class="showGiftPanel ? 'dm-btn--primary' : 'dm-btn--ghost'" @click="showGiftPanel = !showGiftPanel">🎁 礼物 <sup v-if="giftList.length" class="dm-badge">{{ giftList.length }}</sup></button>
          </div>
          <div class="dm-feed-split" :class="{ 'dm-feed-split--open': showGiftPanel, 'dm-feed-split--mobile': isMobile }" :style="showGiftPanel ? (isMobile ? { '--gift-height': giftPanelHeight + 'px' } : { '--gift-ratio': String(giftPanelRatio) }) : {}">
            <!-- Left: danmaku feed -->
            <div class="dm-feed-left">
              <div ref="backendFeedRef" class="dm-feed">
                <div v-if="backendDanmakuList.length === 0" class="dm-empty">{{ backendRooms.length === 0 ? '请添加直播间' : '点击直播间加载弹幕' }}</div>
                <div v-for="(msg, idx) in backendDanmakuList" :key="idx" class="dm-msg" :class="{ 'dm-msg--cmd': msg.txt.startsWith('#') }"><span class="dm-time">{{ formatTime(msg.ts) }}</span><span class="dm-nick">{{ msg.nn }}</span><span class="dm-txt">{{ msg.txt }}</span></div>
              </div>
            </div>
            <!-- Right: gift panel -->
            <div v-if="showGiftPanel" class="dm-feed-right">
              <div class="dm-gift-panel">
                <div class="dm-gift-header">
                  <div class="dm-gift-header-row1">
                    <span class="dm-gift-header-icon">🎁</span>
                    <nav class="dm-gift-tabs">
                      <button :class="{ active: giftSubTab === 'records' }" @click="giftSubTab = 'records'">记录</button>
                      <button :class="{ active: giftSubTab === 'stats' }" @click="giftSubTab = 'stats'">统计</button>
                    </nav>
                    <span style="flex:1"></span>
                    <div class="dm-gift-size-group">
                      <button class="dm-gift-size-btn" @click="isMobile ? giftPanelShorter() : giftPanelNarrower()" :title="isMobile ? '变矮' : '变窄'">{{ isMobile ? '▲' : '◀' }}</button>
                      <button class="dm-gift-size-btn" @click="isMobile ? giftPanelTaller() : giftPanelWider()" :title="isMobile ? '变高' : '变宽'">{{ isMobile ? '▼' : '▶' }}</button>
                    </div>
                  </div>
                  <!-- Records sub-header -->
                  <div v-if="giftSubTab === 'records'" class="dm-gift-header-row2">
                    <span v-if="giftList.length > 0" class="dm-gift-count">{{ giftList.length }}条</span>
                    <span style="flex:1"></span>
                    <button v-if="giftList.length > 0" class="dm-btn dm-btn--ghost dm-btn--xs" @click="clearGiftsForRoom">清空</button>
                    <button class="dm-btn dm-btn--ghost dm-btn--xs" @click="backendSelectedRoom && loadGiftsForRoom(backendSelectedRoom)">刷新</button>
                  </div>
                  <!-- Stats sub-header -->
                  <div v-if="giftSubTab === 'stats'" class="dm-gift-header-row2">
                    <div class="dm-gift-range-group">
                      <button v-for="r in GIFT_STATS_RANGES" :key="r.value" class="dm-gift-range-btn" :class="{ active: giftStatsRange === r.value }" @click="giftStatsRange = r.value">{{ r.label }}</button>
                    </div>
                    <span style="flex:1"></span>
                    <button class="dm-btn dm-btn--ghost dm-btn--xs" @click="backendSelectedRoom && loadGiftStats(backendSelectedRoom, giftStatsRange)">刷新</button>
                  </div>
                </div>
                <div class="dm-gift-body">
                  <!-- Records view -->
                  <div v-if="giftSubTab === 'records'" ref="giftFeedRef" class="dm-gift-feed">
                    <div v-if="giftList.length === 0" class="dm-empty">暂无礼物记录</div>
                    <div v-for="(g, idx) in giftList" :key="idx" class="dm-gift-item" :class="{ 'dm-gift--big': g.bg === '1' }">
                      <img v-if="giftIcon(g.gfid || '')" :src="giftIcon(g.gfid || '')" class="dm-gift-icon" alt="" referrerpolicy="no-referrer" />
                      <span v-else class="dm-gift-icon-placeholder">🎁</span>
                      <span class="dm-time">{{ formatTime(g.ts) }}</span>
                      <span class="dm-gift-nick">{{ g.nn || '' }}</span>
                      <span v-if="g.bnn" class="dm-gift-badge">
                        <img v-if="badgeAvatar(g.brid || '')" :src="badgeAvatar(g.brid || '')" class="dm-badge-avatar" alt="" referrerpolicy="no-referrer" />
                        {{ g.bnn }}<span class="dm-badge-lv">{{ g.bl }}</span>
                      </span>
                      <span class="dm-gift-name">{{ giftName(g.gfid || '') }}</span>
                      <span v-if="Number(g.hits) > 1" class="dm-gift-combo">×{{ g.hits }}</span>
                      <span v-else-if="Number(g.gs) > 1" class="dm-gift-combo">×{{ g.gs }}</span>
                      <span v-if="g.level" class="dm-gift-ulv">Lv{{ g.level }}</span>
                    </div>
                  </div>
                  <!-- Stats view -->
                  <div v-if="giftSubTab === 'stats'" class="dm-gift-stats">
                    <div v-if="giftStatsLoading" class="dm-empty">加载中...</div>
                    <template v-else-if="giftStats">
                      <div class="dm-gift-stats-summary">
                        <div class="dm-gift-stats-card">
                          <span class="dm-gift-stats-label">总数量</span>
                          <span class="dm-gift-stats-value">{{ giftStats.totalCount }}</span>
                        </div>
                        <div class="dm-gift-stats-card">
                          <span class="dm-gift-stats-label">总开销</span>
                          <span class="dm-gift-stats-value dm-gift-stats-value--cost">{{ giftStatsTotalCost.toFixed(1) }}元</span>
                        </div>
                        <div class="dm-gift-stats-card">
                          <span class="dm-gift-stats-label">总价值</span>
                          <span class="dm-gift-stats-value dm-gift-stats-value--gold">{{ giftStatsTotalValue.toFixed(1) }}元</span>
                        </div>
                        <div class="dm-gift-stats-card">
                          <span class="dm-gift-stats-label">送礼人数</span>
                          <span class="dm-gift-stats-value">{{ giftStatsByUserSorted.length }}</span>
                        </div>
                      </div>
                      <div class="dm-gift-stats-section">
                        <div class="dm-gift-stats-section-title">按礼物</div>
                        <div v-for="item in giftStatsByGiftSorted" :key="item.gfid" class="dm-gift-stats-row">
                          <img v-if="item.icon" :src="item.icon" class="dm-gift-icon-sm" alt="" referrerpolicy="no-referrer" />
                          <span v-else class="dm-gift-icon-sm-placeholder">🎁</span>
                          <span class="dm-gift-stats-name">{{ item.name }}</span>
                          <span class="dm-gift-stats-cnt">×{{ item.count }}</span>
                          <span v-if="item.value" class="dm-gift-stats-price">值{{ (item.value * item.count / 10).toFixed(1) }}元</span>
                          <span v-if="item.cost" class="dm-gift-stats-cost">花{{ (item.cost * item.count / 10).toFixed(1) }}元</span>
                        </div>
                        <div v-if="giftStatsByGiftSorted.length === 0" class="dm-empty">暂无数据</div>
                      </div>
                      <div class="dm-gift-stats-section">
                        <div class="dm-gift-stats-section-title">按用户</div>
                        <div v-for="item in giftStatsByUserSorted" :key="item.uid" class="dm-gift-stats-row">
                          <span class="dm-gift-stats-nick">{{ item.nn || item.uid }}</span>
                          <span class="dm-gift-stats-cnt">×{{ item.count }}</span>
                        </div>
                        <div v-if="giftStatsByUserSorted.length === 0" class="dm-empty">暂无数据</div>
                      </div>
                    </template>
                    <div v-else class="dm-empty">点击刷新加载统计</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

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
            <div v-for="(entry, idx) in triggerLog" :key="idx" class="dm-log-item"><span class="dm-time">{{ formatTime(entry.ts) }}</span><span class="dm-nick">{{ entry.nickname }}</span><code class="dm-pattern">{{ entry.pattern }}</code><span class="dm-log-text">{{ entry.content }}</span></div>
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
  outline: none; box-shadow: none; color: var(--text);
}
.dm-add-row .dm-input::placeholder { color: var(--muted); opacity: 0.7; }
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
  color: #fff !important;
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
  color: var(--text); font-size: 0.85rem; outline: none; width: 140px;
  transition: border-color 0.18s, box-shadow 0.18s;
}
.dm-input::placeholder { color: var(--muted); opacity: 0.7; }
.dm-input:focus {
  border-color: color-mix(in srgb, var(--primary) 50%, var(--border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent);
}
.dm-input--sm { padding: 0.35rem 0.6rem; font-size: 0.8rem; }
.dm-btn {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 0.45rem 0.9rem; border-radius: 10px;
  border: 1px solid color-mix(in srgb, #fff 8%, var(--border));
  background: color-mix(in srgb, var(--surface) 50%, transparent);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  color: var(--text); cursor: pointer; font-size: 0.82rem; font-weight: 500;
  white-space: nowrap; transition: all 0.15s;
}
.dm-btn:hover {
  border-color: color-mix(in srgb, var(--primary) 40%, var(--border));
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 8%, transparent);
}
.dm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.dm-btn--primary {
  background: linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary) 80%, #000));
  color: var(--on-primary); border-color: color-mix(in srgb, #fff 15%, var(--primary));
  box-shadow: 0 2px 8px color-mix(in srgb, var(--primary) 30%, transparent);
}
.dm-btn--primary:hover { filter: brightness(1.1); color: var(--on-primary); }
.dm-btn--ghost { border-color: transparent; background: transparent; backdrop-filter: none; }
.dm-btn--ghost:hover { background: color-mix(in srgb, var(--text) 6%, transparent); }
.dm-btn--outline {
  border: 1.5px solid color-mix(in srgb, var(--primary) 50%, var(--border));
  background: color-mix(in srgb, var(--primary) 6%, transparent);
  color: var(--primary); font-weight: 600; backdrop-filter: none;
}
.dm-btn--outline:hover {
  border-color: var(--primary);
  background: color-mix(in srgb, var(--primary) 14%, transparent);
  color: var(--primary);
  box-shadow: 0 1px 6px color-mix(in srgb, var(--primary) 20%, transparent);
}
.dm-btn--sm { padding: 0.3rem 0.6rem; font-size: 0.75rem; }
.dm-error { color: var(--danger, #ff6b6b); font-size: 0.8rem; margin: 0.35rem 0; }

/* ---- Sub-tabs (pill style) ---- */
.dm-tabs {
  display: flex; gap: 4px; margin-bottom: 0.85rem;
  padding: 3px; border-radius: 12px;
  background: color-mix(in srgb, var(--text) 5%, transparent);
  border: 1px solid color-mix(in srgb, #fff 4%, var(--border));
}
.dm-tabs button {
  flex: 1; padding: 0.45rem 0.8rem; border: none; background: transparent;
  color: var(--muted); cursor: pointer; font-size: 0.82rem; font-weight: 600;
  border-radius: 9px; transition: all 0.2s; white-space: nowrap;
}
.dm-tabs button.active {
  background: var(--surface); color: var(--text);
  box-shadow: 0 1px 4px rgba(0,0,0,0.1), 0 0 0 1px color-mix(in srgb, #fff 8%, var(--border));
}
.dm-tabs button:hover:not(.active) { color: var(--text); background: color-mix(in srgb, #fff 3%, transparent); }
.dm-badge {
  font-size: 0.56rem; font-weight: 700; color: var(--on-primary);
  background: linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary) 70%, #000));
  border-radius: 6px; padding: 1px 5px; margin-left: 3px; vertical-align: super;
}

/* ---- Feed (glassmorphism card) ---- */
.dm-feed-section { display: flex; flex-direction: column; }
.dm-feed-toolbar { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem; }
.dm-check { display: inline-flex; align-items: center; gap: 5px; font-size: 0.8rem; color: var(--muted); cursor: pointer; }
.dm-check input { accent-color: var(--primary); }

/* Split layout: danmaku left, gift right */
.dm-feed-split {
  display: flex; gap: 0.5rem; min-height: 0;
}
.dm-feed-split .dm-feed-left {
  flex: 1; min-width: 0; display: flex; flex-direction: column;
}
.dm-feed-split--open .dm-feed-left {
  flex: calc(1 - var(--gift-ratio, 0.333));
}
.dm-feed-split .dm-feed-right {
  flex: var(--gift-ratio, 0.333); min-width: 0; display: flex; flex-direction: column;
  transition: flex 0.2s ease;
}
/* Mobile vertical layout */
.dm-feed-split--mobile {
  flex-direction: column;
}
.dm-feed-split--mobile .dm-feed-left {
  flex: 1;
}
.dm-feed-split--mobile.dm-feed-split--open .dm-feed-left {
  flex: 1;
}
.dm-feed-split--mobile .dm-feed-right {
  flex: none; height: var(--gift-height, 200px);
  transition: height 0.2s ease;
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
  height: 420px; overflow-y: auto; padding: 0.5rem;
  font-family: "JetBrains Mono","Consolas","Monaco",monospace; font-size: 0.8rem;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--primary) 30%, var(--border)) transparent;
}
.dm-feed::-webkit-scrollbar { width: 6px; }
.dm-feed::-webkit-scrollbar-track { background: transparent; margin: 8px 0; }
.dm-feed::-webkit-scrollbar-thumb { border-radius: 100px; background: color-mix(in srgb, var(--primary) 35%, var(--border)); }
.dm-feed::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--primary) 55%, var(--border)); }

/* Gift panel */
.dm-gift-panel {
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, #fff 6%, var(--border));
  background: color-mix(in srgb, var(--surface) 50%, transparent);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  overflow: hidden;
  display: flex; flex-direction: column; height: 420px;
}
.dm-gift-header {
  display: flex; flex-direction: column; gap: 4px;
  padding: 0.4rem 0.6rem; user-select: none; flex-shrink: 0;
  border-bottom: 1px solid color-mix(in srgb, #fff 4%, var(--border));
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
.dm-gift-count {
  font-size: 0.62rem; font-weight: 700; padding: 1px 5px;
  border-radius: 999px; background: color-mix(in srgb, var(--primary) 14%, transparent);
  color: var(--primary);
}
.dm-gift-size-group {
  display: inline-flex; gap: 3px; margin-right: 4px;
}
.dm-gift-size-btn {
  font-size: 0.7rem; padding: 2px 8px; border-radius: 5px;
  border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  background: transparent; color: var(--muted); cursor: pointer;
  transition: all 0.15s; line-height: 1.2; user-select: none;
}
.dm-gift-size-btn:hover { border-color: var(--primary); color: var(--primary); background: color-mix(in srgb, var(--primary) 8%, transparent); }
.dm-gift-size-btn:active { transform: scale(0.9); }
.dm-btn--xs {
  font-size: 0.65rem; padding: 2px 8px; border-radius: 6px;
}
.dm-gift-body {
  flex: 1; min-height: 0; overflow: hidden; container-type: inline-size;
}
.dm-gift-feed {
  height: 100%; overflow-y: auto; overflow-x: auto; padding: 0.35rem 0.5rem;
  scroll-behavior: smooth;
}
.dm-gift-feed::-webkit-scrollbar { width: 5px; }
.dm-gift-feed::-webkit-scrollbar-track { background: transparent; }
.dm-gift-feed::-webkit-scrollbar-thumb { border-radius: 100px; background: color-mix(in srgb, var(--primary) 30%, var(--border)); }
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
.dm-gift-nick { color: var(--primary); font-weight: 600; font-size: clamp(0.5rem, 2.8cqw, 0.68rem); max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 1; min-width: 20px; }
.dm-gift-badge {
  display: inline-flex; align-items: center; gap: 2px;
  font-size: clamp(0.4rem, 2cqw, 0.52rem); padding: 1px 3px; border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent); font-weight: 500; flex-shrink: 2;
  line-height: 1.1; overflow: hidden;
}
.dm-badge-avatar {
  width: clamp(8px, 4cqw, 12px); height: clamp(8px, 4cqw, 12px); border-radius: 50%; flex-shrink: 0;
  object-fit: cover;
}
.dm-badge-lv {
  font-size: clamp(0.38rem, 1.8cqw, 0.48rem); font-weight: 700; margin-left: 1px;
  opacity: 0.8;
}
.dm-gift-name {
  font-weight: 600; color: #f0a020; font-size: clamp(0.48rem, 2.6cqw, 0.66rem); flex-shrink: 0;
}
.dm-gift-combo {
  font-size: clamp(0.48rem, 2.6cqw, 0.64rem); font-weight: 700; color: var(--danger); flex-shrink: 0;
}
.dm-gift-ulv {
  font-size: clamp(0.4rem, 2cqw, 0.52rem); color: var(--muted); flex-shrink: 0;
}
/* Gift sub-tabs */
.dm-gift-tabs {
  display: inline-flex; gap: 0; margin-left: 4px;
}
.dm-gift-tabs button {
  font-size: 0.68rem; padding: 2px 8px; border: none; background: transparent;
  color: var(--muted); cursor: pointer; font-weight: 500; border-radius: 4px;
  transition: all 0.15s;
}
.dm-gift-tabs button.active {
  color: var(--primary); font-weight: 700;
  background: color-mix(in srgb, var(--primary) 10%, transparent);
}
.dm-gift-tabs button:hover:not(.active) { color: var(--text); }
/* Gift stats range buttons */
.dm-gift-range-group {
  display: inline-flex; gap: 2px;
}
.dm-gift-range-btn {
  font-size: 0.58rem; padding: 2px 6px; border-radius: 4px;
  border: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
  background: transparent; color: var(--muted); cursor: pointer;
  transition: all 0.15s; line-height: 1.2;
}
.dm-gift-range-btn.active {
  background: color-mix(in srgb, var(--primary) 14%, transparent);
  border-color: var(--primary); color: var(--primary); font-weight: 600;
}
.dm-gift-range-btn:hover:not(.active) { border-color: var(--primary); color: var(--text); }
/* Gift stats view */
.dm-gift-stats {
  height: 100%; overflow-y: auto; padding: 0.4rem 0.5rem;
}
.dm-gift-stats-summary {
  display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 0.6rem;
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
.dm-gift-stats-row {
  display: flex; align-items: center; gap: 0.3rem; padding: 2px 4px;
  border-radius: 4px; font-size: 0.68rem;
}
.dm-gift-stats-row:hover { background: color-mix(in srgb, var(--primary) 5%, transparent); }
.dm-gift-icon-sm { width: 16px; height: 16px; border-radius: 3px; object-fit: contain; flex-shrink: 0; }
.dm-gift-icon-sm-placeholder { width: 16px; height: 16px; font-size: 0.6rem; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.dm-gift-stats-name { font-weight: 500; color: var(--text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-gift-stats-nick { font-weight: 500; color: var(--primary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-gift-stats-cnt { font-weight: 600; color: var(--accent); font-size: 0.65rem; flex-shrink: 0; }
.dm-gift-stats-price { font-size: 0.58rem; color: #f0a020; font-weight: 500; flex-shrink: 0; }
.dm-gift-stats-cost { font-size: 0.58rem; color: var(--muted); font-weight: 400; flex-shrink: 0; }
.dm-empty { text-align: center; color: var(--muted); padding: 2.5rem 1rem; font-size: 0.85rem; }
.dm-msg {
  display: flex; gap: 0.5rem; padding: 0.3rem 0.5rem; border-radius: 8px;
  line-height: 1.6; margin-bottom: 1px;
  transition: background 0.12s;
}
.dm-msg:hover { background: color-mix(in srgb, var(--primary) 5%, var(--surface) 40%); }
.dm-msg--cmd {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border-left: 2.5px solid var(--accent);
}
.dm-time { color: var(--muted); font-size: 0.7rem; flex-shrink: 0; min-width: 58px; font-variant-numeric: tabular-nums; }
.dm-nick { color: var(--primary); font-weight: 600; flex-shrink: 0; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-txt { color: var(--text); word-break: break-all; }

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
  color: var(--muted); cursor: pointer; font-size: 0.76rem; font-weight: 600;
  border-radius: 8px; transition: all 0.2s; white-space: nowrap;
}
.dm-song-tabs button.active {
  background: var(--surface); color: var(--text);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1), 0 0 0 1px color-mix(in srgb, #fff 8%, var(--border));
}
.dm-song-tabs button:hover:not(.active) { color: var(--text); background: color-mix(in srgb, var(--text) 4%, transparent); }

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
.dm-stats-table::-webkit-scrollbar { width: 6px; }
.dm-stats-table::-webkit-scrollbar-track { background: transparent; margin: 4px 0; }
.dm-stats-table::-webkit-scrollbar-thumb { border-radius: 100px; background: color-mix(in srgb, var(--primary) 30%, var(--border)); }
.dm-stats-table::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--primary) 50%, var(--border)); }

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
  .dm-input { width: 100px; font-size: 0.8rem; }
  .dm-feed { height: 300px; font-size: 0.72rem; }
  .dm-tabs button { padding: 0.4rem 0.65rem; font-size: 0.78rem; }
  .dm-stats-panel { width: 96vw; max-width: 96vw; border-radius: 14px; }
  .dm-song-tabs { margin: 0.5rem 0.85rem 0.4rem; }
  .dm-song-toolbar { padding: 0.25rem 0.85rem 0.4rem; }
  .dm-room-card { flex-wrap: wrap; }
  .dm-feed-split { flex-direction: column; }
  .dm-feed-split .dm-feed-right { flex: none; height: var(--gift-height, 200px); }
  .dm-gift-panel { height: 100%; }
  .dm-gift-item { font-size: 0.68rem; }
}
</style>
