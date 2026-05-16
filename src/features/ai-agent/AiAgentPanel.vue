<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import { pluginPayloads, pluginPayloadVersion } from "../../shared/plugins";
/** 项目根目录 `image/BOT.jpg`，圆形区域内用 object-position 取上部头像区域 */
import aiBotPortraitUrl from "../../../image/BOT.jpg?url";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  ts: number;
}

/** `/ai-range-export` 成功响应体（精简字段） */
interface AiRangeExportData {
  rangeLabel?: string;
  danmakuMatched?: number;
  danmakuIncluded?: number;
  danmakuTruncated?: boolean;
  giftMatched?: number;
  giftIncluded?: number;
  giftTruncated?: boolean;
  danmakuText?: string;
  giftText?: string;
}

interface AnalysisPreset {
  id: string;
  label: string;
  icon: string;
  prompt: string;
}

/* ------------------------------------------------------------------ */
/*  Presets                                                           */
/* ------------------------------------------------------------------ */

const PRESETS: AnalysisPreset[] = [
  {
    id: "summary",
    label: "聊天摘要",
    icon: "📝",
    prompt: "请分析以下直播间弹幕内容，总结大家具体在聊什么话题，列出主要讨论点和热门话题。",
  },
  {
    id: "mood",
    label: "自闭/预约值",
    icon: "🎭",
    prompt: `假设主播有两个隐藏数值：
- 「自闭值」(0-100)：弹幕中的负面评价、嘲讽、催促、质疑会增加自闭值；鼓励、夸奖、安慰会降低自闭值。
- 「预约值」(0-100)：弹幕中的期待、催更、"什么时候播"、预约提醒会增加预约值；无关话题会降低预约值。

请根据以下弹幕内容，分析当前这两个值大概是多少，并详细说明哪些弹幕对这两个值产生了影响（增/减），给出具体的弹幕示例。`,
  },
  {
    id: "sentiment",
    label: "情感分析",
    icon: "💬",
    prompt: "请对以下直播间弹幕进行情感分析，统计正面、负面、中性弹幕的比例，并列出典型的正面和负面弹幕示例。",
  },
  {
    id: "highlight",
    label: "高光时刻",
    icon: "⭐",
    prompt: "请分析以下弹幕，找出可能的高光时刻（弹幕密度突然增加、大量相似内容、刷屏等），推测当时直播间发生了什么。",
  },
  {
    id: "custom",
    label: "自定义",
    icon: "✏️",
    prompt: "",
  },
];

/* ------------------------------------------------------------------ */
/*  AI Agent API (server-side proxy)                                  */
/* ------------------------------------------------------------------ */

const AI_AGENT_BASE = "/__fmz_ai_agent";

interface ModelOption {
  id: string;
  label: string;
  provider: string;
}

function formatChatHttpError(status: number, body: string): string {
  const raw = body.trim();
  try {
    const j = JSON.parse(raw) as { error?: string };
    if (typeof j.error === "string" && j.error) return j.error;
  } catch {
    /* not JSON */
  }
  return raw ? `HTTP ${status}：${raw.slice(0, 400)}` : `HTTP ${status}`;
}

const availableModels = ref<ModelOption[]>([]);
const modelsLoading = ref(false);
/** 拉取模型列表失败，或服务器未配置密钥时用于说明 */
const modelsHint = ref("");

async function fetchModels() {
  const url = `${AI_AGENT_BASE}/models`;
  modelsLoading.value = true;
  modelsHint.value = "";

  const runOnce = async (): Promise<"network" | "done"> => {
    modelsHint.value = "";
    try {
      const res = await fetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const raw = await res.text();
      if (!res.ok) {
        modelsHint.value = `无法获取模型列表（HTTP ${res.status}）${raw ? `：${raw.slice(0, 200)}` : "。请确认本地已启动 ai-agent-server（8792）且 Vite 配置了 /__fmz_ai_agent 代理。"}`;
        availableModels.value = [];
        return "done";
      }
      if (raw.trimStart().startsWith("<") || /<!DOCTYPE/i.test(raw)) {
        modelsHint.value =
          "AI 代理返回了 HTML 而非 JSON，多为未经过开发服务器代理（请用 npm run dev / dev:all 打开的地址访问），或直接打开了 dist/preview；生产环境需在 Nginx 等处转发 /__fmz_ai_agent。";
        availableModels.value = [];
        return "done";
      }
      let data: { models?: ModelOption[] };
      try {
        data = JSON.parse(raw);
      } catch {
        modelsHint.value = `模型列表无法解析为 JSON（前 120 字）：${raw.slice(0, 120).replace(/\s+/g, " ")}`;
        availableModels.value = [];
        return "done";
      }
      availableModels.value = data.models || [];
      if (availableModels.value.length === 0) {
        modelsHint.value =
          "服务器未配置任何可用密钥（列表为空）：请在环境变量或 server/data/ai-agent-keys.json 中至少配置一种：GEMINI/gemini、OPENAI/openai、千问 DASHSCOPE_API_KEY 或 QWEN_API_KEY / qwen；保存为 UTF-8 后重启 npm run dev:all。";
      }
      if (availableModels.value.length > 0 && !availableModels.value.find((m) => m.id === selectedModel.value)) {
        selectedModel.value = availableModels.value[0].id;
      }
      return "done";
    }
    catch (err) {
      console.warn("[ai-agent] Failed to fetch models:", err);
      availableModels.value = [];
      modelsHint.value =
        "无法连接 AI 代理（/__fmz_ai_agent）。请在本机运行 npm run dev:all，并用能提供该前缀的站点打开（局域网访问时需反代或未关闭跨设备限制）。";
      return "network";
    }
  };

  try {
    const first = await runOnce();
    if (first === "network") {
      await new Promise((r) => setTimeout(r, 900));
      await runOnce();
    }
  }
  finally {
    modelsLoading.value = false;
  }
}

/* ------------------------------------------------------------------ */
/*  State                                                             */
/* ------------------------------------------------------------------ */

const LS_MODEL = "fmz_ai_agent_model";
/** 与 DouyuDanmakuPanel 同步：当前选中的后台房间 */
const LS_DM_SELECTED_ROOM = "fmz_danmaku_selected_room";
const DANMAKU_API = "/__fmz_danmaku";
/** 用户消息气泡头像：固定读取该直播间主播头像，失败则用上次缓存 URL */
const STREAMER_AVATAR_ROOM_ID = "9046690";
const LS_STREAMER_AVATAR_URL = "fmz_ai_agent_room9046690_avatar_url";

type QuickTimeMode =
  | "today"
  | "24h"
  | "yesterday"
  | "prev_calendar_day"
  | "prev_calendar_week"
  | "7days"
  | "rolling_week"
  | "specific_day"
  | "specific_week";

