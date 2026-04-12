import type {
  KvPreliminaryDayEntry,
  MoneyCard,
  PreliminaryAbilityRow,
  PreliminaryDateRank,
  PreliminaryFetchWarning,
} from "../types";

function num(v: string | number | undefined, fallback = 0): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (v === "-") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 官网 proxy.execute 的 data 多为 JSON 字符串；兼容上游已解析为对象的情况 */
function parseProxyPayload(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 与官网 PreliminaryData 一致：对 proxy 返回的 `data` 做 JSON.parse 得到 `{ error, data: { list } }`。
 * 兼容：双重字符串、或 `data` 字段本身是 JSON 字符串（网关再包一层）。
 */
function parsePreliminaryRankBody(raw: unknown): {
  error?: number;
  data?: { list?: Array<{ rid: string | number; sc: string | number }> };
} | null {
  let p: unknown = parseProxyPayload(raw);
  if (p == null) return null;
  if (typeof p === "string") {
    try {
      p = JSON.parse(p);
    } catch {
      return null;
    }
  }
  if (typeof p === "string") {
    try {
      p = JSON.parse(p);
    } catch {
      return null;
    }
  }
  if (p == null || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  if (typeof o.data === "string") {
    try {
      const inner = JSON.parse(o.data) as Record<string, unknown>;
      if (inner && typeof inner === "object") {
        if ("list" in inner) {
          return {
            error: Number(o.error ?? 0),
            data: inner as { list: Array<{ rid: string | number; sc: string | number }> },
          };
        }
        const nested = inner.data;
        if (nested && typeof nested === "object" && "list" in (nested as object)) {
          return {
            error: Number(o.error ?? 0),
            data: nested as { list: Array<{ rid: string | number; sc: string | number }> },
          };
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (Array.isArray(o.list)) {
    return {
      error: Number(o.error ?? 0),
      data: {
        list: o.list as Array<{ rid: string | number; sc: string | number }>,
      },
    };
  }
  return p as {
    error?: number;
    data?: { list?: Array<{ rid: string | number; sc: string | number }> };
    list?: Array<{ rid: string | number; sc: string | number }>;
  };
}

/** 仅当 error 显式非 0 时失败；缺省 error 但有 list 时仍视为成功（避免 undefined !== 0 误判） */
function extractRankListFromParsed(parsed: {
  error?: number;
  data?: { list?: unknown };
  list?: unknown;
} | null): Array<Record<string, unknown>> | null {
  if (!parsed) return null;
  if (parsed.error !== undefined && parsed.error !== 0) return null;
  if (Array.isArray(parsed.data?.list)) {
    return parsed.data!.list as Array<Record<string, unknown>>;
  }
  if (Array.isArray(parsed.list)) {
    return parsed.list as Array<Record<string, unknown>>;
  }
  const d = (parsed as { data?: unknown }).data;
  if (Array.isArray(d)) {
    return d as Array<Record<string, unknown>>;
  }
  return null;
}

function rankRowRid(w: Record<string, unknown>): string | number | undefined {
  if (w.rid != null) return w.rid as string | number;
  if (w.id != null) return w.id as string | number;
  if (w.uid != null) return w.uid as string | number;
  return undefined;
}

function rankRowSc(w: Record<string, unknown>): number {
  const v = w.sc ?? w.score ?? w.value;
  if (v === undefined || v === null) return NaN;
  return Number(v);
}

/** 规范化 KV 单日项；date 可能为 2026-04-11 等；部分日 url 为空、榜单在 content */
function normalizeKvPreliminaryDay(m: unknown): KvPreliminaryDayEntry {
  if (!m || typeof m !== "object") return { date: "", url: "" };
  const o = m as Record<string, unknown>;
  const date = String(o.date ?? o.day ?? "").trim();
  const url = String(o.url ?? o.href ?? "").trim();
  const content = String(o.content ?? "").trim();
  const out: KvPreliminaryDayEntry = { date, url };
  if (content.length > 0) out.content = content;
  return out;
}

/**
 * keyvalue 的 system.preliminary.data 可能是带首尾空格、或双重 JSON 字符串、或单对象。
 */
function safeParsePreliminaryKv(raw: string | undefined): {
  entries: KvPreliminaryDayEntry[];
  parseFailed: boolean;
} {
  if (raw == null) return { entries: [], parseFailed: false };
  const t = String(raw).trim();
  if (t === "") return { entries: [], parseFailed: false };

  const tryArray = (a: unknown): KvPreliminaryDayEntry[] => {
    let arr: unknown = a;
    if (arr == null) return [];
    if (!Array.isArray(arr)) {
      if (typeof arr === "object") {
        const o = arr as Record<string, unknown>;
        if (Array.isArray(o.list)) {
          arr = o.list;
        } else if ("url" in o || "date" in o || "day" in o) {
          arr = [arr];
        } else {
          return [];
        }
      } else {
        return [];
      }
    }
    return (arr as unknown[])
      .map(normalizeKvPreliminaryDay)
      .filter((e) => e.url.length > 0 || (e.content != null && e.content.length > 0));
  };

  try {
    const first = JSON.parse(t);
    const entries = tryArray(first);
    if (
      entries.length > 0 ||
      Array.isArray(first) ||
      (first && typeof first === "object")
    ) {
      return { entries, parseFailed: false };
    }
  } catch {
    /* continue */
  }

  try {
    const second = JSON.parse(JSON.parse(t) as string);
    const entries = tryArray(second);
    if (entries.length > 0) return { entries, parseFailed: false };
  } catch {
    /* ignore */
  }

  try {
    const first = JSON.parse(t);
    if (typeof first === "string") {
      const inner = JSON.parse(first.trim());
      return { entries: tryArray(inner), parseFailed: false };
    }
  } catch {
    /* ignore */
  }

  return { entries: [], parseFailed: true };
}

function parseAttr(card: MoneyCard): Record<string, unknown> | null {
  if (!card.attribute) return null;
  try {
    return JSON.parse(String(card.attribute)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 复刻站点预赛能力值聚合（见原站 PreliminaryData） */
export async function aggregatePreliminary(opts: {
  moneyList: () => Promise<unknown>;
  kvData: (keys: string[]) => Promise<unknown>;
  proxyGet: (url: string) => Promise<unknown>;
}): Promise<{
  abilityRows: PreliminaryAbilityRow[];
  dateRanks: PreliminaryDateRank[];
  fetchWarnings: PreliminaryFetchWarning[];
  /** KV 里配置的预赛日期列表（与官网同源）；若只有 1 条则只会出现 1 天列 */
  kvPreliminaryEntries: KvPreliminaryDayEntry[];
  /** system.preliminary.data 不是合法 JSON */
  kvPreliminaryParseFailed: boolean;
  error?: string;
}> {
  const listRes = (await opts.moneyList()) as {
    code: number;
    data?: { list: MoneyCard[] };
  };
  if (listRes.code !== 0 || !listRes.data?.list) {
    return {
      abilityRows: [],
      dateRanks: [],
      fetchWarnings: [],
      kvPreliminaryEntries: [],
      kvPreliminaryParseFailed: false,
      error: "拉取金库列表失败或未登录",
    };
  }

  const s: MoneyCard[] = [];
  for (const d of listRes.data.list) {
    const P = parseAttr(d);
    if (P && Number(P.preliminary) === 1) {
      s.push({
        ...d,
        flow: "0",
        total: "0",
        g1: "-",
        g2: "-",
        g3: "-",
        g4: "-",
        g5: "-",
        g6: "-",
        g7: "-",
        g8: "-",
        g9: "-",
        gf: "0",
      });
    }
  }

  const keys = [
    "system.preliminary.data",
    ...Array.from({ length: 9 }, (_, i) => `sys.game.jf.config.g${i + 1}`),
  ];

  const kvRes = (await opts.kvData(keys)) as {
    code: number;
    data?: Record<string, string>;
  };

  const dateRanks: PreliminaryDateRank[] = [];

  if (kvRes.code !== 0 || !kvRes.data) {
    return {
      abilityRows: [],
      dateRanks: [],
      fetchWarnings: [],
      kvPreliminaryEntries: [],
      kvPreliminaryParseFailed: false,
      error: "拉取 KV 失败",
    };
  }

  const rawPrelim = kvRes.data["system.preliminary.data"];
  const parsedKv = safeParsePreliminaryKv(rawPrelim);
  const prelimDays: KvPreliminaryDayEntry[] = parsedKv.entries;
  const kvPreliminaryParseFailed = parsedKv.parseFailed;

  const fetchWarnings: PreliminaryFetchWarning[] = [];

  for (const m of prelimDays) {
    const h = String(m.url ?? "").trim();
    const y = m.date;
    const embedded = String(m.content ?? "").trim();

    let g: { code: number; data?: unknown };
    if (embedded.length > 0) {
      /** 与后台一致：url 为空时直接用 KV 内嵌的榜单 JSON（等同 proxy 返回的 data 字符串） */
      g = { code: 0, data: embedded };
    } else if (h.length > 0) {
      g = (await opts.proxyGet(h)) as {
        code: number;
        data?: unknown;
      };
    } else {
      fetchWarnings.push({
        date: y,
        reason: "无 url 且无 content（KV 未配置可拉取地址或内嵌榜单）",
      });
      continue;
    }

    const dataEmpty =
      g.code === 0 &&
      (g.data === "" ||
        g.data === undefined ||
        g.data === null ||
        (typeof g.data === "string" && g.data.trim() === ""));
    if (g.code !== 0 || dataEmpty) {
      fetchWarnings.push({
        date: y,
        url: h || undefined,
        reason:
          g.code !== 0
            ? `proxy 返回 code=${g.code}`
            : embedded
              ? "内嵌 content 解析前为空（异常）"
              : "proxy 的 data 为空（该日 URL 失效或上游未返回）",
      });
      continue;
    }
    try {
      const parsed = parsePreliminaryRankBody(g.data);
      const list = extractRankListFromParsed(parsed);
      if (!parsed) {
        fetchWarnings.push({
          date: y,
          url: h,
          reason: "榜单解析失败（非 JSON 或空）",
        });
        continue;
      }
      if (parsed.error !== undefined && parsed.error !== 0) {
        fetchWarnings.push({
          date: y,
          url: h,
          reason: `榜单 error=${parsed.error}`,
        });
        continue;
      }
      if (!list) {
        fetchWarnings.push({
          date: y,
          url: h,
          reason: "榜单无 list（已解析 JSON，但未找到 data.list / list / data 数组）",
        });
        continue;
      }
      const S: Array<MoneyCard & { value: number }> = [];
      for (const row of list) {
        const w = row;
        const rid = rankRowRid(w);
        const sc = rankRowSc(w);
        if (rid === undefined || !Number.isFinite(sc)) continue;
        for (let C = 0; C < s.length; C++) {
          const P = parseAttr(s[C]);
          if (P && Number(P.preliminary) === 1 && String(P.rid) === String(rid)) {
            s[C].flow = String(num(s[C].flow) + sc / 100);
            S.push({ ...s[C], value: sc / 100 });
            break;
          }
        }
      }
      S.sort((a, b) => Number(b.value) - Number(a.value));
      dateRanks.push({ date: y, list: S });
    } catch {
      fetchWarnings.push({ date: y, url: h, reason: "解析榜单 JSON 失败" });
    }
  }

  for (let gi = 1; gi <= 9; gi++) {
    try {
      const h = kvRes.data[`sys.game.jf.config.g${gi}`];
      const parsed = JSON.parse(h || "{}") as {
        list?: Array<{ rid: string | number; data: string | number }>;
      };
      parsed.list?.forEach((p) => {
        for (let S = 0; S < s.length; S++) {
          const w = parseAttr(s[S]);
          if (w && Number(w.preliminary) === 1 && String(w.rid) === String(p.rid)) {
            (s[S] as Record<string, unknown>)[`g${gi}`] = String(Number(p.data));
            break;
          }
        }
      });
    } catch {
      /* ignore */
    }
  }

  s.sort((a, b) => num(b.flow) - num(a.flow));
  for (let m = s.length - 1; m >= 0; m--) {
    s[m].gf = String(48 - m);
    const sumG =
      num(s[m].g1) +
      num(s[m].g2) +
      num(s[m].g3) +
      num(s[m].g4) +
      num(s[m].g5) +
      num(s[m].g6) +
      num(s[m].g7) +
      num(s[m].g8) +
      num(s[m].g9);
    s[m].total = String(sumG + num(s[m].gf));
  }
  s.sort((a, b) => num(b.total) - num(a.total));

  const abilityRows: PreliminaryAbilityRow[] = s.map((row) => ({
    id: row.id as string | number,
    name: String(row.name ?? ""),
    flow: num(row.flow),
    g1: num(row.g1),
    g2: num(row.g2),
    g3: num(row.g3),
    g4: num(row.g4),
    g5: num(row.g5),
    g6: num(row.g6),
    g7: num(row.g7),
    g8: num(row.g8),
    g9: num(row.g9),
    gf: num(row.gf),
    total: num(row.total),
    raw: row,
  }));

  return {
    abilityRows,
    dateRanks,
    fetchWarnings,
    kvPreliminaryEntries: prelimDays,
    kvPreliminaryParseFailed,
  };
}

export function withRank<T>(rows: T[], score: (row: T) => number): Array<T & { rank: number }> {
  const sorted = [...rows].sort((a, b) => score(b) - score(a));
  return sorted.map((row, i) => ({ ...row, rank: i + 1 }));
}

export function gameSum(row: PreliminaryAbilityRow): number {
  return row.g1 + row.g2 + row.g3 + row.g4 + row.g5 + row.g6 + row.g7 + row.g8 + row.g9;
}
