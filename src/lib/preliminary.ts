import type { MoneyCard, PreliminaryAbilityRow, PreliminaryDateRank } from "../types";

function num(v: string | number | undefined, fallback = 0): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (v === "-") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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
    return { abilityRows: [], dateRanks: [], error: "拉取 KV 失败" };
  }

  const rawPrelim = kvRes.data["system.preliminary.data"];
  const d: { url: string; date: string }[] = [];
  try {
    d.push(...JSON.parse(rawPrelim || "[]"));
  } catch {
    /* ignore */
  }

  for (const m of d) {
    const h = m.url;
    const y = m.date;
    const g = (await opts.proxyGet(h)) as {
      code: number;
      data?: string;
    };
    if (g.code !== 0 || !g.data) continue;
    try {
      const p = JSON.parse(g.data) as {
        error?: number;
        data?: { list: Array<{ rid: string | number; sc: string | number }> };
      };
      if (!p || p.error !== 0 || !p.data?.list) continue;
      const S: Array<MoneyCard & { value: number }> = [];
      for (const w of p.data.list) {
        for (let C = 0; C < s.length; C++) {
          const P = parseAttr(s[C]);
          if (P && Number(P.preliminary) === 1 && String(P.rid) === String(w.rid)) {
            s[C].flow = String(num(s[C].flow) + Number(w.sc) / 100);
            S.push({ ...s[C], value: Number(w.sc) / 100 });
            break;
          }
        }
      }
      S.sort((a, b) => Number(b.value) - Number(a.value));
      dateRanks.push({ date: y, list: S });
    } catch {
      /* ignore */
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

  return { abilityRows, dateRanks };
}

export function withRank<T>(rows: T[], score: (row: T) => number): Array<T & { rank: number }> {
  const sorted = [...rows].sort((a, b) => score(b) - score(a));
  return sorted.map((row, i) => ({ ...row, rank: i + 1 }));
}

export function gameSum(row: PreliminaryAbilityRow): number {
  return row.g1 + row.g2 + row.g3 + row.g4 + row.g5 + row.g6 + row.g7 + row.g8 + row.g9;
}
