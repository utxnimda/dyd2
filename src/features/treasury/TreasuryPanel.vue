<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { createApi } from "../../shared/api";
import type { ClientConfig } from "../../shared/api";
import { enrichMissingAvatarsFromDoseeing } from "../battle/doseeingAvatar";
import {
  CAPTAIN_COUNT,
  captainTeamsFromCards,
  hudBottomTeam,
  hudOtherMembers,
  normalizeMoneyList,
  TEAM_DEFS,
  type CaptainMoneyCard,
} from "../battle/captainTeams";
import { extractRecordSourceLabel } from "../battle/recordSource";
import { formatRecordContent } from "./treasuryFormat";
import type { ApiListResponse, MoneyCard, MoneyRecord } from "../../shared/types";

/** 流水行：展示用 content 已格式化，sourceLabel 自原始记录解析 */
type TreasuryRecordRow = MoneyRecord & { sourceLabel: string };
import MemberDislikeButton from "../../components/MemberDislikeButton.vue";
import MemberLikeButton from "../../components/MemberLikeButton.vue";
type TreasuryCard = CaptainMoneyCard;

const props = defineProps<{ config: ClientConfig }>();

const cards = ref<TreasuryCard[]>([]);

/** 排序：原列表顺序 | 积分高→低 | 积分低→高 */
const sortMode = ref<"original" | "balance_desc" | "balance_asc">("original");
/** 筛选：多选并集；仅勾选「队长」且未勾选其余两项时走四阵营分行布局 */
const filterCaptain = ref(true);
const filterPreliminary = ref(true);
const filterOther = ref(true);

const hasAnyFilter = computed(
  () => filterCaptain.value || filterPreliminary.value || filterOther.value,
);

const showCaptainTeamRows = computed(
  () =>
    filterCaptain.value && !filterPreliminary.value && !filterOther.value,
);

const preliminaryMemberIds = computed(() =>
  new Set(hudBottomTeam(cards.value).map((c) => String(c.id))),
);

