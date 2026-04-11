export type ListCondition = {
  key: string;
  value: string;
  condition: string;
  relationship: string;
  type: string;
};

export type ListSort = {
  content: string;
  condition: string;
};

export type ListRequest = {
  page: number;
  size: number;
  search?: ListCondition[];
  sort: ListSort[];
};

export type ApiListResponse<T> = {
  code: number;
  data?: {
    list: T[];
    page?: number;
    total?: number;
  };
};

export type MoneyCard = {
  id: number | string;
  name?: string;
  avatar?: string;
  balance?: number;
  card?: string;
  attribute?: string;
  enable?: string | number;
  [k: string]: unknown;
};

export type MoneyRecord = {
  creationDateTime?: string;
  content?: string;
  type?: string;
  [k: string]: unknown;
};

export type LiveUser = {
  id?: number | string;
  uid?: string;
  name?: string;
  avatar?: string;
  pointsNum2?: number;
  [k: string]: unknown;
};

/** 与官方「预赛能力值」表一致的一行（gf 为伐木值积分，由累计伐木值排名推导） */
export type PreliminaryAbilityRow = {
  id: string | number;
  name: string;
  flow: number;
  g1: number;
  g2: number;
  g3: number;
  g4: number;
  g5: number;
  g6: number;
  g7: number;
  g8: number;
  g9: number;
  gf: number;
  total: number;
  raw: MoneyCard;
};

export type PreliminaryDateRank = {
  date: string;
  list: Array<MoneyCard & { value: number }>;
};
