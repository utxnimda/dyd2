<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  DEFENSE_TOWER_NAMES,
  fetchDefenseHistory,
  fetchDefenseOverview,
  mergeMinuteHeat,
  postDefenseRefresh,
  secondsToUpstreamSyncTick,
  towerTopClockMinutes,
  type DefenseHistoryRow,
  type DefenseOverview,
} from "../lib/defenseTowerApi";
import SiegeOrbitBoard from "./SiegeOrbitBoard.vue";

const loading = ref(false);
const err = ref("");
const overview = ref<DefenseOverview | null>(null);
const historyRows = ref<DefenseHistoryRow[]>([]);
const tick = ref(0);
let tickTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const countdownSec = computed(() => {
  void tick.value;
  return secondsToUpstreamSyncTick();
});

const snap = computed(() => overview.value?.snapshot ?? null);
const pred = computed(() => snap.value?.report?.report_prediction);

function fmtTs(ms: number): string {
  try {
    return new Date(ms).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(ms);
  }
}

async function loadOverview() {
  try {
    overview.value = await fetchDefenseOverview();
    err.value = "";
  } catch (e) {
    err.value = String(e);
    overview.value = null;
  }
}

async function loadHistory() {
  try {
    const { rows } = await fetchDefenseHistory(100);
    historyRows.value = rows;
  } catch {
    historyRows.value = [];
  }
}

async function reload() {
  loading.value = true;
  err.value = "";
  try {
    await Promise.all([loadOverview(), loadHistory()]);
  } finally {
    loading.value = false;
  }
}

async function onRefreshNow() {
  err.value = "";
  try {
    await postDefenseRefresh();
    await reload();
  } catch (e) {
    err.value = String(e);
  }
}

onMounted(() => {
  void reload();
  tickTimer = setInterval(() => {
    tick.value++;
  }, 1000);
  pollTimer = setInterval(() => {
    void loadOverview();
  }, 15_000);
});

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
  if (pollTimer) clearInterval(pollTimer);
});

defineExpose({ load: reload, reload });

watch(
  () => snap.value?.fetchedAt,
  () => {
    void loadHistory();
  },
);

const heat = computed(() => mergeMinuteHeat(snap.value?.report?.report_minute, 14));
const towerHints = computed(() => {
  const r = snap.value?.report;
  if (!r) return [];
  return (["1", "2", "3"] as const).map((id) => ({
    id,
    name: DEFENSE_TOWER_NAMES[id] ?? id,
    top: towerTopClockMinutes(r.report_minute_tower, id, 5),
  }));
});
</script>

<template>
  <section class="wrap">
    <header class="head">
      <div>
        <h2 class="title">大话三国 · 攻城助手</h2>
        <p class="sub">
          数据来自
          <a href="https://tool.100if.com/douyuDefenseTower/" target="_blank" rel="noreferrer"
            >tool.100if.com/douyuDefenseTower</a
          >
          ；本页在本地库中落地每次拉取的完整 JSON，便于回溯与自建分析。
        </p>
      </div>
      <div class="actions">
        <button type="button" class="btn" :disabled="loading" @click="onRefreshNow">立即同步</button>
        <button type="button" class="btn ghost" :disabled="loading" @click="reload">刷新视图</button>
      </div>
    </header>

    <p v-if="err" class="err">{{ err }}</p>
    <p
      v-else-if="overview && !snap && !loading"
      class="warn-banner"
    >
      本地库尚无<strong>成功</strong>快照（可能上游暂时失败）。请点击「立即同步」或稍后重试；开发环境需先启动
      <code>npm run defense-tower-server</code> 或 <code>npm run dev:all</code>。
    </p>

    <SiegeOrbitBoard
      :report="snap?.report"
      :seconds-to-sync="countdownSec"
      :clock="tick"
    />

    <div class="grid">
      <article class="card">
        <h3>同步与入库</h3>
        <p class="muted">
          上方环形中心为距下次数据对齐的<strong>秒数</strong>（与源站一致：约在每分钟<strong>第 48 秒</strong>刷新统计）。
        </p>
        <p v-if="overview?.lastRow" class="muted">
          最近一次入库：<strong>{{ fmtTs(overview.lastRow.fetchedAt) }}</strong>
          · 快照数 {{ overview.historyCount }}
        </p>
      </article>

      <article class="card">
        <h3>上游预测窗口</h3>
        <p v-if="!pred" class="muted">尚无可用快照，请确认已启动本地服务：</p>
        <template v-else>
          <div v-for="tier in ['hight_priority', 'middle_priority'] as const" :key="tier" class="pred-block">
            <h4>{{ tier === "hight_priority" ? "高优先" : "中优先" }}</h4>
            <div v-for="tid in ['1', '2', '3']" :key="tier + tid" class="pred-row">
              <span class="tag">{{ DEFENSE_TOWER_NAMES[tid] ?? tid }}</span>
              <span class="vals">{{
                (pred[tier]?.[tid] ?? []).join(" · ") || "—"
              }}</span>
            </div>
          </div>
        </template>
      </article>

      <article class="card wide">
        <h3>结合历史分布的本地提示</h3>
        <p class="muted">
          以下由<strong>当前快照</strong>中的 <code>report_minute</code> / <code>report_minute_tower</code> 统计得到，用于辅助阅读，不构成精确预报。
        </p>
        <div class="split">
          <div>
            <h4>近 60 分钟高热分钟（合并）</h4>
            <ul class="chips">
              <li v-for="h in heat" :key="h.minute">
                <span class="chip">{{ h.minute }}</span>
                <span class="cnt">{{ h.count }}</span>
              </li>
              <li v-if="heat.length === 0" class="muted">无数据</li>
            </ul>
          </div>
          <div>
            <h4>各城「常攻分钟刻度」(00–59)</h4>
            <div v-for="t in towerHints" :key="t.id" class="tower-line">
              <strong>{{ t.name }}</strong>
              <span class="muted">{{
                t.top.map((x) => `${x.minute}′×${x.count}`).join("，") || "—"
              }}</span>
            </div>
          </div>
        </div>
      </article>
    </div>

    <article class="card table-card">
      <h3>本地快照历史（SQLite）</h3>
      <p class="muted">
        表 <code>defense_snapshots</code>，文件默认在 <code>server/data/defense_tower.db</code>。服务启动后会按整分钟对齐轮询上游。
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>拉取时间</th>
              <th>HTTP</th>
              <th>成功</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in historyRows" :key="r.id">
              <td>{{ r.id }}</td>
              <td>{{ fmtTs(r.fetched_at) }}</td>
              <td>{{ r.http_status }}</td>
              <td>{{ r.ok ? "是" : "否" }}</td>
            </tr>
            <tr v-if="historyRows.length === 0">
              <td colspan="4" class="muted">暂无记录</td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>
  </section>
