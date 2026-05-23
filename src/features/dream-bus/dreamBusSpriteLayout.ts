/** 起点站牌（路线区左侧下方） */
export const DREAM_BUS_START_STATION = {
  width: "108px",
} as const;

/** 巴士在路线区定位（用于站牌底与轮胎线对齐） */
export const DREAM_BUS_ROUTE_LAYOUT = {
  busWrapTopPx: 54,
  busWrapWidthPx: 118,
  /** bus-body3.png（源图 bus3.png）高/宽 */
  busAspect: 751 / 1206,
  /** 轮胎中心线相对巴士图高度（自顶向下） */
  busWheelFromTopRatio: 0.93,
  stationWidthPx: 108,
} as const;

export function dreamBusStationTopPx(mobileGrid = false): number {
  if (mobileGrid) return DREAM_BUS_MOBILE_BOARD_TOP_PX;
  const L = DREAM_BUS_ROUTE_LAYOUT;
  const busH = L.busWrapWidthPx * L.busAspect;
  const wheelY = L.busWrapTopPx + busH * L.busWheelFromTopRatio;
  return wheelY - L.stationWidthPx;
}

/** 路线区首站图标 + label 胶囊横向占位（与 route preset maxWidth 一致） */
export const DREAM_BUS_ROUTE_STOP_WIDTH_PX = 72;

/** 桌面路线参考宽度：单行布局站点水平比例按此计算 */
export const DREAM_BUS_ROUTE_REF_WIDTH_PX = 680;

/** 多行布局列间距（已废弃，保留兼容） */
export const DREAM_BUS_WRAP_COL_GAP_PX = 8;

/** 站点中心最小间距：大于此可单行/满行均分；未满行按此紧凑衔接 */
export const DREAM_BUS_MIN_STATION_CENTER_GAP_PX = 60;

/** 车尾与站牌右缘的间距 */
export const DREAM_BUS_BOARD_TAIL_GAP_PX = -6;
/** 站牌右缘到首站左缘：略大于一个车宽（额外空隙） */
export const DREAM_BUS_BOARD_TO_FIRST_EXTRA_PX = 4;

/** 手机端：固定每行 3 站，共 4 行 */
export const DREAM_BUS_MOBILE_ROW_STEP_PX = 82;
export const DREAM_BUS_MOBILE_LINE_BELOW_ROW_PX = 48;
export const DREAM_BUS_MOBILE_BOARD_TOP_PX = 8;
export const DREAM_BUS_MOBILE_STATIONS_PER_ROW = 3;
export const DREAM_BUS_MOBILE_ICON_PX = 40;
export const DREAM_BUS_MOBILE_LABEL_MAX_PX = 52;
/** 手机端站牌左缘距路线区左边界（尽量贴左，给右侧 3 列留宽） */
export const DREAM_BUS_MOBILE_BOARD_LEFT_MARGIN_PX = 0;
/** 手机端站牌宽度 */
export const DREAM_BUS_MOBILE_BOARD_WIDTH_PX = 72;
/** 手机端巴士占位宽 */
export const DREAM_BUS_MOBILE_BUS_WIDTH_PX = 76;
/** 手机端：站牌右缘到首站中心，约为半车宽（不再留整车间隙） */
export const DREAM_BUS_MOBILE_FIRST_STOP_BUS_FACTOR = 0.42;
/** 手机端：三站一行时中心最小间距（避免 label 胶囊重叠） */
export const DREAM_BUS_MOBILE_MIN_STATION_CENTER_GAP_PX = 54;
/** 手机端：每行首站中心不低于此比例（把最左城往右收） */
export const DREAM_BUS_MOBILE_ROW_LEFT_RATIO = 0.48;
/** 手机端：每行末站中心不高于此比例（把最右城往左收） */
export const DREAM_BUS_MOBILE_ROW_RIGHT_RATIO = 0.9;
/** @deprecated 手机端行末站改用 ROW_RIGHT_RATIO */
export const DREAM_BUS_MOBILE_LAYOUT_RIGHT_RATIO = 0.97;

/** 桌面换行：行高（50px 图标 + label） */
export const DREAM_BUS_DESKTOP_WRAP_ROW_STEP_PX = 96;
export const DREAM_BUS_DESKTOP_WRAP_LINE_BELOW_ROW_PX = 58;