const QUICK_TIME_OPTIONS: { value: QuickTimeMode; label: string }[] = [
  { value: "today", label: "今日" },
  { value: "24h", label: "过去24小时" },
  { value: "yesterday", label: "昨天" },
  { value: "prev_calendar_day", label: "上一自然日（日报同款）" },
  { value: "prev_calendar_week", label: "上周一至周日（周报同款）" },
  { value: "7days", label: "近7天" },
  { value: "rolling_week", label: "近一周（含今天）" },
  { value: "specific_day", label: "指定日" },
  { value: "specific_week", label: "指定周（周一至周日）" },
];

const BUNDLE_ANALYSIS_INSTRUCTIONS_BOTH = `请根据下方提供的斗鱼直播间「弹幕」与「礼物」文本记录（已按本地时间范围筛选），完成综合分析并输出结论：
1）弹幕在讨论什么、整体情绪与节奏；2）是否有刷屏/节奏突变等可感知「事件」；3）礼物送出概况（密集时段、活跃用户特征等，若记录中有体现）；4）若数据量较少或某一段为空，请诚实说明局限。
输出使用中文，使用清晰的小标题与要点，可适度使用 emoji。`;

const BUNDLE_INSTRUCTIONS_DANMAKU = `请仅根据下方「弹幕」摘录（已按本地时间筛选）进行分析：
讨论主题、情绪与节奏、值得关注的事件或节奏突变、刷屏现象；若样本过少请说明局限。
输出使用中文，小标题与要点，可适度使用 emoji。`;

const BUNDLE_INSTRUCTIONS_GIFTS = `请仅根据下方「礼物」归档摘录（已按本地时间筛选）进行分析：
送礼热度时段、可能的活跃用户或大额礼物、整体画像；若记录为空或过少请说明局限。
输出使用中文，小标题与要点，可适度使用 emoji。`;

/** 勾选「主播心态」时追加到指令末尾（仍依赖弹幕/礼物摘录） */
const BUNDLE_STREAMER_MENTALITY_ADDON = `【主播心态】在完成上述任务的同时，请结合摘录从主播侧做合理推断：情绪基调、语言与互动节奏、压力或放松信号、与弹幕/礼物互动下的心理暗示等。须有文本或行为依据，不得臆造；材料不足时请直接说明。`;

/** 模型回复须先复述数据数字再分析 */
const BUNDLE_OUTPUT_STATS_FIRST = `【输出格式】不要用「一、数据概览」电报罗列匹配/摘录条数或付费笔数；若需交代样本规模可在一句话内带过，然后展开弹幕分析、礼物分析等小节。`;