</template>

<style scoped>
.wrap {
  padding: 0.75rem 1.25rem 2rem;
  max-width: 1100px;
  margin: 0 auto;
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}
.title {
  margin: 0 0 0.35rem;
  font-size: 1.25rem;
}
.sub {
  margin: 0;
  color: var(--muted);
  font-size: 0.9rem;
  max-width: 52rem;
  line-height: 1.5;
}
.actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}
.btn {
  border: 1px solid var(--border);
  background: var(--primary);
  color: var(--on-primary);
  padding: 0.45rem 0.9rem;
  border-radius: 10px;
  cursor: pointer;
  font-weight: 600;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.btn.ghost {
  background: var(--surface);
  color: var(--text);
}
.err {
  color: var(--danger);
  margin: 0 0 0.75rem;
}
.warn-banner {
  margin: 0 0 0.75rem;
  padding: 0.55rem 0.75rem;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
  background: color-mix(in srgb, var(--surface) 90%, var(--accent));
  color: var(--text);
  font-size: 0.85rem;
  line-height: 1.45;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}
@media (max-width: 880px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 0.85rem 1rem;
}
.card.wide {
  grid-column: 1 / -1;
}
.card h3 {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}
.card h4 {
  margin: 0.5rem 0 0.35rem;
  font-size: 0.9rem;
  color: var(--muted);
}
.muted {
  color: var(--muted);
  font-size: 0.85rem;
  line-height: 1.45;
  margin: 0.25rem 0 0;
}
.pred-block + .pred-block {
  margin-top: 0.5rem;
}
.pred-row {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
  flex-wrap: wrap;
  margin: 0.2rem 0;
  font-size: 0.9rem;
}
.tag {
  display: inline-block;
  min-width: 2.5rem;
  padding: 0.1rem 0.45rem;
  border-radius: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  font-size: 0.8rem;
  font-weight: 700;
}
.vals {
  color: var(--text);
  word-break: break-all;
}
.split {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}
@media (max-width: 720px) {
  .split {
    grid-template-columns: 1fr;
  }
}
.chips {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.chips li {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.15rem 0.5rem;
  font-size: 0.8rem;
  background: var(--bg);
}
.chip {
  font-weight: 700;
}
.cnt {
  color: var(--muted);
}
.tower-line {
  margin: 0.25rem 0;
  font-size: 0.88rem;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}
.table-card {
  margin-top: 0.75rem;
}
.table-wrap {
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}
th,
td {
  padding: 0.45rem 0.6rem;
  border-bottom: 1px solid var(--border);
  text-align: left;
}
th {
  background: var(--bg);
  color: var(--muted);
  font-weight: 700;
}
tr:last-child td {
  border-bottom: none;
}
code {
  font-size: 0.85em;
}
</style>