export function dreamBusStopRowIndex(
  valueRank: number,
  stationsPerRow: number,
): number {
  return Math.floor(valueRank / stationsPerRow);
}

/** 紧凑多行：偶数行左→右，奇数行右→左；末行不满则按最小间距紧凑衔接 */
export function dreamBusCompactStopCenterPx(
  valueRank: number,
  stationsPerRow: number,
  stopCount: number,
  firstStopCenterPx: number,
  leftMaxPx: number,
  minGapPx = DREAM_BUS_MIN_STATION_CENTER_GAP_PX,
): number {
  const row = Math.floor(valueRank / stationsPerRow);
  const slotInRow = valueRank % stationsPerRow;
  const stopsInRow = Math.min(stationsPerRow, stopCount - row * stationsPerRow);
  const reversed = row % 2 === 1;
  const span = Math.max(0, leftMaxPx - firstStopCenterPx);
  const isPartialRow = stopsInRow < stationsPerRow;

  if (isPartialRow) {
    if (!reversed) return firstStopCenterPx + minGapPx * slotInRow;
    return leftMaxPx - minGapPx * slotInRow;
  }

  if (stopsInRow <= 1) return reversed ? leftMaxPx : firstStopCenterPx;

  const step = Math.max(span / (stopsInRow - 1), minGapPx);
  if (!reversed) return firstStopCenterPx + step * slotInRow;
  return leftMaxPx - step * slotInRow;
}

/** @deprecated 使用 dreamBusCompactStopCenterPx */
export function dreamBusCompactColIndex(valueRank: number, cols: number): number {
  const row = Math.floor(valueRank / cols);
  const slot = valueRank % cols;
  return row % 2 === 0 ? slot : cols - 1 - slot;
}

export function dreamBusWrapRowStepPx(mobileGrid: boolean): number {
  return mobileGrid
    ? DREAM_BUS_MOBILE_ROW_STEP_PX
    : DREAM_BUS_DESKTOP_WRAP_ROW_STEP_PX;
}

export function dreamBusWrapLineBelowRowPx(mobileGrid: boolean): number {
  return mobileGrid
    ? DREAM_BUS_MOBILE_LINE_BELOW_ROW_PX
    : DREAM_BUS_DESKTOP_WRAP_LINE_BELOW_ROW_PX;
}

export function dreamBusWrapRowLineTopPx(row: number, mobileGrid: boolean): number {
  const step = dreamBusWrapRowStepPx(mobileGrid);
  const below = dreamBusWrapLineBelowRowPx(mobileGrid);
  return row * step + below;
}

export function dreamBusWrapBusTopPx(row: number, mobileGrid: boolean): number {
  return dreamBusWrapRowLineTopPx(row, mobileGrid) - 16;
}

export function dreamBusWrapRouteHeightPx(
  stopCount: number,
  stationsPerRow: number,
  mobileGrid: boolean,
): number {
  const rows = Math.max(1, Math.ceil(stopCount / Math.max(1, stationsPerRow)));
  return rows * dreamBusWrapRowStepPx(mobileGrid) + 88;
}

/** @deprecated */
export function dreamBusMobileRowLineTopPx(row: number): number {
  return dreamBusWrapRowLineTopPx(row, true);
}

/** @deprecated */
export function dreamBusMobileBusTopPx(row: number): number {
  return dreamBusWrapBusTopPx(row, true);
}

/** @deprecated */
export function dreamBusMobileRouteHeightPx(stopCount: number): number {
  return dreamBusWrapRouteHeightPx(
    stopCount,
    DREAM_BUS_MOBILE_STATIONS_PER_ROW,
    true,
  );
}

export type DreamBusRouteLayoutOpts = {
  /** 多行布局（桌面换行 或 手机固定 4 行） */
  compact?: boolean;
  /** 手机端：固定每行 3 站；否则按宽度动态计算每行站数 */
  mobile?: boolean;
};