function formatLocalYmd(ms: number): string {
  const x = new Date(ms);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const d = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

interface MonitoredRoomRow {
  roomId: string;
  recording?: boolean;
  status?: string;
}

const selectedModel = ref(localStorage.getItem(LS_MODEL) || "");

const selectedPreset = ref<string>("summary");
const customPrompt = ref("");
const chatMessages = ref<ChatMessage[]>([]);
const isLoading = ref(false);
const chatScrollRef = ref<HTMLElement | null>(null);
const abortController = ref<AbortController | null>(null);

/** Danmaku data received from the main panel */
const danmakuData = ref<string>("");
const danmakuCount = ref(0);
const danmakuRoomId = ref("");

const quickTimeMode = ref<QuickTimeMode>("today");
const quickSpecificDay = ref(formatLocalYmd(Date.now()));
const quickWeekAnyDay = ref(formatLocalYmd(Date.now()));
const quickIncludeDanmaku = ref(true);
const quickIncludeGifts = ref(true);
const quickIncludeStreamerMentality = ref(false);
const quickMonitoredRooms = ref<MonitoredRoomRow[]>([]);
/** 斗鱼 room-info.owner_name，用于「主播名 #房间号」 */
const roomOwnerNameById = ref<Record<string, string>>({});
const roomOwnerFetchAttempted = ref<Record<string, boolean>>({});
/** 空字符串：使用弹幕面板当前选中的房间号；否则为后台已监控房间 */
const quickRoomChoice = ref("");
const quickBundleErr = ref("");

/** 斗鱼 CDN 头像；先从 localStorage 恢复再尝试更新 */
const streamerAvatarUrl = ref("");

async function ensureRoomOwnerName(roomId: string): Promise<void> {
  const id = String(roomId || "").trim();
  if (!id || roomOwnerFetchAttempted.value[id]) return;
  roomOwnerFetchAttempted.value = { ...roomOwnerFetchAttempted.value, [id]: true };
  try {
    const res = await fetch(`${DANMAKU_API}/room-info/${encodeURIComponent(id)}`, { cache: "no-store" });
    const raw = await res.text();
    let data: { ok?: boolean; info?: { owner_name?: string } };
    try {
      data = JSON.parse(raw) as { ok?: boolean; info?: { owner_name?: string } };
    } catch {
      return;
    }
    const name = data.ok && typeof data.info?.owner_name === "string" ? data.info.owner_name.trim() : "";
    if (name) roomOwnerNameById.value = { ...roomOwnerNameById.value, [id]: name };
  } catch {
    /* ignore */
  }
}

/** 下拉展示：主播名 #房间号（未拉到昵称时仅 #房间号） */
function formatMonitorRoomLabel(roomId: string): string {
  const id = String(roomId || "").trim();
  if (!id) return "—";
  const owner = roomOwnerNameById.value[id]?.trim();
  return owner ? `${owner} #${id}` : `#${id}`;
}

function currentPanelRoomIdResolved(): string {
  let id = danmakuRoomId.value.trim();
  if (!id) {
    try {
      id = localStorage.getItem(LS_DM_SELECTED_ROOM)?.trim() || "";
    } catch {
      id = "";
    }
  }
  return id;
}

/** 下拉首项：使用弹幕面板当前房号（不在下列中重复列出该房） */
const quickDefaultRoomOptionLabel = computed(() => (currentPanelRoomIdResolved() ? "当前直播间" : "请先选择弹幕面板房间"));

const quickMonitoredRoomsForSelect = computed(() => {
  const cur = currentPanelRoomIdResolved();
  if (!cur) return quickMonitoredRooms.value;
  return quickMonitoredRooms.value.filter((r) => String(r.roomId).trim() !== cur);
});

async function refreshStreamerAvatar9046690(): Promise<void> {
  try {
    const cached = localStorage.getItem(LS_STREAMER_AVATAR_URL)?.trim();
    if (cached) streamerAvatarUrl.value = cached;
  } catch {
    /* ignore */
  }
  try {
    const res = await fetch(
      `${DANMAKU_API}/room-info/${encodeURIComponent(STREAMER_AVATAR_ROOM_ID)}`,
      { cache: "no-store" },
    );
    const raw = await res.text();
    let data: { ok?: boolean; info?: { avatar?: string } };
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const url = data.ok && typeof data.info?.avatar === "string" ? data.info.avatar.trim() : "";
    if (!url) return;
    streamerAvatarUrl.value = url;
    try {
      localStorage.setItem(LS_STREAMER_AVATAR_URL, url);
    } catch {
      /* ignore */
    }
  } catch {
    /* 保留本地缓存 URL */
  }
}

async function refreshMonitoredRooms(): Promise<void> {
  try {
    const res = await fetch(`${DANMAKU_API}/rooms`, { cache: "no-store" });
    const raw = await res.text();
    let data: { ok?: boolean; rooms?: MonitoredRoomRow[] };
    try {
      data = JSON.parse(raw) as { ok?: boolean; rooms?: MonitoredRoomRow[] };
    } catch {
      return;
    }
    if (!data.ok || !Array.isArray(data.rooms)) return;
    quickMonitoredRooms.value = [...data.rooms].sort((a, b) => {
      const na = Number(a.roomId);
      const nb = Number(b.roomId);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a.roomId).localeCompare(String(b.roomId), "zh-CN");
    });
    const ids = new Set<string>();
    for (const r of quickMonitoredRooms.value) ids.add(r.roomId);
    const cur = (danmakuRoomId.value || getSelectedDouyuRoomFromLs()).trim();
    if (cur) ids.add(cur);
    await Promise.all([...ids].map((id) => ensureRoomOwnerName(id)));
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/*  Persistence                                                       */
/* ------------------------------------------------------------------ */

watch(selectedModel, (v) => { try { localStorage.setItem(LS_MODEL, v); } catch {} });

/* ------------------------------------------------------------------ */
/*  Payload from danmaku panel                                        */
/* ------------------------------------------------------------------ */

function handlePayload() {
  const p = pluginPayloads.value["ai-agent"];
  if (!p) return;
  if (typeof p.danmakuText === "string") {
    danmakuData.value = p.danmakuText;
    danmakuCount.value = (p.danmakuCount as number) || 0;
    danmakuRoomId.value = (p.roomId as string) || "";
  }
}

watch(pluginPayloadVersion, () => handlePayload());
watch(
  [
    quickTimeMode,
    quickSpecificDay,
    quickWeekAnyDay,
    quickIncludeDanmaku,
    quickIncludeGifts,
    quickIncludeStreamerMentality,
    quickRoomChoice,
  ],
  () => { quickBundleErr.value = ""; },
);
watch(
  () => danmakuRoomId.value,
  (id) => { if (id) void ensureRoomOwnerName(id); },
  { immediate: true },
);
onMounted(() => {
  document.addEventListener("pointerdown", docPointerMaybeClose, true);
  handlePayload();
  setTimeout(handlePayload, 50);
  fetchModels();
  void refreshStreamerAvatar9046690();
  void refreshMonitoredRooms();
});

/* ------------------------------------------------------------------ */
/*  Computed                                                          */
/* ------------------------------------------------------------------ */

const activePreset = computed(() => PRESETS.find((p) => p.id === selectedPreset.value));

const effectivePrompt = computed(() => {
  if (selectedPreset.value === "custom") return customPrompt.value;
  return activePreset.value?.prompt || "";
});

const canSend = computed(() => {
  return selectedModel.value && effectivePrompt.value.trim() && danmakuData.value.trim() && !isLoading.value;
});

/** 一级平台陈列名（与后端 provider 映射） */
function platformCatalogLabel(provider: string): string {
  const p = (provider || "").trim();
  if (p === "Google") return "Gemini";
  return p || "Other";
}

const selectedModelHint = computed(() => {
  const m = availableModels.value.find((x) => x.id === selectedModel.value);
  return m ? `${platformCatalogLabel(m.provider)} › ${m.label}（${m.id}）` : "";
});

const modelPickerRef = ref<HTMLElement | null>(null);
const modelPickerOpen = ref(false);
/** 平台名 → 二级列表是否展开 */
const expandedPlatforms = ref<Record<string, boolean>>({});

const modelsGrouped = computed(() => {
  const map = new Map<string, ModelOption[]>();
  for (const m of availableModels.value) {
    const cat = platformCatalogLabel(m.provider);
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(m);
  }
  const rows = [...map.entries()].map(([catalog, models]) => ({
    catalog,
    models: models.slice().sort((a, b) => {
      const c = a.label.localeCompare(b.label, "zh-Hans-CN");
      return c !== 0 ? c : a.id.localeCompare(b.id);
    }),
  }));
  rows.sort((a, b) => a.catalog.localeCompare(b.catalog, "zh-Hans-CN"));
  return rows;
});

watch(
  modelsGrouped,
  (groups) => {
    const next: Record<string, boolean> = {};
    const prev = expandedPlatforms.value;
    for (const g of groups) {
      const old = prev[g.catalog];
      if (old !== undefined) {
        next[g.catalog] = old;
      } else {
        next[g.catalog]
          = groups.length === 1
            || g.models.some((m) => m.id === selectedModel.value);
      }
    }
    expandedPlatforms.value = next;
  },
  { deep: true, immediate: true },
);

watch(selectedModel, (id) => {
  if (!id || !availableModels.value.length) return;
  const m = availableModels.value.find((x) => x.id === id);
  if (!m) return;
  const cat = platformCatalogLabel(m.provider);
  expandedPlatforms.value = { ...expandedPlatforms.value, [cat]: true };
});

function docPointerMaybeClose(ev: Event) {
  const root = modelPickerRef.value;
  const t = ev.target;
  if (!modelPickerOpen.value || !root || !(t instanceof Node)) return;
  if (!root.contains(t)) modelPickerOpen.value = false;
}

function onEscapeCloseModelMenu(e: KeyboardEvent) {
  if (e.key === "Escape") modelPickerOpen.value = false;
}

watch(modelPickerOpen, (open) => {
  if (open) {
    document.addEventListener("keydown", onEscapeCloseModelMenu, true);
  } else {
    document.removeEventListener("keydown", onEscapeCloseModelMenu, true);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onEscapeCloseModelMenu, true);
  document.removeEventListener("pointerdown", docPointerMaybeClose, true);
});

function toggleModelPicker() {
  if (modelsLoading.value || availableModels.value.length === 0) return;
  modelPickerOpen.value = !modelPickerOpen.value;
}

function togglePlatformCatalog(cat: string) {
  expandedPlatforms.value = {
    ...expandedPlatforms.value,
    [cat]: !(expandedPlatforms.value[cat] ?? true),
  };
}

function pickModel(id: string) {
  selectedModel.value = id;
  modelPickerOpen.value = false;
}

const modelTriggerLabel = computed(() => {
  if (modelsLoading.value) return "加载…";
  if (availableModels.value.length === 0) return "无模型";
  const m = availableModels.value.find((x) => x.id === selectedModel.value);
  if (!m) return "请选择";
  return m.label;
});

function getSelectedDouyuRoomFromLs(): string {
  try {
    return localStorage.getItem(LS_DM_SELECTED_ROOM)?.trim() || "";
  } catch {
    return "";
  }
}

function buildQuickRangeKey(): string {
  switch (quickTimeMode.value) {
    case "specific_day":
      return `day:${quickSpecificDay.value.trim()}`;
    case "specific_week":
      return `week:${quickWeekAnyDay.value.trim()}`;
    default:
      return quickTimeMode.value;
  }
}

/** 快捷分析使用的房间：下拉选了后台监控房间则用该项，否则用语弹幕面板 LS 当前房间 */
function resolveEffectiveQuickRoomId(): string {
  const picked = quickRoomChoice.value.trim();
  if (picked) return picked;
  return getSelectedDouyuRoomFromLs().trim();
}

const canRunQuickBundle = computed(() => {
  if (!selectedModel.value || isLoading.value) return false;
  if (!quickIncludeDanmaku.value && !quickIncludeGifts.value) return false;
  return resolveEffectiveQuickRoomId().length > 0;
});

function buildDataInfoBlock(
  data: AiRangeExportData,
  roomId: string,
  roomDisplay: string,
  inclDm: boolean,
  inclG: boolean,
): string {
  const lines: string[] = [
    "【数据信息】（下列数字须在回复开头的「数据概览」中原样列出）",
    `- 统计周期：${data.rangeLabel ?? "—"}`,
    `- 直播间展示名：${roomDisplay}`,
    `- 房间号：${roomId}`,
  ];
  if (inclDm) {
    const trunc = data.danmakuTruncated ? "是（已达摘录上限，仅保留时间靠后的一批）" : "否";
    lines.push(`- 弹幕：时间范围内匹配 ${data.danmakuMatched ?? 0} 条；纳入本分析的摘录 ${data.danmakuIncluded ?? 0} 条；是否截断：${trunc}`);
  }
  if (inclG) {
    const trunc = data.giftTruncated ? "是（已达摘录上限，仅保留时间靠后的一批）" : "否";
    lines.push(`- 礼物：时间范围内匹配 ${data.giftMatched ?? 0} 条；纳入本分析的摘录 ${data.giftIncluded ?? 0} 条；是否截断：${trunc}`);
  }
  return lines.join("\n");
}

function buildExcerptTail(data: AiRangeExportData, inclDm: boolean, inclG: boolean): string {
  const chunks: string[] = [];
  if (inclDm) chunks.push(`--- 弹幕摘录 ---\n${data.danmakuText ?? ""}`);
  if (inclG) chunks.push(`--- 礼物摘录 ---\n${data.giftText ?? ""}`);
  return chunks.join("\n\n");
}

async function fetchAiRangeExportPayload(
  roomId: string,
  rangeKey: string,
  inclDm: boolean,
  inclG: boolean,
  signal: AbortSignal,
): Promise<AiRangeExportData> {
  const params = new URLSearchParams({
    range: rangeKey,
    maxDanmaku: "8000",
    maxGifts: "2500",
    includeDanmaku: inclDm ? "1" : "0",
    includeGifts: inclG ? "1" : "0",
  });
  const url = `${DANMAKU_API}/ai-range-export/${encodeURIComponent(roomId)}?${params.toString()}`;
  const res = await fetch(url, { signal, cache: "no-store" });
  const raw = await res.text();
  let data: AiRangeExportData & { ok?: boolean; error?: string };
  try {
    data = JSON.parse(raw) as AiRangeExportData & { ok?: boolean; error?: string };
  } catch {
    throw new Error(`导出接口返回非 JSON（HTTP ${res.status}）`);
  }
  if (!data.ok) {
    throw new Error(typeof data.error === "string" && data.error ? data.error : `导出失败（HTTP ${res.status}）`);
  }
  return data;
}

type ChatCompletionMsg = { role: "system" | "user" | "assistant"; content: string };

function getModelFallbackChain(): string[] {
  const primary = String(selectedModel.value || "").trim();
  const ids = availableModels.value.map((m) => m.id).filter((x): x is string => Boolean(String(x ?? "").trim()));
  const ordered = primary ? [primary, ...ids] : ids;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ordered) {
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 是否与「换模型再试」策略匹配（非用户主动中断、非确定性内容拒答类） */
function isRecoverableAiProxyError(message: string): boolean {
  if (/AbortError|aborted|已中断/i.test(message)) return false;
  const s = message;
  if (
    /\b429\b/.test(s)
    || /quota|RESOURCE_EXHAUSTED|rate\s*limit|limit:\s*0/i.test(s)
  ) {
    return true;
  }
  if (/HTTP (400|401|402|403|404|408|409|413|421|422|423|425|426|427|428|429|500|502|503|504|522|524)\b/i.test(s)) {
    if (/\b400\b/.test(s) && /\bMISSING\b|invalid\s+json|missing\s+model/i.test(s)) return false;
    return true;
  }
  if (
    /Upstream error|upstream|temporar(il)?y|overload|capacity|timed?\s*out|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|UND_ERR_CONNECT_TIMEOUT/i.test(
      s,
    )
  ) {
    return true;
  }
  if (/no\s+longer\s+available|not available|invalid[_ ]?model|model[_ ]not[_ ]found|insufficient[_ ]quota|billing/i.test(s)) return true;
  return false;
}

async function consumeSseChatIntoLastAssistant(res: Response): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("无法读取响应流");
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6);
      if (payload === "[DONE]") continue;
      try {
        const parsedJson = JSON.parse(payload);
        const delta = parsedJson.choices?.[0]?.delta?.content;
        if (delta) {
          const lastMsg = chatMessages.value[chatMessages.value.length - 1];
          if (lastMsg?.role === "assistant") lastMsg.content += delta;
        }
      } catch {
        /* skip */
      }
    }
    await nextTick();
    scrollToBottom();
  }
}

