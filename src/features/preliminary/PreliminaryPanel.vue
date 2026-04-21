<script setup lang="ts">
import axios from "axios";
import { computed, inject, ref } from "vue";
import { createApi, douyuAvatarUrl } from "../../shared/api";
import type { ClientConfig } from "../../shared/api";
import {
  aggregatePreliminary,
  gameSum,
  withRank,
} from "./preliminary";
import type {
  PreliminaryAbilityRow,
  PreliminaryDateRank,
  PreliminaryFetchWarning,
} from "../../shared/types";
import MemberReactionsInline from "../../components/MemberReactionsInline.vue";
import type { PrePanelTab } from "../../shared/appRoute";
import { FMZ_TREASURY_AVATAR_KEY } from "../../shared/treasuryAvatarOpen";

/** 表头用：游戏 1–9 */
const GAME_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

function cellG(r: PreliminaryAbilityRow, n: number): string {
  const v = r[`g${n}` as keyof PreliminaryAbilityRow] as number;
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString();
}

function rowAvatarUrl(r: PreliminaryAbilityRow): string {
  const a = r.raw?.avatar;
  return douyuAvatarUrl(typeof a === "string" ? a : String(a ?? ""));
}

function cardAvatarUrl(avatar: unknown): string {
  return douyuAvatarUrl(typeof avatar === "string" ? avatar : "");
}

const props = defineProps<{ config: ClientConfig }>();

const treasuryAvatar = inject(FMZ_TREASURY_AVATAR_KEY);

function onTreasuryAvatarClick(id: string | number) {
  treasuryAvatar?.openIfMember(id);
}

/** 与地址栏 #/pre/xxx 同步（由 App 绑定） */
const panelTab = defineModel<PrePanelTab>("panelTab", { default: "total" });

const loading = ref(false);
const err = ref("");
const dateRanks = ref<PreliminaryDateRank[]>([]);
const abilityRows = ref<PreliminaryAbilityRow[]>([]);
const fetchWarnings = ref<PreliminaryFetchWarning[]>([]);
const kvPreliminaryParseFailed = ref(false);
const round = ref(1);

/** 与官网 PreliminaryData 一致：money.list 默认 size=100（见 .env VITE_PRELIMINARY_MONEY_PAGE_SIZE） */
const preliminaryMoneyPageSize = Number(
  import.meta.env.VITE_PRELIMINARY_MONEY_PAGE_SIZE ?? 100,
);