/** 仅队长模式：每行一阵营（A/B/C/D），阵营内顺序可随积分排序变化 */
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
  if (showCaptainTeamRows.value) return [];
  if (!hasAnyFilter.value) return [];

  const src = cards.value;
  const parts: TreasuryCard[] = [];
  if (filterCaptain.value) {
    parts.push(...src.filter((c) => c._orderIndex < CAPTAIN_COUNT));
  }
  if (filterPreliminary.value) {
    parts.push(...hudBottomTeam(src));
  }
  if (filterOther.value) {
    parts.push(...hudOtherMembers(src));
  }

  const list = [...parts];
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
/** 单页条数略大，减少「前几日流水被挤到后面几页」时的翻页次数 */
const recSize = ref(64);
const recTotal = ref(0);
const recLoading = ref(false);
/** 与 CaptainCornersHud.fetchLatestRecord 一致：id 降序 = 新记录在前；升序便于从第 1 页找早期日期 */
const recSortOrder = ref<"desc" | "asc">("desc");

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
  recSortOrder.value = "desc";
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
      sort: [
        {
          content: "id",
          condition: recSortOrder.value === "desc" ? "DESC" : "ASC",
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

function isTreasuryMember(id: string | number | null | undefined): boolean {
  if (id == null || String(id).trim() === "") return false;
  const s = String(id);
  return cards.value.some((c) => String(c.id) === s);
}

function onRecSortChange() {
  recPage.value = 1;
  void loadRecords();
}

watch(
  () => props.config,
  () => loadCards(),
  { deep: true },
);

onMounted(() => loadCards());

defineExpose({ reload: loadCards, openCard, isTreasuryMember, closeDlg });
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
      <div class="field">
        <select v-model="sortMode" class="sel" aria-label="排序">
          <option value="original">默认排序</option>
          <option value="balance_desc">积分从高到低</option>
          <option value="balance_asc">积分从低到高</option>
        </select>
      </div>
      <div class="field filter-field">
        <div class="filter-checks" role="group" aria-label="成员筛选">
          <label class="chk">
            <input v-model="filterCaptain" type="checkbox" />
            队长
          </label>
          <label class="chk">
            <input v-model="filterPreliminary" type="checkbox" />
            预赛人员
          </label>
          <label class="chk">
            <input v-model="filterOther" type="checkbox" />
            其他
          </label>
        </div>
      </div>
    </div>
    <p v-if="err" class="err">{{ err }}</p>

    <!-- 仅队长：每行一阵营 A–D -->
    <div v-if="showCaptainTeamRows" class="team-rows">
      <div
        v-for="team in captainTeamRows"
        :key="team.label"
        class="team-row"
        :style="{ '--team-accent': team.accent }"
      >
        <div class="team-head">{{ team.label }} 阵营</div>
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

    <div v-else class="grid-wrap grid-wrap--mixed">
      <div class="grid-mixed">
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
              <span v-else-if="preliminaryMemberIds.has(String(c.id))" class="badge badge-pre">预赛</span>
              <span v-else class="badge badge-oth">其他</span>
            </div>
            <div class="bal">余额 {{ (c.balance ?? 0).toLocaleString() }}</div>
          </div>
        </button>
      </div>
    </div>
    <p v-if="!loading && !cards.length" class="muted">暂无卡片</p>
    <p
      v-else-if="!loading && cards.length && showCaptainTeamRows && captainShownCount === 0"
      class="muted"
    >
      暂无队长数据
    </p>
    <p v-else-if="!loading && cards.length && !hasAnyFilter" class="muted">
      请至少勾选一项筛选
    </p>
    <p
      v-else-if="!loading && cards.length && hasAnyFilter && !showCaptainTeamRows && !displayCards.length"
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
            <p class="rec-meta muted">
              与接口约定一致按记录 <code>id</code> 排序：默认<strong>最新在前</strong>时，今天（如 4.12）的新流水会出现在第 1 页；前几日记录在同一排序下会排在后面，请用翻页查看，或改为「最旧在前」从第 1 页起浏览早期日期。共
              {{ recTotal }} 条，每页 {{ recSize }} 条。
            </p>
            <div class="rec-tools">
              <label class="rec-sort">
                排序
                <select v-model="recSortOrder" class="sel" @change="onRecSortChange">
                  <option value="desc">最新在前（id 降序）</option>
                  <option value="asc">最旧在前（id 升序）</option>
                </select>
              </label>
            </div>
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
.rec-meta {
  font-size: 0.78rem;
  line-height: 1.45;
  margin: 0 0 0.5rem;
  max-width: 52rem;
}
.rec-meta code {
  font-size: 0.85em;
}
.rec-tools {
  margin-bottom: 0.5rem;
}
.rec-sort {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: var(--muted);
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
  align-items: center;
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
  box-sizing: border-box;
  min-width: 220px;
  min-height: 1.75rem;
  padding: 0 0.65rem;
  font-size: 0.9rem;
  line-height: 1.75rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
}
.filter-field {
  min-width: 0;
}
.filter-checks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.65rem 1rem;
}
.chk {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-height: 1.75rem;
  font-size: 0.9rem;
  color: var(--text);
  cursor: pointer;
  user-select: none;
}
.chk input {
  accent-color: var(--primary);
  width: 1rem;
  height: 1rem;
  cursor: pointer;
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
.badge-pre {
  background: color-mix(in srgb, var(--accent) 35%, var(--surface));
  color: color-mix(in srgb, var(--accent) 88%, var(--text));
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
}
.badge-oth {
  background: color-mix(in srgb, var(--muted) 28%, var(--surface));
  color: var(--muted);
  border: 1px solid var(--border);
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
  /* 每行固定 4 列且单列不小于 160px；仅队长模式专用，窄屏横向滚动 */
  overflow-x: auto;
}
.team-head {
  font-weight: 800;
  font-size: 1.05rem;
  margin-bottom: 0.65rem;
  color: var(--team-accent);
  letter-spacing: 0.08em;
}
/* 仅「只选队长」：每阵营独占一行，行内固定 4 列，不同阵营不会出现在同一行 */
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
/* 混合筛选：不按阵营分行，用自适应列宽与统一间距即可 */
.grid-wrap--mixed {
  overflow-x: visible;
}
.grid-mixed {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 1.15rem;
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
