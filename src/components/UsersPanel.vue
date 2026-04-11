<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { createApi, douyuAvatarUrl } from "../lib/api";
import type { ClientConfig } from "../lib/api";
import type { ApiListResponse, LiveUser } from "../types";

const props = defineProps<{ config: ClientConfig }>();

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
      <article v-for="u in list" :key="String(u.id)" class="card">
        <img class="av" :src="u.avatar || undefined" alt="" referrerpolicy="no-referrer" />
        <div class="meta">
          <div class="name">{{ u.name }}</div>
          <div class="uid">UID {{ u.uid ?? u.id }}</div>
          <div class="pts">{{ (u.pointsNum2 ?? 0).toLocaleString() }} 伐木积分</div>
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
  color: #0a1628;
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
  display: flex;
  gap: 0.75rem;
  padding: 1rem;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: linear-gradient(145deg, #1e3a5f 0%, var(--surface) 100%);
}
.av {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid rgba(255, 255, 255, 0.2);
}
.name {
  font-weight: 700;
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
