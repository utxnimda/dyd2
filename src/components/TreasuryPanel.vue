<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { createApi } from "../lib/api";
import type { ClientConfig } from "../lib/api";
import { enrichMissingAvatarsFromDoseeing } from "../lib/doseeingAvatar";
import {
  CAPTAIN_COUNT,
  captainTeamsFromCards,
  normalizeMoneyList,
  TEAM_COUNT,
  TEAM_DEFS,
  TEAM_SIZE,
  type CaptainMoneyCard,
} from "../lib/captainTeams";
import { extractRecordSourceLabel } from "../lib/recordSource";
import { formatRecordContent } from "../lib/treasuryFormat";
import type { ApiListResponse, MoneyCard, MoneyRecord } from "../types";

/** 流水行：展示用 content 已格式化，sourceLabel 自原始记录解析 */
type TreasuryRecordRow = MoneyRecord & { sourceLabel: string };
import MemberDislikeButton from "./MemberDislikeButton.vue";
import MemberLikeButton from "./MemberLikeButton.vue";
type TreasuryCard = CaptainMoneyCard;

const props = defineProps<{ config: ClientConfig }>();

const cards = ref<TreasuryCard[]>([]);

/** 排序：原列表顺序 | 积分高→低 | 积分低→高 */
const sortMode = ref<"original" | "balance_desc" | "balance_asc">("original");
/** 显示范围 */
const roleFilter = ref<"all" | "captain" | "member">("all");

/** 仅队长模式：每行一队（紫/绿/蓝/粉），队内顺序可随积分排序变化 */
const captainTeamRows = computed(() => {
  const rows = captainTeamsFromCards(cards.value);
  if (sortMode.value === "original") return rows;
  return rows.map((row) => {
    let members = [...row.members];
    if (sortMode.value === "balance_desc") {
      members.sort((a, b) => Number(b.balance ?? 0) - Number(a.balance ?? 0));
    } else {
      members.sort((a, b) => Number(a.balance ?? 0) - Number(b.balance ?? 0));
    }
    return { ...row, members };
  });
});

const captainShownCount = computed(() =>
  captainTeamRows.value.reduce((n, row) => n + row.members.length, 0),
);

const displayCards = computed(() => {
  if (roleFilter.value === "captain") return [];
  let list = [...cards.value];
  if (roleFilter.value === "member") {
    list = list.filter((c) => c._orderIndex >= CAPTAIN_COUNT);
  }
  if (sortMode.value === "balance_desc") {
    list.sort((a, b) => Number(b.balance ?? 0) - Number(a.balance ?? 0));
  } else if (sortMode.value === "balance_asc") {
    list.sort((a, b) => Number(a.balance ?? 0) - Number(b.balance ?? 0));
  } else {
    list.sort((a, b) => a._orderIndex - b._orderIndex);
  }
  return list;
});
const loading = ref(false);
const err = ref("");

const dlg = ref(false);
const detail = ref<MoneyCard | null>(null);
const records = ref<TreasuryRecordRow[]>([]);
const recPage = ref(1);
const recSize = ref(32);
const recTotal = ref(0);
const recLoading = ref(false);

async function loadCards() {
  loading.value = true;
  err.value = "";
  try {
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
      err.value = "加载金库失败";
      cards.value = [];
      return;
    }
    const p = props.config.currencyProportion || 100;
    cards.value = await enrichMissingAvatarsFromDoseeing(
      normalizeMoneyList(res.data.list, p),
    );
  } catch (e: unknown) {
    err.value = e instanceof Error ? e.message : String(e);
    cards.value = [];
  } finally {
    loading.value = false;
  }
}

async function openCard(id: string | number) {
  dlg.value = true;
  detail.value = null;
  records.value = [];
  recPage.value = 1;
  try {
    const api = createApi(props.config);
    const res = (await api.moneyGet(id)) as { code: number; data?: MoneyCard };
    if (res.code !== 0 || !res.data) {
      err.value = "加载卡片详情失败";
      return;
    }
    const p = props.config.currencyProportion || 100;
    const [one] = normalizeMoneyList([res.data], p);
    detail.value = one;
    await loadRecords();
  } catch (e: unknown) {
    err.value = e instanceof Error ? e.message : String(e);
  }
}

async function loadRecords() {
  if (!detail.value?.card) return;
  recLoading.value = true;
  try {
    const api = createApi(props.config);
    const body = {
      page: recPage.value,
      size: recSize.value,
      search: [
        {
          key: "card",
          value: String(detail.value.card),
          condition: "=",
          relationship: "AND",
          type: "CONDITION",
        },
      ],
    };
    const res = (await api.moneyRecordList(body)) as ApiListResponse<MoneyRecord>;
    if (res.code !== 0 || !res.data) return;
    recPage.value = res.data.page ?? recPage.value;
    recTotal.value = res.data.total ?? 0;
    records.value = (res.data.list || []).map((h) => ({
      ...h,
      sourceLabel: extractRecordSourceLabel(h) || "—",
      content: formatRecordContent(h),
    }));
  } finally {
    recLoading.value = false;
  }
}

function closeDlg() {
  dlg.value = false;
}

