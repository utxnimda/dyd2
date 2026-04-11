<script setup lang="ts">
import axios from "axios";
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { createApi } from "../lib/api";
import type { ClientConfig } from "../lib/api";
import {
  enrichMissingAvatarsFromDoseeing,
  resolveAvatarForNicknameDisplay,
} from "../lib/doseeingAvatar";
import {
  CAPTAIN_COUNT,
  captainTeamsFromCards,
  normalizeMoneyList,
  type CaptainMoneyCard,
} from "../lib/captainTeams";
import type { FlyActorHint } from "../lib/recordSource";
import { inferFlyActorFromRecord } from "../lib/recordSource";
import type { ApiListResponse, MoneyCard, MoneyRecord } from "../types";
import MemberDislikeButton from "./MemberDislikeButton.vue";
import MemberLikeButton from "./MemberLikeButton.vue";

const props = withDefaults(
  defineProps<{
    config: ClientConfig;
    /** 轮询间隔 ms */
    pollMs?: number;
    /** 是否显示顶部工具条（独立小窗可关） */
    showControls?: boolean;
  }>(),
  /** 布尔 prop 在 Vue 中省略时默认为 false，需显式默认 true */
  { showControls: true },
);

const pollInterval = computed(() =>
  Math.max(1500, Math.min(60000, props.pollMs ?? 4000)),
);
const showToolbar = computed(() => props.showControls !== false);

const loading = ref(false);
const err = ref("");
const paused = ref(false);

const cards = shallowRef<CaptainMoneyCard[]>([]);
/** 界面展示的队长余额（动画结束后才追上服务器） */
const displayBalance = ref<Record<string, number>>({});
/** 最近一次拉取到的余额 */
const serverBalance = ref<Record<string, number>>({});

const teams = computed(() => captainTeamsFromCards(cards.value));

