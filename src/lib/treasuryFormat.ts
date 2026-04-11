import type { MoneyRecord } from "../types";

/** 与站点 TreasuryDetail 展示文案尽量一致 */
export function formatRecordContent(h: MoneyRecord): string {
  let y: string | undefined;
  const type = h.type;
  const content = String(h.content ?? "");

  if (type === "CONSUMPTION") {
    try {
      y = JSON.parse(content).content as string;
    } catch {
      y = content;
    }
    const g = y.split("消费");
    if (g.length > 1) y = "消费" + g[1];
    return y ?? "";
  }
  if (type === "EXPLODE") return content + "伐木积分";
  if (type === "RECHARGE") return content + "伐木积分";
  if (type === "EAT_MEAL") {
    return content
      .replace("]吃", "]快去吃")
      .replace("1500", "超火餐")
      .replace("500", "火箭餐")
      .replace("2000", "超火餐");
  }
  if (type === "NOT_EAT_MEAL") {
    return content
      .replace("]别吃", "]别吃了")
      .replace("500", "火箭餐")
      .replace("2000", "超火餐");
  }
  return content;
}
