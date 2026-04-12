<script setup lang="ts">
import { inject, onMounted, ref, watch } from "vue";
import { createApi, douyuAvatarUrl } from "../lib/api";
import type { ClientConfig } from "../lib/api";
import type { ApiListResponse, LiveUser } from "../types";
import MemberLikeButton from "./MemberLikeButton.vue";
import { FMZ_TREASURY_AVATAR_KEY } from "../lib/treasuryAvatarOpen";

const props = defineProps<{ config: ClientConfig }>();

const treasuryAvatar = inject(FMZ_TREASURY_AVATAR_KEY);

const q = ref("");
const page = ref(1);
const size = ref(16);
const total = ref(0);
const list = ref<LiveUser[]>([]);
const loading = ref(false);
const err = ref("");

async function fetchList() {
  loading.value = true;
  err.value = "";
  try {
    const api = createApi(props.config);
    const body: Record<string, unknown> = {
      page: page.value,
      size: size.value,
      sort: [
        { content: "pointsNum2", condition: "DESC" },
        { content: "id", condition: "DESC" },
      ],
    };
    if (q.value.trim()) {
      body.search = [
        {
          condition: "LIKE",
          key: "name",
          relationship: "AND",
          type: "CONDITION",
          value: "%" + q.value.trim() + "%",
        },
      ];
    }
    const res = (await api.liveUserList(body)) as ApiListResponse<LiveUser>;
    if (res.code !== 0 || !res.data) {
      err.value = "加载失败（检查 Token 与网络）";
      list.value = [];
      return;
    }
    page.value = res.data.page ?? page.value;
    total.value = res.data.total ?? 0;
    const prop = props.config.currencyProportion || 100;
    list.value = (res.data.list || []).map((d) => ({
      ...d,
      avatar: douyuAvatarUrl(d.avatar as string | undefined),
      pointsNum2: Number(d.pointsNum2 || 0) / prop,
    }));
  } catch (e: unknown) {
    err.value = e instanceof Error ? e.message : String(e);
    list.value = [];
  } finally {
    loading.value = false;
  }
}

function onSearch() {
  page.value = 1;
  fetchList();
}

watch(
  () => props.config,
  () => {
    page.value = 1;
    fetchList();
  },
  { deep: true },
);

onMounted(() => fetchList());

/** 与 IndexedDB 中计数用的成员主键一致（优先 id，否则 uid） */
function memberReactionKey(u: LiveUser): string | number | null {
  if (u.id != null && String(u.id).trim() !== "") return u.id;
  const uid = u.uid != null ? String(u.uid).trim() : "";
  if (uid) return uid;
  return null;
}

function cardWatermarkStyle(avatar: string | undefined): Record<string, string> {
  const a = avatar?.trim();
  if (!a) return {};
  return { backgroundImage: `url(${JSON.stringify(a)})` };
}

function onUserAvatarClick(u: LiveUser) {
  treasuryAvatar?.openIfMember(u.id ?? u.uid);
}

defineExpose({ reload: fetchList });
</script>