async function fetchChatStreamWithFallback(messages: ChatCompletionMsg[], signal: AbortSignal): Promise<void> {
  const chain = getModelFallbackChain();
  if (!chain.length) {
    throw new Error("无可用模型，请在上方选择模型或确认服务器已配置至少一类 API 密钥");
  }
  const lastAssist = chatMessages.value[chatMessages.value.length - 1];
  let lastErr: unknown;
  for (let i = 0; i < chain.length; i++) {
    const modelId = chain[i];
    try {
      if (lastAssist?.role === "assistant") lastAssist.content = "";
      const res = await fetch(`${AI_AGENT_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId, messages }),
        signal,
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(formatChatHttpError(res.status, errText));
      }
      await consumeSseChatIntoLastAssistant(res);
      if (i > 0 && lastAssist?.role === "assistant" && lastAssist.content.trim()) {
        lastAssist.content = `（已自动切换模型：${modelId}）\n\n${lastAssist.content}`;
      }
      return;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      if ((e as { name?: string })?.name === "AbortError") throw e;
      if (i < chain.length - 1 && isRecoverableAiProxyError(msg)) {
        console.warn("[ai-agent panel] 模型不可用，尝试下一候选:", modelId, msg.slice(0, 160));
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "未知错误"));
}

async function streamAssistantChat(systemContent: string, userBlock: string, signal: AbortSignal): Promise<void> {
  return fetchChatStreamWithFallback(
    [
      { role: "system", content: systemContent },
      { role: "user", content: userBlock },
    ],
    signal,
  );
}

function handleExportOrChatError(err: unknown): void {
  const e = err as { name?: string; message?: string };
  const msg = e.message || String(err);
  if (e.name === "AbortError") {
    const lastMsg = chatMessages.value[chatMessages.value.length - 1];
    if (lastMsg?.role === "assistant") lastMsg.content += "\n\n⚠️ 已中断";
  } else {
    quickBundleErr.value = msg;
    const lastMsg = chatMessages.value[chatMessages.value.length - 1];
    if (lastMsg?.role === "assistant" && lastMsg.content === "") {
      lastMsg.content = `❌ ${msg}`;
    } else {
      chatMessages.value.push({ role: "assistant", content: `❌ ${msg}`, ts: Date.now() });
    }
  }
}

function buildQuickBundleUserBlock(
  data: AiRangeExportData,
  roomId: string,
  inclDm: boolean,
  inclG: boolean,
  inclMentality: boolean,
): string {
  const mentalityAddon = inclMentality ? `\n\n${BUNDLE_STREAMER_MENTALITY_ADDON}` : "";
  let core: string;
  if (inclDm && inclG) core = `${BUNDLE_ANALYSIS_INSTRUCTIONS_BOTH}${mentalityAddon}`;
  else if (inclDm) core = `${BUNDLE_INSTRUCTIONS_DANMAKU}${mentalityAddon}`;
  else core = `${BUNDLE_INSTRUCTIONS_GIFTS}${mentalityAddon}`;
  return `${buildDataInfoBlock(data, roomId, formatMonitorRoomLabel(roomId), inclDm, inclG)}\n\n【分析任务】\n${core}\n\n${BUNDLE_OUTPUT_STATS_FIRST}\n\n${buildExcerptTail(data, inclDm, inclG)}`;
}

function quickBundleSystemContent(inclDm: boolean, inclG: boolean, inclMentality: boolean): string {
  const prefix = "你在与用户进行多轮中文对话。";
  let systemContent: string;
  if (inclDm && inclG) {
    systemContent = `${prefix} 本条用户消息中带弹幕与礼物摘录及结构化任务说明，请按要求作答。回复使用中文。`;
  } else if (inclDm) {
    systemContent = `${prefix} 本条用户消息中带弹幕摘录及任务说明，请按要求作答。回复使用中文。`;
  } else {
    systemContent = `${prefix} 本条用户消息中带礼物归档摘录及任务说明，请按要求作答。回复使用中文。`;
  }
  if (inclMentality) {
    systemContent += " 用户勾选了「主播心态」：请在有据前提下推断主播心理状态与互动特征，避免臆断。";
  }
  return systemContent;
}

/* ------------------------------------------------------------------ */
/*  Chat logic                                                        */
/* ------------------------------------------------------------------ */

async function sendAnalysis() {
  if (!canSend.value) return;

  const userContent = `${effectivePrompt.value}\n\n---\n\n以下是直播间 ${danmakuRoomId.value || "未知"} 的弹幕数据（共 ${danmakuCount.value} 条）：\n\n${danmakuData.value}`;

  chatMessages.value.push({
    role: "user",
    content: `📊 快捷指令 · ${activePreset.value?.label || "自定义分析"} · 弹幕 ${danmakuCount.value} 条 · 房间 ${danmakuRoomId.value || "未知"}（模板与摘录已自动组合）`,
    ts: Date.now(),
  });

  chatMessages.value.push({
    role: "assistant",
    content: "",
    ts: Date.now(),
  });

  isLoading.value = true;
  const controller = new AbortController();
  abortController.value = controller;

  try {
    await fetchChatStreamWithFallback(
      [
        {
          role: "system",
          content:
            "你是一个与用户多轮中文对话的直播间助手。本条用户消息中包含弹幕摘录与分析要求，请按要求作答；回复使用中文，格式清晰，适当使用 emoji。",
        },
        { role: "user", content: userContent },
      ],
      controller.signal,
    );
  } catch (err: any) {
    if (err.name === "AbortError") {
      const lastMsg = chatMessages.value[chatMessages.value.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        lastMsg.content += "\n\n⚠️ 已中断";
      }
    } else {
      const lastMsg = chatMessages.value[chatMessages.value.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        lastMsg.content = `❌ 错误：${err.message}`;
      }
    }
  } finally {
    isLoading.value = false;
    abortController.value = null;
    scrollToBottom();
  }
}

async function runQuickBundleAnalysis() {
  if (!canRunQuickBundle.value) return;

  const roomId = resolveEffectiveQuickRoomId();
  if (!roomId) {
    quickBundleErr.value = quickRoomChoice.value.trim()
      ? "所选房间无效"
      : "请先在斗鱼弹幕面板选择当前直播间，或从下拉指定后台已监控房间";
    return;
  }

  const rangeKey = buildQuickRangeKey();
  const inclDm = quickIncludeDanmaku.value;
  const inclG = quickIncludeGifts.value;
  const inclMentality = quickIncludeStreamerMentality.value;

  quickBundleErr.value = "";
  isLoading.value = true;
  const controller = new AbortController();
  abortController.value = controller;

  try {
    const data = await fetchAiRangeExportPayload(roomId, rangeKey, inclDm, inclG, controller.signal);
    const label = data.rangeLabel || rangeKey;
    const userBlock = buildQuickBundleUserBlock(data, roomId, inclDm, inclG, inclMentality);
    const systemContent = quickBundleSystemContent(inclDm, inclG, inclMentality);

    const scopeLabel = [
      inclDm ? "弹幕" : null,
      inclG ? "礼物" : null,
      inclMentality ? "主播心态" : null,
    ].filter(Boolean).join("+");
    const roomDisplay = formatMonitorRoomLabel(roomId);
    chatMessages.value.push({
      role: "user",
      content: `📊 快捷指令 · ${scopeLabel} · ${label} · ${roomDisplay}（约定模板已自动拼装本条请求的说明与摘录）`,
      ts: Date.now(),
    });
    chatMessages.value.push({
      role: "assistant",
      content: "",
      ts: Date.now(),
    });

    await streamAssistantChat(systemContent, userBlock, controller.signal);
  } catch (err: unknown) {
    handleExportOrChatError(err);
  } finally {
    isLoading.value = false;
    abortController.value = null;
    scrollToBottom();
  }
}

function stopGeneration() {
  abortController.value?.abort();
}

function clearChat() {
  chatMessages.value = [];
}

function scrollToBottom() {
  nextTick(() => {
    const el = chatScrollRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

/* ------------------------------------------------------------------ */
/*  Free-form chat                                                    */
/* ------------------------------------------------------------------ */

const freeInput = ref("");

const inputTextareaRef = ref<HTMLTextAreaElement | null>(null);

function autoResizeTextarea() {
  const el = inputTextareaRef.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

async function sendFreeChat() {
  const text = freeInput.value.trim();
  if (!text || isLoading.value || !selectedModel.value) return;

  freeInput.value = "";
  nextTick(() => { if (inputTextareaRef.value) inputTextareaRef.value.style.height = "auto"; });

  chatMessages.value.push({ role: "user", content: text, ts: Date.now() });
  chatMessages.value.push({ role: "assistant", content: "", ts: Date.now() });

  isLoading.value = true;
  const controller = new AbortController();
  abortController.value = controller;

  // Build conversation history (last 20 messages max)
  const historyMsgs = chatMessages.value.slice(0, -1).slice(-20).map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }));

  try {
    const messages: ChatCompletionMsg[] = [
      {
        role: "system",
        content:
          `你是一个与用户多轮中文对话的直播间助手。当前直播间房间号：${danmakuRoomId.value || "未知"}。用户可能基于上一轮快捷指令结果继续追问；若附带摘录仅供参考。回复使用中文。${danmakuData.value ? `\n\n当前弹幕摘录参考（${danmakuCount.value}条）：\n${danmakuData.value.slice(0, 4000)}` : ""}`,
      },
      ...historyMsgs,
    ];
    await fetchChatStreamWithFallback(messages, controller.signal);
  } catch (err: any) {
    if (err.name === "AbortError") {
      const lastMsg = chatMessages.value[chatMessages.value.length - 1];
      if (lastMsg?.role === "assistant") lastMsg.content += "\n\n⚠️ 已中断";
    } else {
      const lastMsg = chatMessages.value[chatMessages.value.length - 1];
      if (lastMsg?.role === "assistant") lastMsg.content = `❌ 错误：${err.message}`;
    }
  } finally {
    isLoading.value = false;
    abortController.value = null;
    scrollToBottom();
  }
}

function onFreeInputKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendFreeChat();
  }
}
</script>

<template>
  <div class="ai-agent-root">
    <!-- Chat area -->
    <div ref="chatScrollRef" class="ai-chat-area">
      <div v-if="chatMessages.length === 0" class="ai-empty-hint">
        <div class="ai-empty-icon">
          <img
            class="ai-empty-bot-img ai-avatar-bot"
            :src="aiBotPortraitUrl"
            alt=""
            loading="lazy"
          />
        </div>
        <p class="ai-empty-invite">和我聊聊天吧</p>
      </div>
      <div
        v-for="(msg, i) in chatMessages"
        :key="i"
        class="ai-chat-msg"
        :class="msg.role"
      >
        <div class="ai-msg-avatar">
          <template v-if="msg.role === 'user'">
            <img
              v-if="streamerAvatarUrl"
              class="ai-avatar-streamer"
              :src="streamerAvatarUrl"
              alt=""
              referrerpolicy="no-referrer"
              loading="lazy"
            />
            <span v-else class="ai-msg-avatar-fallback">👤</span>
          </template>
          <img
            v-else
            class="ai-avatar-bot"
            :src="aiBotPortraitUrl"
            alt=""
            loading="lazy"
          />
        </div>
        <div class="ai-msg-bubble">
          <div class="ai-msg-content" v-html="renderMarkdown(msg.content)" />
          <div v-if="msg.role === 'assistant' && isLoading && i === chatMessages.length - 1" class="ai-typing-indicator">
            <span /><span /><span />
          </div>
        </div>
      </div>
    </div>

    <!-- Unified search-bar style input -->
    <div class="ai-input-container">
      <div class="ai-quick-header-row">
        <span class="ai-quick-heading">快捷指令</span>
        <div class="ai-quick-header-actions">
          <template v-if="isLoading">
            <span class="ai-quick-busy-hint" aria-live="polite">分析中…</span>
            <button
              type="button"
              class="ai-action-btn ai-stop-btn"
              title="停止生成"
              @click="stopGeneration"
            >
              ⏹ 停止
            </button>
          </template>
          <button
            v-else-if="chatMessages.length > 0"
            type="button"
            class="ai-action-btn ai-clear-btn"
            title="清空对话"
            @click="clearChat"
          >
            🗑 清空
          </button>
        </div>
      </div>
      <div class="ai-quick-toolbar" role="group" aria-label="快捷指令：导出数据并自动组合约定说明，作为一条对话消息请求模型">
        <select
          id="fmz-ai-quick-time"
          v-model="quickTimeMode"
          class="ai-quick-select ai-quick-select--time"
          aria-label="分析时间范围"
        >
          <option v-for="o in QUICK_TIME_OPTIONS" :key="o.value" :value="o.value">
            {{ o.label }}
          </option>
        </select>
        <input
          v-show="quickTimeMode === 'specific_day'"
          id="fmz-ai-quick-day"
          v-model="quickSpecificDay"
          class="ai-quick-date"
          type="date"
          aria-label="指定日期"
        />
        <input
          v-show="quickTimeMode === 'specific_week'"
          id="fmz-ai-quick-week"
          v-model="quickWeekAnyDay"
          class="ai-quick-date"
          type="date"
          title="选择该自然周内任意一天，导出范围为本周一至本周日（本地时区）"
          aria-label="指定周内日期"
        />
        <span class="ai-quick-field-label">内容</span>
        <label class="ai-quick-check">
          <input v-model="quickIncludeDanmaku" type="checkbox" />
          弹幕
        </label>
        <label class="ai-quick-check">
          <input v-model="quickIncludeGifts" type="checkbox" />
          礼物
        </label>
        <label class="ai-quick-check">
          <input v-model="quickIncludeStreamerMentality" type="checkbox" />
          主播心态
        </label>
        <span class="ai-quick-field-label">直播间</span>
        <select
          id="fmz-ai-quick-room"
          v-model="quickRoomChoice"
          class="ai-quick-select ai-quick-select--room"
          aria-label="录制数据来源房间"
        >
          <option value="">{{ quickDefaultRoomOptionLabel }}</option>
          <option v-for="r in quickMonitoredRoomsForSelect" :key="r.roomId" :value="r.roomId">
            {{ formatMonitorRoomLabel(r.roomId) }}
          </option>
        </select>
        <button
          type="button"
          class="ai-quick-run"
          :disabled="!canRunQuickBundle"
          title="导出所选范围的弹幕/礼物摘录，并按约定模板拼成一条用户消息发给对话模型（非独立「分析模块」）"
          @click="runQuickBundleAnalysis"
        >
          分析
        </button>
      </div>
      <p v-if="quickBundleErr" class="ai-quick-err">{{ quickBundleErr }}</p>
      <div
        class="ai-search-bar"
        :class="{ 'ai-search-bar--menu-open': modelPickerOpen }"
      >
        <div ref="modelPickerRef" class="ai-search-model ai-model-picker-root">
          <button
            type="button"
            class="ai-model-trigger"
            :disabled="modelsLoading || availableModels.length === 0"
            :title="selectedModelHint || undefined"
            :aria-expanded="modelPickerOpen"
            aria-haspopup="listbox"
            @click.stop="toggleModelPicker"
          >
            <span class="ai-model-trigger-main">{{ modelTriggerLabel }}</span>
            <span class="ai-model-trigger-chev" aria-hidden="true">{{ modelPickerOpen ? '▼' : '▲' }}</span>
          </button>
          <div
            v-show="modelPickerOpen"
            class="ai-model-menu ai-model-menu--above"
            role="listbox"
            aria-label="选择模型"
          >
            <div
              v-for="group in modelsGrouped"
              :key="group.catalog"
              class="ai-model-branch"
            >
              <button
                type="button"
                class="ai-model-branch-head"
                :aria-expanded="expandedPlatforms[group.catalog] !== false"
                @click.stop="togglePlatformCatalog(group.catalog)"
              >
                <span class="ai-model-branch-chev">
                  {{ expandedPlatforms[group.catalog] !== false ? '▾' : '▸' }}
                </span>
                <span class="ai-model-branch-name">{{ group.catalog }}</span>
                <span class="ai-model-branch-count">{{ group.models.length }}</span>
              </button>
              <div
                v-show="expandedPlatforms[group.catalog] !== false"
                class="ai-model-branch-items"
              >
                <button
                  v-for="m in group.models"
                  :id="`ai-model-opt-${m.id}`"
                  :key="m.id"
                  type="button"
                  class="ai-model-choice"
                  :class="{ 'ai-model-choice--active': selectedModel === m.id }"
                  role="option"
                  :aria-selected="selectedModel === m.id"
                  @click.stop="pickModel(m.id)"
                >
                  <span class="ai-model-choice-label">{{ m.label }}</span>
                  <span class="ai-model-choice-id">{{ m.id }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="ai-search-input">
          <textarea
            v-model="freeInput"
            aria-label="消息"
            placeholder=""
            rows="1"
            @keydown="onFreeInputKeydown"
            @input="autoResizeTextarea"
            ref="inputTextareaRef"
          />
        </div>
        <button
          class="ai-search-send"
          :disabled="!freeInput.trim() || isLoading || !selectedModel"
          title="发送"
          @click="sendFreeChat"
        >
          ➤
        </button>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
/** Simple markdown-ish renderer (no external deps) */
function renderMarkdown(text: string): string {
  if (!text) return "";
  let html = text
    // Escape HTML
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Headers
    .replace(/^### (.+)$/gm, '<h4 class="ai-md-h">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 class="ai-md-h">$1</h3>')
    .replace(/^# (.+)$/gm, '<h2 class="ai-md-h">$1</h2>')
    // Horizontal rule
    .replace(/^---$/gm, "<hr />")
    // Line breaks
    .replace(/\n/g, "<br />");
  return html;
}
</script>

<style scoped>
.ai-agent-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-size: 0.85rem;
  color: var(--text);
  background: var(--surface);
}

/* Chat area — scrollbar stays at the rightmost edge */
.ai-chat-area {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.ai-empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  gap: 0.75rem;
  color: var(--muted);
}
.ai-empty-icon {
  opacity: 0.85;
}
.ai-empty-bot-img {
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  object-fit: cover;
  display: block;
  border: 1px solid var(--border);
}
.ai-empty-invite {
  margin: 0;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--muted);
}

/* Chat messages */
.ai-chat-msg {
  display: flex;
  gap: 0.5rem;
  max-width: 100%;
}
.ai-chat-msg.user {
  flex-direction: row-reverse;
}
.ai-msg-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--bg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
  flex-shrink: 0;
  border: 1px solid var(--border);
  overflow: hidden;
}
.ai-msg-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
/** BOT 图为全身/多元素合成，圆内取上部偏中的「脸」区域 */
.ai-avatar-bot {
  object-position: center 28%;
}
.ai-msg-avatar-fallback {
  line-height: 1;
}
.ai-msg-bubble {
  max-width: 85%;
  padding: 0.5rem 0.75rem;
  border-radius: 12px;
  font-size: 0.8rem;
  line-height: 1.6;
  word-break: break-word;
}
.ai-chat-msg.user .ai-msg-bubble {
  background: var(--primary);
  color: var(--on-primary);
  border-bottom-right-radius: 4px;
}
.ai-chat-msg.assistant .ai-msg-bubble {
  background: var(--bg);
  color: var(--text);
  border-bottom-left-radius: 4px;
  border: 1px solid var(--border);
}

/* Markdown content */
.ai-msg-content :deep(h2),
.ai-msg-content :deep(h3),
.ai-msg-content :deep(h4) {
  margin: 0.5rem 0 0.25rem;
  font-weight: 700;
}
.ai-msg-content :deep(h2) { font-size: 1rem; }
.ai-msg-content :deep(h3) { font-size: 0.92rem; }
.ai-msg-content :deep(h4) { font-size: 0.85rem; }
.ai-msg-content :deep(code) {
  background: rgba(0, 0, 0, 0.15);
  padding: 0.1rem 0.3rem;
  border-radius: 4px;
  font-size: 0.78rem;
}
.ai-msg-content :deep(strong) {
  font-weight: 700;
}
.ai-msg-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 0.5rem 0;
}

/* Typing indicator */
.ai-typing-indicator {
  display: flex;
  gap: 4px;
  padding-top: 0.3rem;
}
.ai-typing-indicator span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
  animation: ai-bounce 1.2s infinite;
}
.ai-typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
.ai-typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
@keyframes ai-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
}

/* 快捷：标题行（右侧 分析中/停止、清空） */
.ai-quick-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
}
.ai-quick-header-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.35rem;
  flex-shrink: 0;
}
.ai-quick-busy-hint {
  font-size: 0.66rem;
  color: var(--muted);
  white-space: nowrap;
}

/* 快捷：时间段 + 弹幕/礼物导出（位于模型选择条上方） */
.ai-quick-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.45rem;
}
.ai-quick-heading {
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--muted);
  flex-shrink: 0;
}
.ai-quick-field-label {
  font-size: 0.62rem;
  font-weight: 600;
  color: var(--muted);
  flex-shrink: 0;
  opacity: 0.9;
}
.ai-quick-select {
  flex: 1 1 7rem;
  min-width: 0;
  padding: 0.32rem 0.4rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 0.68rem;
  cursor: pointer;
}
.ai-quick-select--time {
  flex: 1 1 9rem;
  max-width: 14rem;
}
.ai-quick-select--room {
  flex: 2 1 10rem;
  max-width: 18rem;
}
.ai-quick-date {
  flex-shrink: 0;
  padding: 0.28rem 0.35rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 0.66rem;
}
.ai-quick-check {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.66rem;
  color: var(--text);
  cursor: pointer;
  user-select: none;
}
.ai-quick-check input {
  margin: 0;
  cursor: pointer;
}
.ai-quick-run {
  flex-shrink: 0;
  padding: 0.32rem 0.6rem;
  border-radius: 8px;
  border: none;
  background: var(--primary);
  color: #fff;
  font-size: 0.72rem;
  font-weight: 700;
  cursor: pointer;
}
.ai-quick-run:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}
.ai-quick-err {
  margin: 0;
  font-size: 0.64rem;
  color: #ff6b6b;
  line-height: 1.35;
}

/* ---- Input container ---- */
.ai-input-container {
  padding: 0.6rem 0.75rem;
  border-top: 1px solid var(--border);
  background: var(--surface);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.ai-action-btn {
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 0.7rem;
  cursor: pointer;
  transition: all 0.15s;
}
.ai-action-btn:hover {
  background: var(--bg);
  color: var(--text);
}
.ai-stop-btn {
  color: #ff6b6b;
  border-color: rgba(255, 107, 107, 0.4);
}
.ai-stop-btn:hover {
  background: rgba(255, 107, 107, 0.1);
  color: #ff4444;
}
.ai-clear-btn:hover {
  color: var(--text);
}

/* ---- Unified search bar (model | input | send) ---- */
.ai-search-bar {
  display: flex;
  align-items: stretch;
  border: 1px solid var(--border);
  border-radius: 22px;
  background: var(--bg);
  overflow: hidden;
  transition: border-color 0.15s;
}
.ai-search-bar--menu-open {
  overflow: visible;
  position: relative;
  z-index: 40;
  border-color: var(--primary);
}
.ai-input-container:has(.ai-search-bar--menu-open) {
  position: relative;
  z-index: 40;
}
.ai-search-bar:focus-within:not(.ai-search-bar--menu-open) {
  border-color: var(--primary);
}

/* Left: model picker (popover opens upward) */
.ai-search-model,
.ai-model-picker-root {
  position: relative;
  display: flex;
  align-items: stretch;
}
.ai-search-model {
  background: var(--surface);
  border-right: 1px solid var(--border);
  flex: 0 0 auto;
  width: auto;
  min-width: 0;
  max-width: none;
}

.ai-model-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.35rem;
  width: max-content;
  max-width: min(40vw, 12rem);
  min-width: 0;
  padding: 0.45rem 0.35rem 0.45rem 0.6rem;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
  border-radius: 0;
}
.ai-model-trigger:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: -2px;
}
.ai-model-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ai-model-trigger-main {
  flex: 0 1 auto;
  min-width: 0;
  max-width: min(34vw, 9.5rem);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-model-trigger-chev {
  flex-shrink: 0;
  font-size: 0.62rem;
  opacity: 0.72;
}

.ai-model-menu--above {
  position: absolute;
  left: 0;
  right: auto;
  bottom: calc(100% + 6px);
  box-sizing: border-box;
  min-width: 12rem;
  width: max(100%, 12rem);
  max-width: min(94vw, 22rem);
  max-height: min(52vh, 288px);
  overflow-x: hidden;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow:
    0 -12px 32px rgba(0, 0, 0, 0.2),
    0 -2px 8px rgba(0, 0, 0, 0.08);
  z-index: 45;
}

.ai-model-branch + .ai-model-branch {
  border-top: 1px solid var(--border);
}

.ai-model-branch-head {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  width: 100%;
  padding: 0.45rem 0.55rem;
  border: none;
  background: var(--bg);
  color: var(--text);
  font-size: 0.74rem;
  font-weight: 700;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s;
}
.ai-model-branch-head:hover {
  filter: brightness(1.06);
}

.ai-model-branch-chev {
  width: 0.75rem;
  flex-shrink: 0;
  font-size: 0.65rem;
  opacity: 0.82;
}

.ai-model-branch-name {
  flex: 1;
  min-width: 0;
}
.ai-model-branch-count {
  flex-shrink: 0;
  font-size: 0.62rem;
  font-weight: 600;
  color: var(--muted);
}

.ai-model-branch-items {
  padding: 0.1rem 0.35rem 0.48rem;
  background: var(--surface);
}

.ai-model-choice {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 0.06rem;
  width: 100%;
  padding: 0.35rem 0.45rem;
  margin: 1px 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}

.ai-model-choice:hover {
  background: var(--bg);
}

.ai-model-choice--active {
  background: rgba(99, 102, 241, 0.14);
  box-shadow: inset 0 0 0 1px rgba(99, 102, 241, 0.35);
}

.ai-model-choice-label {
  font-size: 0.72rem;
  font-weight: 600;
}

.ai-model-choice-id {
  font-size: 0.62rem;
  color: var(--muted);
  font-family: ui-monospace, "Cascadia Code", monospace;
  word-break: break-all;
  line-height: 1.3;
}

/* Middle: textarea */
.ai-search-input {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}
.ai-search-input textarea {
  width: 100%;
  padding: 0.45rem 0.6rem;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 0.82rem;
  resize: none;
  outline: none;
  font-family: inherit;
  line-height: 1.5;
  min-height: 36px;
  max-height: 120px;
  box-sizing: border-box;
}
.ai-search-input textarea::placeholder {
  color: var(--muted);
}

/* Right: send button (embedded) */
.ai-search-send {
  width: 38px;
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--primary);
  font-size: 1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s, background 0.15s;
}
.ai-search-send:hover:not(:disabled) {
  background: var(--surface);
  color: var(--primary);
}
.ai-search-send:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
</style>