watch(
  () => props.config,
  () => loadCards(),
  { deep: true },
);

onMounted(() => loadCards());

defineExpose({ reload: loadCards });
</script>

<template>
  <section class="panel">
    <div class="head">
      <h2>团员金库</h2>
      <button type="button" class="primary" :disabled="loading" @click="loadCards">
        {{ loading ? "加载中…" : "刷新列表" }}
      </button>
    </div>
    <div class="toolbar">
      <label class="field">
        <span class="lbl">按积分排序</span>
        <select v-model="sortMode" class="sel">
          <option value="original">原列表顺序（与接口一致）</option>
          <option value="balance_desc">积分从高到低</option>
          <option value="balance_asc">积分从低到高</option>
        </select>
      </label>
      <label class="field">
        <span class="lbl">显示范围</span>
        <select v-model="roleFilter" class="sel">
          <option value="all">全部</option>
          <option value="captain">仅队长（4 队：紫/绿/蓝/粉，每行一队）</option>
          <option value="member">仅非队长（第 {{ CAPTAIN_COUNT + 1 }} 人及之后）</option>
        </select>
      </label>
      <span v-if="roleFilter === 'captain'" class="count muted">
        队长共 {{ captainShownCount }} 人 · 分 {{ TEAM_COUNT }} 队（每队最多 {{ TEAM_SIZE }} 人）
      </span>
      <span v-else class="count muted">当前展示 {{ displayCards.length }} 人</span>
    </div>
    <p v-if="err" class="err">{{ err }}</p>

    <!-- 仅队长：每行一队，紫 / 绿 / 蓝 / 粉 -->
    <div v-if="roleFilter === 'captain'" class="team-rows">
      <div
        v-for="team in captainTeamRows"
        :key="team.label"
        class="team-row"
        :style="{ '--team-accent': team.accent }"
      >
        <div class="team-head">{{ team.label }}队</div>
        <div class="team-grid">
          <button
            v-for="c in team.members"
            :key="String(c.id)"
            type="button"
            class="tile team-tile"
            @click="openCard(c.id)"
          >
            <div class="thumb">
              <img v-if="c.avatar" class="cover" :src="String(c.avatar)" alt="" />
              <div v-else class="cover ph" />
              <div class="thumb-reactions">
                <MemberLikeButton :member-id="c.id" variant="tile" />
                <MemberDislikeButton :member-id="c.id" variant="tile" />
              </div>
            </div>
            <div class="cap">
              <div class="nm">{{ c.name }}</div>
              <div class="bal">余额 {{ (c.balance ?? 0).toLocaleString() }}</div>
            </div>
          </button>
        </div>
      </div>
    </div>

    <div v-else class="grid-wrap">
      <div class="grid">
        <button
          v-for="c in displayCards"
          :key="String(c.id)"
          type="button"
          class="tile"
          @click="openCard(c.id)"
        >
          <div class="thumb">
            <img v-if="c.avatar" class="cover" :src="String(c.avatar)" alt="" />
            <div v-else class="cover ph" />
            <div class="thumb-reactions">
              <MemberLikeButton :member-id="c.id" variant="tile" />
              <MemberDislikeButton :member-id="c.id" variant="tile" />
            </div>
          </div>
          <div class="cap">
            <div class="nm">
              {{ c.name }}
              <span v-if="c._orderIndex < CAPTAIN_COUNT" class="badge">队长</span>
            </div>
            <div class="bal">余额 {{ (c.balance ?? 0).toLocaleString() }}</div>
          </div>
        </button>
      </div>
    </div>
    <p v-if="!loading && !cards.length" class="muted">暂无卡片</p>
    <p
      v-else-if="!loading && cards.length && roleFilter === 'captain' && captainShownCount === 0"
      class="muted"
    >
      暂无队长数据
    </p>
    <p
      v-else-if="!loading && cards.length && roleFilter !== 'captain' && !displayCards.length"
      class="muted"
    >
      当前筛选下没有成员
    </p>

    <Teleport to="body">
      <div v-if="dlg" class="mask" @click.self="closeDlg">
        <div class="dialog">
          <button type="button" class="x" aria-label="关闭" @click="closeDlg">×</button>
          <template v-if="detail">
            <div class="top">
              <div class="top-av">
                <img v-if="detail.avatar" class="big" :src="String(detail.avatar)" alt="" />
                <div class="dlg-reactions">
                  <MemberLikeButton :member-id="detail.id" variant="tile" />
                  <MemberDislikeButton :member-id="detail.id" variant="tile" />
                </div>
              </div>
              <div>
                <h3>{{ detail.name }}</h3>
                <p class="bal2">当前余额：{{ (detail.balance ?? 0).toLocaleString() }}</p>
              </div>
            </div>
            <h4>积分来源 / 流水</h4>
            <p v-if="recLoading" class="muted">加载流水…</p>
            <table v-else class="rec">
              <thead>
                <tr>
                  <th>时间</th>
                  <th class="col-src">来源（解析）</th>
                  <th>内容</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(h, i) in records" :key="i">
                  <td class="t">{{ h.creationDateTime }}</td>
                  <td class="src" :title="h.sourceLabel">{{ h.sourceLabel }}</td>
                  <td>{{ h.content }}</td>
                </tr>
              </tbody>
            </table>
            <div v-if="Math.ceil(recTotal / recSize) > 1" class="pager">
              <button
                type="button"
                :disabled="recPage <= 1"
                @click="recPage--; loadRecords()"
              >
                上一页
              </button>
              <span>{{ recPage }} / {{ Math.ceil(recTotal / recSize) }}</span>
              <button
                type="button"
                :disabled="recPage >= Math.ceil(recTotal / recSize)"
                @click="recPage++; loadRecords()"
              >
                下一页
              </button>
            </div>
          </template>
          <p v-else class="muted">加载中…</p>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.panel {
  padding: 1rem 1.25rem 2rem;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 1rem 1.5rem;
  margin-top: 0.75rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid var(--border);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.lbl {
  font-size: 0.75rem;
  color: var(--muted);
}
.sel {
  min-width: 220px;
  padding: 0.4rem 0.6rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
}
.count {
  font-size: 0.85rem;
  align-self: center;
}
.badge {
  margin-left: 0.35rem;
  font-size: 0.65rem;
  font-weight: 700;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  background: var(--primary);
  color: var(--on-primary);
  vertical-align: middle;
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
.team-rows {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  margin-top: 1rem;
}
.team-row {
  border-radius: 14px;
  padding: 0.75rem 1rem 1rem;
  border: 2px solid var(--team-accent, var(--border));
  background: color-mix(in srgb, var(--team-accent) 12%, var(--surface));
  /* 每行固定 4 列且单列不小于 160px（与 .grid-wrap/.grid 一致），窄屏横向滚动而非改行数 */
  overflow-x: auto;
}
.team-head {
  font-weight: 800;
  font-size: 1.05rem;
  margin-bottom: 0.65rem;
  color: var(--team-accent);
  letter-spacing: 0.08em;
}
.team-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(160px, 1fr));
  gap: 1rem;
  /* 保证每列至少 160px，整行最窄约 4 卡 + 间距，避免被压成少于 4 列 */
  min-width: calc(4 * 160px + 3 * 1rem);
}
.grid-wrap {
  overflow-x: auto;
  margin-top: 1rem;
}
.grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(160px, 1fr));
  gap: 1rem;
  min-width: calc(4 * 160px + 3 * 1rem);
}
.tile {
  position: relative;
  padding: 0;
  border: 2px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  background: var(--surface);
  color: inherit;
  text-align: left;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: fit-content;
  max-width: 100%;
  /* 按内容高度排版，不拉满整列；图片区由 .thumb 随图收缩 */
  align-self: start;
  justify-self: start;
}
.thumb {
  position: relative;
  flex: 0 0 auto;
  width: fit-content;
  max-width: 100%;
  line-height: 0;
}
.top-av {
  position: relative;
  flex-shrink: 0;
  display: inline-block;
  line-height: 0;
}
.thumb-reactions {
  position: absolute;
  right: 6px;
  bottom: 6px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.dlg-reactions {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.tile.team-tile {
  border-color: color-mix(in srgb, var(--team-accent) 55%, var(--border));
}
.cover {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
}
.cover.ph {
  background: color-mix(in srgb, var(--muted) 30%, var(--surface));
  width: 120px;
  min-height: 120px;
}
.cap {
  align-self: stretch;
  box-sizing: border-box;
  padding: 0.5rem 0.65rem;
  /* 随主题：浅色用 surface/bg 混合，不再固定黑半透明 */
  background: color-mix(in srgb, var(--surface) 88%, var(--text) 10%);
  color: var(--text);
  min-width: 0;
  word-break: break-word;
}
.nm {
  font-weight: 700;
  font-size: 0.9rem;
  color: var(--text);
}
.bal {
  font-size: 0.8rem;
  color: var(--muted);
}
.err {
  color: var(--danger);
}
.muted {
  color: var(--muted);
}
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 1rem;
}
.dialog {
  position: relative;
  max-width: 720px;
  width: 100%;
  max-height: 90vh;
  overflow: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 1.25rem 1.5rem;
}
.x {
  position: absolute;
  right: 0.75rem;
  top: 0.5rem;
  font-size: 1.5rem;
  line-height: 1;
  border: none;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.top {
  display: flex;
  gap: 1rem;
  align-items: center;
  margin-bottom: 1rem;
}
.big {
  display: block;
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: min(60vh, 900px);
  border-radius: 12px;
  flex-shrink: 0;
}
.bal2 {
  color: var(--accent);
  font-weight: 600;
}
.rec {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.rec th,
.rec td {
  border: 1px solid var(--border);
  padding: 0.4rem 0.5rem;
  vertical-align: top;
}
.rec .t {
  white-space: nowrap;
  color: var(--muted);
}
.rec th.col-src,
.rec td.src {
  max-width: 10rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--accent);
  font-weight: 600;
}
.pager {
  margin-top: 0.75rem;
  display: flex;
  justify-content: center;
  gap: 1rem;
  align-items: center;
}
.pager button {
  padding: 0.3rem 0.75rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
}
</style>