function resolveRouteLayoutMetrics(opts?: DreamBusRouteLayoutOpts) {
  const L = DREAM_BUS_ROUTE_LAYOUT;
  const mobile = opts?.mobile ?? false;
  return {
    boardWidthPx: mobile ? DREAM_BUS_MOBILE_BOARD_WIDTH_PX : L.stationWidthPx,
    busWidthPx: mobile ? DREAM_BUS_MOBILE_BUS_WIDTH_PX : L.busWrapWidthPx,
    stopWidthPx: mobile
      ? DREAM_BUS_MOBILE_LABEL_MAX_PX
      : DREAM_BUS_ROUTE_STOP_WIDTH_PX,
    boardLeftMarginPx: mobile
      ? DREAM_BUS_MOBILE_BOARD_LEFT_MARGIN_PX
      : DREAM_BUS_BOARD_LEFT_MARGIN_PX,
    boardTailGapPx: mobile ? -10 : DREAM_BUS_BOARD_TAIL_GAP_PX,
    boardToFirstExtraPx: mobile ? 2 : DREAM_BUS_BOARD_TO_FIRST_EXTRA_PX,
    firstStopBusFactor: mobile ? DREAM_BUS_MOBILE_FIRST_STOP_BUS_FACTOR : 1,
    layoutRightRatio: mobile ? DREAM_BUS_MOBILE_LAYOUT_RIGHT_RATIO : 0.94,
    minStationCenterGapPx: mobile
      ? DREAM_BUS_MOBILE_MIN_STATION_CENTER_GAP_PX
      : DREAM_BUS_MIN_STATION_CENTER_GAP_PX,
  };
}

/** 站牌左缘距路线区左边界 */
export const DREAM_BUS_BOARD_LEFT_MARGIN_PX = 12;

function dreamBusFirstStopCenterPx(M: ReturnType<typeof resolveRouteLayoutMetrics>): number {
  const boardHalf = M.boardWidthPx / 2;
  const stopHalf = M.stopWidthPx / 2;
  const boardCenterPx = M.boardLeftMarginPx + boardHalf;
  const boardRightPx = boardCenterPx + boardHalf;
  return (
    boardRightPx +
    M.busWidthPx * M.firstStopBusFactor +
    M.boardToFirstExtraPx +
    stopHalf
  );
}

/** 手机端多行：站点行的左右边界（首站往右、末站往左，避免三列拉太开） */
function dreamBusMobileRowSpanPx(
  layoutWidth: number,
  naturalFirstStopCenterPx: number,
  minGapPx: number,
): { firstCenterPx: number; leftMaxPx: number } {
  const firstCenterPx = Math.max(
    naturalFirstStopCenterPx,
    layoutWidth * DREAM_BUS_MOBILE_ROW_LEFT_RATIO,
  );
  const leftMaxPx = Math.max(
    layoutWidth * DREAM_BUS_MOBILE_ROW_RIGHT_RATIO,
    firstCenterPx + minGapPx * 2,
  );
  return { firstCenterPx, leftMaxPx };
}

/** 桌面多行：当前宽度下一行最多放几站 */
export function dreamBusDesktopWrapStationsPerRow(
  layoutWidthPx: number,
  firstStopCenterPx: number,
  stopCount: number,
): number {
  const leftMaxPx = layoutWidthPx * 0.94;
  const availableSpan = Math.max(0, leftMaxPx - firstStopCenterPx);
  const minStep = DREAM_BUS_MIN_STATION_CENTER_GAP_PX;
  if (availableSpan <= 0) return 1;
  const maxFit = Math.floor(availableSpan / minStep) + 1;
  return Math.max(1, Math.min(stopCount, maxFit));
}

/** 单行布局所需最小宽度（再窄则切多行） */
export function dreamBusRouteNeedsCompactLayout(
  routeWidthPx: number,
  stopCount: number,
): boolean {
  if (stopCount <= 1) return false;
  const M = resolveRouteLayoutMetrics({ compact: false, mobile: false });
  const firstStopCenterPx = dreamBusFirstStopCenterPx(M);
  const span = routeWidthPx * 0.94 - firstStopCenterPx;
  if (span <= 0) return true;
  const gap = span / (stopCount - 1);
  return gap < DREAM_BUS_MIN_STATION_CENTER_GAP_PX;
}

export type DreamBusRouteAnchorLayout = {
  boardCenterPx: number;
  routeLeadingInsetPx: number;
  busStartLeftPct: number;
  stopLeftPcts: number[];
  boardWidthPx: number;
  busWidthPx: number;
  /** 多行时每行站数（单行时 = stopCount） */
  stationsPerRow: number;
  mobileGrid: boolean;
};

