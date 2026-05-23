/**
 * 用服务端「当前时刻」校准客户端时钟（仅修正本地时间偏差）。
 * 注意：必须用 API/SSE 返回的 serverNow，不能用 live.updatedAt（那是消息入库时刻，刷新会重置倒计时）。
 */
let serverOffsetMs = 0;
let hasOffset = false;

/** 收到 serverNow / ts 时调用（毫秒时间戳） */
export function syncDreamBusServerClock(serverNowMs: number): void {
  if (!Number.isFinite(serverNowMs) || serverNowMs <= 0) return;
  const sample = serverNowMs - Date.now();
  serverOffsetMs = hasOffset ? serverOffsetMs * 0.7 + sample * 0.3 : sample;
  hasOffset = true;
}

/** 经服务端校准后的「当前毫秒」；未校准时等同 Date.now() */
export function dreamBusNowMs(): number {
  return Date.now() + (hasOffset ? serverOffsetMs : 0);
}

export function dreamBusServerOffsetMs(): number {
  return hasOffset ? serverOffsetMs : 0;
}