async function load() {
  loading.value = true;
  err.value = "";
  dateRanks.value = [];
  abilityRows.value = [];
  fetchWarnings.value = [];
  kvPreliminaryParseFailed.value = false;
  try {
    const api = createApi(props.config);
    const moneyListBody = {
      page: 1,
      size: Number.isFinite(preliminaryMoneyPageSize) && preliminaryMoneyPageSize > 0
        ? preliminaryMoneyPageSize
        : 100,
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

    const res = await aggregatePreliminary({
      moneyList: () => api.moneyList(moneyListBody),
      kvData: (keys) => api.keyvalueData(keys),
      proxyGet: async (url) => {
        const r = (await api.proxyExecute(url, "GET")) as {
          code: number;
          data?: string;
        };
        return r;
      },
    });

    if (res.error) err.value = res.error;
    dateRanks.value = res.dateRanks;
    abilityRows.value = res.abilityRows;
    fetchWarnings.value = res.fetchWarnings;
    kvPreliminaryParseFailed.value = res.kvPreliminaryParseFailed;
  } catch (e: unknown) {
    if (axios.isAxiosError(e)) {
      const st = e.response?.status;
      const d = e.response?.data;
      const body =
        typeof d === "string"
          ? d
          : d != null
            ? JSON.stringify(d)
            : "";
      err.value = `HTTP ${st ?? "?"} ${e.config?.method?.toUpperCase()} ${e.config?.url ?? ""}: ${body || e.message}`;
    } else {
      err.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    loading.value = false;
  }
}

const rankedTotal = computed(() =>
  withRank(abilityRows.value, (r) => r.total),
);
const rankedNoGf = computed(() =>
  withRank(abilityRows.value, (r) => gameSum(r)),
);
/** 按伐木值积分（gf）排名，与总分表「伐木值积分 gf」列一致 */
const rankedGf = computed(() => withRank(abilityRows.value, (r) => r.gf));

/** 按日预赛日期列（与 dateRanks /「按日预赛伐木值」同源） */
const gfDateColumns = computed(() => dateRanks.value.map((b) => b.date));

/** 成员 id → 日期字符串 → 当日伐木值 */
const gfDailyFlowByMember = computed(() => {
  const out: Record<string, Record<string, number>> = {};
  for (const block of dateRanks.value) {
    const { date } = block;
    for (const it of block.list) {
      const id = String(it.id);
      if (!out[id]) out[id] = {};
      out[id][date] = it.value;
    }
  }
  return out;
});

function cellDailyFlow(id: string | number, date: string): string {
  const v = gfDailyFlowByMember.value[String(id)]?.[date];
  if (v === undefined || !Number.isFinite(v)) return "—";
  return v.toLocaleString();
}

const rankedRound = computed(() => {
  const k = `g${round.value}` as keyof PreliminaryAbilityRow;
  return withRank(abilityRows.value, (r) => Number(r[k] as number));
});

defineExpose({ load });
</script>

<template>
  <section class="panel">
    <div class="head">
      <h2>预赛数据</h2>
      <button type="button" class="primary" :disabled="loading" @click="load">
        {{ loading ? "加载中…" : "刷新预赛" }}
      </button>
    </div>
    <p v-if="err" class="err">{{ err }}</p>
    <div v-if="kvPreliminaryParseFailed" class="err">
      keyvalue 的 <code>system.preliminary.data</code> 不是合法 JSON，无法解析预赛日期列表。
    </div>
    <div v-if="fetchWarnings.length" class="warn-box">
      <p class="warn-title">未纳入的日期</p>
      <ul class="warn-list">
        <li v-for="w in fetchWarnings" :key="(w.url || '') + w.date + w.reason">
          <strong>{{ w.date }}</strong> — {{ w.reason }}
          <div v-if="w.url" class="warn-url">
            <code>{{ w.url }}</code>
          </div>
        </li>
      </ul>
    </div>

    <div class="pre-subview" role="tablist" aria-label="预赛数据子视图">
      <button
        :class="{ on: panelTab === 'total' }"
        type="button"
        role="tab"
        :aria-selected="panelTab === 'total'"
        @click="panelTab = 'total'"
      >
        总分排名
      </button>
      <button
        :class="{ on: panelTab === 'nogf' }"
        type="button"
        role="tab"
        :aria-selected="panelTab === 'nogf'"
        @click="panelTab = 'nogf'"
      >
        除掉伐木值积分（仅九轮之和）
      </button>
      <button
        :class="{ on: panelTab === 'perround' }"
        type="button"
        role="tab"
        :aria-selected="panelTab === 'perround'"
        @click="panelTab = 'perround'"
      >
        每轮游戏排名
      </button>
      <button
        :class="{ on: panelTab === 'gf' }"
        type="button"
        role="tab"
        :aria-selected="panelTab === 'gf'"
        @click="panelTab = 'gf'"
      >
        伐木值积分
      </button>
      <button
        :class="{ on: panelTab === 'logging' }"
        type="button"
        role="tab"
        :aria-selected="panelTab === 'logging'"
        @click="panelTab = 'logging'"
      >
        按日预赛伐木值
      </button>
    </div>

    <div v-if="panelTab === 'perround'" class="round-pick">
      <label>选择轮次</label>
      <select v-model.number="round">
        <option v-for="n in 9" :key="n" :value="n">游戏 {{ n }}</option>
      </select>
    </div>

    <div v-if="panelTab === 'logging'" class="dates">
      <div v-for="block in dateRanks" :key="block.date" class="block">
        <h3>{{ block.date }}</h3>
        <table class="wide-table">
          <thead>
            <tr>
              <th class="col-avatar">头像</th>
              <th>排名</th>
              <th>名称</th>
              <th class="col-react">赞 / 踩</th>
              <th class="num">本场伐木值</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(it, idx) in block.list" :key="it.id">
              <td class="avatar-cell">
                <img
                  v-if="cardAvatarUrl(it.avatar)"
                  class="av-treasury-hit"
                  :src="cardAvatarUrl(it.avatar)"
                  alt=""
                  referrerpolicy="no-referrer"
                  title="金库成员：点击查看余额与流水"
                  @click.stop="onTreasuryAvatarClick(it.id)"
                />
              </td>
              <td>{{ idx + 1 }}</td>
              <td>{{ it.name }}</td>
              <td class="col-react">
                <MemberReactionsInline :member-id="it.id" />
              </td>
              <td class="num">{{ Number(it.value || 0).toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-else class="table-wrap">
      <table v-if="panelTab === 'total'" class="wide-table">
        <thead>
          <tr>
            <th class="col-avatar">头像</th>
            <th>排名</th>
            <th class="col-name">名称</th>
            <th class="col-react">赞 / 踩</th>
            <th v-for="n in GAME_INDEXES" :key="'h-g' + n" class="num game-col">游戏{{ n }}</th>
            <th class="num">九轮和</th>
            <th class="num">伐木值积分 gf</th>
            <th class="num">累计伐木值</th>
            <th class="num">总分</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rankedTotal" :key="r.id">
            <td class="avatar-cell">
              <img
                v-if="rowAvatarUrl(r)"
                class="av-treasury-hit"
                :src="rowAvatarUrl(r)"
                alt=""
                referrerpolicy="no-referrer"
                title="金库成员：点击查看余额与流水"
                @click.stop="onTreasuryAvatarClick(r.id)"
              />
            </td>
            <td>{{ r.rank }}</td>
            <td class="col-name">{{ r.name }}</td>
            <td class="col-react">
              <MemberReactionsInline :member-id="r.id" />
            </td>
            <td v-for="n in GAME_INDEXES" :key="'g' + n" class="num game-col">{{ cellG(r, n) }}</td>
            <td class="num">{{ gameSum(r).toLocaleString() }}</td>
            <td class="num">{{ r.gf }}</td>
            <td class="num">{{ r.flow.toLocaleString() }}</td>
            <td class="num strong">{{ r.total.toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>

      <table v-else-if="panelTab === 'nogf'" class="wide-table">
        <thead>
          <tr>
            <th class="col-avatar">头像</th>
            <th>排名</th>
            <th class="col-name">名称</th>
            <th class="col-react">赞 / 踩</th>
            <th v-for="n in GAME_INDEXES" :key="'nh-g' + n" class="num game-col">游戏{{ n }}</th>
            <th class="num">九轮和（不含 gf）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rankedNoGf" :key="r.id">
            <td class="avatar-cell">
              <img
                v-if="rowAvatarUrl(r)"
                class="av-treasury-hit"
                :src="rowAvatarUrl(r)"
                alt=""
                referrerpolicy="no-referrer"
                title="金库成员：点击查看余额与流水"
                @click.stop="onTreasuryAvatarClick(r.id)"
              />
            </td>
            <td>{{ r.rank }}</td>
            <td class="col-name">{{ r.name }}</td>
            <td class="col-react">
              <MemberReactionsInline :member-id="r.id" />
            </td>
            <td v-for="n in GAME_INDEXES" :key="'ng' + n" class="num game-col">{{ cellG(r, n) }}</td>
            <td class="num strong">{{ gameSum(r).toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>

      <table v-else-if="panelTab === 'gf'" class="wide-table gf-daily-table">
        <thead>
          <tr>
            <th class="col-avatar">头像</th>
            <th>排名</th>
            <th class="col-name">名称</th>
            <th class="col-react">赞 / 踩</th>
            <th
              v-for="d in gfDateColumns"
              :key="'gf-dh-' + d"
              class="num col-daily"
              :title="d"
            >
              {{ d }}
            </th>
            <th class="num">累计伐木值</th>
            <th class="num">伐木值积分</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rankedGf" :key="r.id">
            <td class="avatar-cell">
              <img
                v-if="rowAvatarUrl(r)"
                class="av-treasury-hit"
                :src="rowAvatarUrl(r)"
                alt=""
                referrerpolicy="no-referrer"
                title="金库成员：点击查看余额与流水"
                @click.stop="onTreasuryAvatarClick(r.id)"
              />
            </td>
            <td>{{ r.rank }}</td>
            <td class="col-name">{{ r.name }}</td>
            <td class="col-react">
              <MemberReactionsInline :member-id="r.id" />
            </td>
            <td
              v-for="d in gfDateColumns"
              :key="'gf-dd-' + r.id + '-' + d"
              class="num col-daily"
            >
              {{ cellDailyFlow(r.id, d) }}
            </td>
            <td class="num">{{ r.flow.toLocaleString() }}</td>
            <td class="num strong">{{ r.gf.toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>

      <table v-else-if="panelTab === 'perround'" class="wide-table">
        <thead>
          <tr>
            <th class="col-avatar">头像</th>
            <th>排名</th>
            <th class="col-name">名称</th>
            <th class="col-react">赞 / 踩</th>
            <th class="num">游戏 {{ round }} 积分</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rankedRound" :key="r.id">
            <td class="avatar-cell">
              <img
                v-if="rowAvatarUrl(r)"
                class="av-treasury-hit"
                :src="rowAvatarUrl(r)"
                alt=""
                referrerpolicy="no-referrer"
                title="金库成员：点击查看余额与流水"
                @click.stop="onTreasuryAvatarClick(r.id)"
              />
            </td>
            <td>{{ r.rank }}</td>
            <td class="col-name">{{ r.name }}</td>
            <td class="col-react">
              <MemberReactionsInline :member-id="r.id" />
            </td>
            <td class="num strong">{{ (r as unknown as Record<string, number>)[`g${round}`].toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.panel {
  padding: 1rem 1.25rem 2rem;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
h2 {
  margin: 0;
}
button.primary {
  padding: 0.5rem 1rem;
  border-radius: 8px;
  border: none;
  background: var(--primary);
  color: var(--on-primary);
  font-weight: 600;
  cursor: pointer;
}
button.primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.err {
  color: var(--danger);
}
.warn-box {
  margin: 0.5rem 0 0;
  padding: 0.6rem 0.75rem;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  background: color-mix(in srgb, var(--surface) 92%, var(--accent));
  font-size: 0.82rem;
  max-width: 900px;
}
.warn-title {
  margin: 0 0 0.35rem;
  color: var(--text);
}
.warn-list {
  margin: 0;
  padding-left: 1.2rem;
}
.warn-url {
  margin: 0.25rem 0 0;
  font-size: 0.72rem;
  line-height: 1.35;
  word-break: break-all;
}
.warn-url code {
  color: var(--muted);
}
/* 与 App 顶栏主导航区分：下划线分段，避免「一排页签套一排页签」观感 */
.pre-subview {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  margin: 0.75rem 0 1rem;
  padding: 0;
  border-bottom: 1px solid var(--border);
  max-width: 100%;
}
.pre-subview button {
  margin: 0;
  padding: 0.45rem 0.65rem 0.5rem;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  border-radius: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 600;
}
.pre-subview button.on {
  color: var(--text);
  border-bottom-color: var(--primary);
  background: color-mix(in srgb, var(--surface) 55%, transparent);
}
.pre-subview button:hover:not(.on) {
  color: var(--text);
  background: color-mix(in srgb, var(--surface) 35%, transparent);
}
.round-pick {
  margin-bottom: 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.round-pick select {
  padding: 0.35rem 0.5rem;
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
}
.table-wrap {
  overflow: auto;
}
.wide-table {
  min-width: 1100px;
}
.gf-daily-table th.col-daily,
.gf-daily-table td.col-daily {
  min-width: 5.25rem;
  max-width: 8rem;
  font-size: 0.78rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
th.col-avatar,
td.avatar-cell {
  width: 56px;
  text-align: center;
  vertical-align: middle;
}
.avatar-cell img {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  display: inline-block;
  vertical-align: middle;
  border: 1px solid var(--border);
}
.avatar-cell img.av-treasury-hit {
  cursor: pointer;
}
th.game-col,
td.game-col {
  min-width: 3.25rem;
  white-space: nowrap;
}
.col-name {
  min-width: 6rem;
}
th.col-react,
td.col-react {
  white-space: nowrap;
  vertical-align: middle;
  text-align: center;
}
td.col-react {
  padding: 0.35rem 0.5rem;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}
th,
td {
  border: 1px solid var(--border);
  padding: 0.45rem 0.6rem;
  text-align: left;
}
th {
  background: var(--surface);
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.strong {
  font-weight: 700;
  color: var(--accent);
}
.muted {
  color: var(--muted);
}
.small {
  font-size: 0.75rem;
}
.dates .block {
  margin-bottom: 1.5rem;
}
.dates h3 {
  margin: 0 0 0.5rem;
  color: var(--primary);
}
</style>