<template>
  <section class="panel">
    <div class="head">
      <h2>用户伐木积分</h2>
      <div class="search">
        <input
          v-model="q"
          placeholder="搜索用户名，回车查询"
          @keydown.enter="onSearch"
        />
        <button type="button" class="primary" :disabled="loading" @click="onSearch">搜索</button>
        <button type="button" class="ghost" :disabled="loading" @click="q = ''; onSearch()">清除</button>
      </div>
    </div>
    <p v-if="err" class="err">{{ err }}</p>
    <p v-if="loading" class="muted">加载中…</p>
    <div v-else class="cards">
      <article v-for="u in list" :key="String(u.id ?? u.uid)" class="card">
        <div
          v-if="u.avatar"
          class="card-watermark"
          aria-hidden="true"
          :style="cardWatermarkStyle(u.avatar)"
        />
        <img
          class="av av--treasury-hit"
          :src="u.avatar || undefined"
          alt=""
          referrerpolicy="no-referrer"
          title="金库成员：点击查看余额与流水"
          @click.stop="onUserAvatarClick(u)"
        />
        <div class="meta">
          <div class="name">{{ u.name }}</div>
          <div class="uid">UID {{ u.uid ?? u.id }}</div>
          <div class="pts">{{ (u.pointsNum2 ?? 0).toLocaleString() }} 伐木积分</div>
          <div v-if="memberReactionKey(u) != null" class="react">
            <MemberLikeButton :member-id="memberReactionKey(u)!" variant="inline" />
          </div>
        </div>
      </article>
    </div>
    <div v-if="!loading && list.length === 0" class="muted empty">暂无数据</div>
    <div v-if="total > size" class="pager">
      <button type="button" :disabled="page <= 1 || loading" @click="page--; fetchList()">上一页</button>
      <span>第 {{ page }} 页 / 共 {{ Math.ceil(total / size) }} 页</span>
      <button
        type="button"
        :disabled="page >= Math.ceil(total / size) || loading"
        @click="page++; fetchList()"
      >
        下一页
      </button>
    </div>
  </section>
</template>

<style scoped>
.panel {
  padding: 1rem 1.25rem 2rem;
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
}
h2 {
  margin: 0;
}
.search {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.search input {
  min-width: 220px;
  padding: 0.45rem 0.75rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
}
button.primary {
  padding: 0.45rem 1rem;
  border-radius: 8px;
  border: none;
  background: var(--primary);
  color: var(--on-primary);
  font-weight: 600;
  cursor: pointer;
}
button.ghost {
  padding: 0.45rem 1rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1rem;
  margin-top: 1rem;
}
.card {
  position: relative;
  display: flex;
  gap: 0.75rem;
  padding: 1rem;
  border-radius: 12px;
  border: 1px solid var(--border);
  overflow: hidden;
  background: linear-gradient(
    145deg,
    color-mix(in srgb, var(--primary) 22%, var(--surface)) 0%,
    var(--surface) 100%
  );
}
.card-watermark {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-repeat: no-repeat;
  background-position: calc(100% + 8px) 50%;
  background-size: clamp(96px, 42%, 168px);
  opacity: 0.2;
  filter: saturate(0.85);
  -webkit-mask-image: linear-gradient(
    to right,
    rgb(0 0 0 / 0) 0%,
    rgb(0 0 0 / 0) 18%,
    rgb(0 0 0 / 0.12) 40%,
    rgb(0 0 0 / 0.38) 62%,
    rgb(0 0 0 / 0.62) 82%,
    rgb(0 0 0 / 0.78) 100%
  );
  mask-image: linear-gradient(
    to right,
    rgb(0 0 0 / 0) 0%,
    rgb(0 0 0 / 0) 18%,
    rgb(0 0 0 / 0.12) 40%,
    rgb(0 0 0 / 0.38) 62%,
    rgb(0 0 0 / 0.62) 82%,
    rgb(0 0 0 / 0.78) 100%
  );
  mask-mode: alpha;
}
.av {
  position: relative;
  z-index: 1;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid color-mix(in srgb, var(--text) 16%, var(--border));
}
.av--treasury-hit {
  cursor: pointer;
}
.meta {
  position: relative;
  z-index: 1;
  min-width: 0;
}
.name {
  font-weight: 700;
  color: var(--text);
}
.uid {
  font-size: 0.75rem;
  color: var(--muted);
}
.pts {
  margin-top: 0.35rem;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.react {
  margin-top: 0.5rem;
}
.err {
  color: var(--danger);
}
.muted {
  color: var(--muted);
}
.empty {
  margin-top: 2rem;
  text-align: center;
}
.pager {
  margin-top: 1.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
}
.pager button {
  padding: 0.35rem 0.85rem;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}
</style>