/** 以站牌为锚：车尾贴站牌右侧，站牌到首站略大于一个车宽 */
export function dreamBusRouteAnchorLayout(
  routeWidthPx: number,
  stopCount: number,
  opts?: DreamBusRouteLayoutOpts,
): DreamBusRouteAnchorLayout {
  const compact = opts?.compact ?? false;
  const mobileGrid = opts?.mobile ?? false;
  const M = resolveRouteLayoutMetrics({ compact, mobile: mobileGrid });
  const boardHalf = M.boardWidthPx / 2;
  const busHalf = M.busWidthPx / 2;
  const stopHalf = M.stopWidthPx / 2;

  const boardCenterPx = M.boardLeftMarginPx + boardHalf;
  const boardRightPx = boardCenterPx + boardHalf;
  const busCenterPx = boardRightPx + M.boardTailGapPx + busHalf;
  const firstStopCenterPx = dreamBusFirstStopCenterPx(M);

  const layoutWidth = compact
    ? Math.max(routeWidthPx, mobileGrid ? routeWidthPx : 280)
    : Math.max(routeWidthPx, DREAM_BUS_ROUTE_REF_WIDTH_PX);
  const naturalLeftMaxPx = layoutWidth * M.layoutRightRatio;
  const mobileRowSpan = mobileGrid
    ? dreamBusMobileRowSpanPx(layoutWidth, firstStopCenterPx, M.minStationCenterGapPx)
    : null;
  const stationFirstCenterPx = mobileRowSpan?.firstCenterPx ?? firstStopCenterPx;
  const stationLeftMaxPx = mobileRowSpan?.leftMaxPx ?? naturalLeftMaxPx;

  let stopLeftPcts: number[] = [];
  let stationsPerRow = Math.max(1, stopCount);

  if (stopCount <= 0) {
    stopLeftPcts = [];
    stationsPerRow = 1;
  } else if (compact) {
    const cols = mobileGrid
      ? DREAM_BUS_MOBILE_STATIONS_PER_ROW
      : dreamBusDesktopWrapStationsPerRow(
          layoutWidth,
          firstStopCenterPx,
          stopCount,
        );
    stationsPerRow = cols;
    stopLeftPcts = Array.from({ length: stopCount }, (_, i) => {
      const centerPx = dreamBusCompactStopCenterPx(
        i,
        cols,
        stopCount,
        stationFirstCenterPx,
        stationLeftMaxPx,
        M.minStationCenterGapPx,
      );
      return (centerPx / layoutWidth) * 100;
    });
  } else if (stopCount === 1) {
    stopLeftPcts = [(stationFirstCenterPx / layoutWidth) * 100];
  } else {
    const span = Math.max(0, stationLeftMaxPx - stationFirstCenterPx);
    stopLeftPcts = Array.from({ length: stopCount }, (_, i) => {
      const centerPx = stationFirstCenterPx + (span * i) / (stopCount - 1);
      return (centerPx / layoutWidth) * 100;
    });
  }

  return {
    boardCenterPx,
    routeLeadingInsetPx: 0,
    busStartLeftPct: (busCenterPx / layoutWidth) * 100,
    stopLeftPcts,
    boardWidthPx: M.boardWidthPx,
    busWidthPx: M.busWidthPx,
    stationsPerRow,
    mobileGrid,
  };
}

/** @deprecated 请用 dreamBusRouteAnchorLayout */
export function dreamBusStationBoardCenterPx(
  routeWidthPx: number,
  _firstStopLeftPct: number,
): number {
  return dreamBusRouteAnchorLayout(routeWidthPx, 1).boardCenterPx;
}

/** @deprecated 请用 dreamBusRouteAnchorLayout */
export function dreamBusStationBoardLayout(
  routeWidthPx: number,
  _firstStopLeftPct: number,
): { centerPx: number; routeLeadingInsetPx: number } {
  const layout = dreamBusRouteAnchorLayout(routeWidthPx, 1);
  return {
    centerPx: layout.boardCenterPx,
    routeLeadingInsetPx: layout.routeLeadingInsetPx,
  };
}

/** @deprecated 请用 dreamBusStationBoardLayout */
export function dreamBusStationBoardLeftPx(
  routeWidthPx: number,
  firstStopLeftPct: number,
): number {
  return dreamBusStationBoardCenterPx(routeWidthPx, firstStopLeftPct);
}