const allCaptains = computed(() => {
  const out: CaptainMoneyCard[] = [];
  for (const t of teams.value) out.push(...t.members);
  return out;
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
/** 四角游戏区，飞入头像由此区域几何中心出发 */
const boardFlyHubRef = ref<HTMLElement | null>(null);

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

/** 加减分飞头像起点：看板中心（与 FLY_SIZE 对齐为左上角坐标） */
function boardHubStart(size: number): { x: number; y: number } {
  const el = boardFlyHubRef.value;
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
  for (const c of allCaptains.value) {
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
  await nextTick();
  const targetEl = anchorEl(target.id);
  const end = rectOf(targetEl, size) ?? boardHubStart(size);
  const start = boardHubStart(size);

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
    x0: start.x,
    y0: start.y,
    x1: end.x,
    y1: end.y,
    size,
  };
  await nextTick();

  const layer = flyMoverRef.value;
  if (!layer) {
    fly.value = null;
    return;
  }
  layer.style.transition = "none";
  layer.style.transform = `translate(${start.x}px, ${start.y}px)`;
  void layer.offsetHeight;
  layer.style.transition = `transform ${flyMs}ms cubic-bezier(0.4, 0, 0.2, 1)`;
  layer.style.transform = `translate(${end.x}px, ${end.y}px)`;

  await new Promise<void>((resolve) => {
    const done = () => {
      layer.removeEventListener("transitionend", done);
      resolve();
    };
    layer.addEventListener("transitionend", done);
    setTimeout(done, Math.ceil(flyMs) + 120);
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
    const target = allCaptains.value.find((c) => balKey(c.id) === balKey(item.targetId));
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
      allCaptains.value,
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

async function tick() {
  if (paused.value) return;
  try {
    const list = await fetchCards();
    cards.value = list;
    const nextSrv: Record<string, number> = {};
    for (const c of list) {
      if (c._orderIndex < CAPTAIN_COUNT) {
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
    await tick();
  } finally {
    loading.value = false;
  }
}

/** 本地演示「进攻」：飞头像 + 扣分飘字 + 头像红闪（不请求后端）。建议先勾选「暂停轮询」。 */
async function demoAttackHit() {
  const caps = allCaptains.value;
  if (caps.length < 2) {
    err.value = "至少需要 2 名队长数据才能演示进攻";
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
    void tick();
  }, pollInterval.value);
}

function stopPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

onMounted(async () => {
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
      <span class="title">队长四角看板</span>
      <label class="pause">
        <input v-model="paused" type="checkbox" />
        暂停轮询
      </label>
      <button type="button" class="btn" :disabled="loading" @click="manualLoad">
        {{ loading ? "刷新中…" : "立即刷新" }}
      </button>
      <button
        type="button"
        class="btn btn-demo"
        :disabled="loading || allCaptains.length < 2 || processing"
        title="先暂停轮询可避免下次刷新把演示余额同步回去"
        @click="demoAttackHit"
      >
        演示进攻效果
      </button>
    </div>
    <p v-if="err" class="err">{{ err }}</p>

    <div ref="boardFlyHubRef" class="corners">
      <div
        v-for="team in teams"
        :key="team.label"
        class="corner"
        :class="'corner-' + team.corner"
        :style="{ '--accent': team.accent }"
      >
        <div class="team-tag">{{ team.label }}队</div>
        <div class="members">
          <div
            v-for="c in team.members"
            :key="String(c.id)"
            class="slot"
            :class="{
              ishit: hitIds.has(balKey(c.id)),
              isheal: healIds.has(balKey(c.id)),
            }"
          >
            <div class="slot-inner">
              <div class="av-wrap">
                <img
                  v-if="c.avatar"
                  class="av"
                  :data-captain-anchor="balKey(c.id)"
                  :src="c.avatar"
                  alt=""
                  referrerpolicy="no-referrer"
                />
                <div
                  v-else
                  class="av ph"
                  :data-captain-anchor="balKey(c.id)"
                />
                <div class="parked-stack" aria-hidden="true">
                  <div
                    v-for="p in parkedNear.filter((x) => x.targetKey === balKey(c.id))"
                    :key="p.key"
                    class="parked-item"
                  >
                    <img
                      class="parked-mini"
                      :src="p.src"
                      alt=""
                      referrerpolicy="no-referrer"
                    />
                    <span class="parked-name">{{ p.name }}</span>
                  </div>
                </div>
                <div
                  v-for="f in floaters.filter((x) => x.id === balKey(c.id))"
                  :key="f.key"
                  class="floater"
                  :class="f.kind"
                  :style="{ '--f-stack': f.stackIndex }"
                >
                  {{ f.text }}
                </div>
              </div>
              <div class="hud-reactions">
                <MemberLikeButton :member-id="c.id" variant="hud" />
                <MemberDislikeButton :member-id="c.id" variant="hud" />
              </div>
              <div class="meta">
                <div class="nm">{{ c.name }}</div>
                <div class="pts">
                  {{ (displayBalance[balKey(c.id)] ?? 0).toLocaleString() }}
                </div>
              </div>
            </div>
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
  background: linear-gradient(160deg, rgba(26, 35, 50, 0.95), rgba(15, 20, 25, 0.98));
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
.title {
  font-weight: 700;
  color: var(--text, #e8eef7);
}
.pause {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
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

.corners {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: auto auto;
  gap: 0.5rem 0.75rem;
  min-height: 200px;
}
.corner {
  border-radius: 12px;
  padding: 0.45rem 0.5rem 0.55rem;
  border: 2px solid color-mix(in srgb, var(--accent) 45%, var(--border, #2d3a4d));
  background: color-mix(in srgb, var(--accent) 10%, var(--surface, #1a2332));
  overflow: visible;
}
.corner-tl {
  justify-self: start;
  align-self: start;
  max-width: 100%;
}
.corner-tr {
  justify-self: end;
  align-self: start;
  max-width: 100%;
}
.corner-bl {
  justify-self: start;
  align-self: end;
  max-width: 100%;
}
.corner-br {
  justify-self: end;
  align-self: end;
  max-width: 100%;
}
.team-tag {
  font-size: 0.72rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  color: var(--accent);
  margin-bottom: 0.35rem;
}
.members {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  overflow: visible;
}
.slot {
  position: relative;
  overflow: visible;
}
.slot-inner {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}
.hud-reactions {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.15rem;
  align-self: center;
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
  border: 2px solid color-mix(in srgb, var(--accent) 50%, #444);
  flex-shrink: 0;
  display: block;
}
.av.ph {
  background: #2a3544;
}
.meta {
  min-width: 0;
}
.nm {
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1.15;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 7.5rem;
}
.pts {
  font-size: 0.78rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  color: var(--accent, #3dd68c);
}

.slot.ishit .av {
  animation: shake 0.5s ease;
  box-shadow: 0 0 0 0 rgba(255, 80, 80, 0.65);
}
.slot.ishit .av,
.slot.ishit .av.ph {
  border-color: #ff6b6b;
}
.slot.isheal .av {
  animation: pulseheal 0.65s ease;
  box-shadow: 0 0 14px rgba(61, 214, 140, 0.55);
}
.slot.isheal .av,
.slot.isheal .av.ph {
  border-color: #3dd68c;
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
  border: 1px solid rgba(255, 255, 255, 0.4);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}
.parked-name {
  font-size: 0.58rem;
  font-weight: 800;
  color: var(--text, #e8eef7);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85);
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
  color: #ff6b6b;
}
.floater.heal {
  color: #7dffb3;
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
  box-shadow: 0 3px 14px rgba(0, 0, 0, 0.5);
  border: 1.5px solid rgba(255, 255, 255, 0.38);
  flex-shrink: 0;
}
.fly-avatar-layer .fly-mover-name {
  font-size: 11px;
  font-weight: 800;
  line-height: 1.25;
  color: #f8fafc;
  text-align: center;
  max-width: 96px;
  min-width: 0;
  width: max-content;
  max-height: 2.6em;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.95), 0 0 8px rgba(0, 0, 0, 0.6);
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
