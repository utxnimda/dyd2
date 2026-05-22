/**
 * 梦想巴士站点图标（来自官方 H5 玩法介绍页 CDN）。
 * 脚本：scripts/fetch-dreambus-station-icons.mjs
 */
import s01 from "../../../image/dream-bus/stations/station-01-intro.png?url";
import s02 from "../../../image/dream-bus/stations/station-02-intro.png?url";
import s03 from "../../../image/dream-bus/stations/station-03-intro.png?url";
import s04 from "../../../image/dream-bus/stations/station-04-intro.png?url";
import s05 from "../../../image/dream-bus/stations/station-05-intro.png?url";
import s06 from "../../../image/dream-bus/stations/station-06-intro.png?url";
import s07 from "../../../image/dream-bus/stations/station-07-intro.png?url";
import s08 from "../../../image/dream-bus/stations/station-08-intro.png?url";
import s09 from "../../../image/dream-bus/stations/station-09-intro.png?url";
import s10 from "../../../image/dream-bus/stations/station-10-intro.png?url";
import s11 from "../../../image/dream-bus/stations/station-11-intro.png?url";
import s12 from "../../../image/dream-bus/stations/station-12-intro.png?url";

import m01 from "../../../image/dream-bus/stations/station-01-map.png?url";
import m02 from "../../../image/dream-bus/stations/station-02-map.png?url";
import m03 from "../../../image/dream-bus/stations/station-03-map.png?url";
import m04 from "../../../image/dream-bus/stations/station-04-map.png?url";
import m05 from "../../../image/dream-bus/stations/station-05-map.png?url";
import m06 from "../../../image/dream-bus/stations/station-06-map.png?url";
import m07 from "../../../image/dream-bus/stations/station-07-map.png?url";
import m08 from "../../../image/dream-bus/stations/station-08-map.png?url";
import m09 from "../../../image/dream-bus/stations/station-09-map.png?url";
import m10 from "../../../image/dream-bus/stations/station-10-map.png?url";
import m11 from "../../../image/dream-bus/stations/station-11-map.png?url";
import m12 from "../../../image/dream-bus/stations/station-12-map.png?url";

import l01 from "../../../image/dream-bus/stations/station-01-label.png?url";
import l02 from "../../../image/dream-bus/stations/station-02-label.png?url";
import l03 from "../../../image/dream-bus/stations/station-03-label.png?url";
import l04 from "../../../image/dream-bus/stations/station-04-label.png?url";
import l05 from "../../../image/dream-bus/stations/station-05-label.png?url";
import l06 from "../../../image/dream-bus/stations/station-06-label.png?url";
import l07 from "../../../image/dream-bus/stations/station-07-label.png?url";
import l08 from "../../../image/dream-bus/stations/station-08-label.png?url";
import l09 from "../../../image/dream-bus/stations/station-09-label.png?url";
import l10 from "../../../image/dream-bus/stations/station-10-label.png?url";
import l11 from "../../../image/dream-bus/stations/station-11-label.png?url";
import l12 from "../../../image/dream-bus/stations/station-12-label.png?url";

/** 玩法介绍 / 统计网格用（方形徽章） */
export const DREAM_BUS_STATION_INTRO_ICON: Record<number, string> = {
  1: s01,
  2: s02,
  3: s03,
  4: s04,
  5: s05,
  6: s06,
  7: s07,
  8: s08,
  9: s09,
  10: s10,
  11: s11,
  12: s12,
};

/** 地图路线用（带场景透视） */
export const DREAM_BUS_STATION_MAP_ICON: Record<number, string> = {
  1: m01,
  2: m02,
  3: m03,
  4: m04,
  5: m05,
  6: m06,
  7: m07,
  8: m08,
  9: m09,
  10: m10,
  11: m11,
  12: m12,
};

/** 站名徽章（官方 label 图，含站名文字） */
export const DREAM_BUS_STATION_LABEL_ICON: Record<number, string> = {
  1: l01,
  2: l02,
  3: l03,
  4: l04,
  5: l05,
  6: l06,
  7: l07,
  8: l08,
  9: l09,
  10: l10,
  11: l11,
  12: l12,
};

export function dreamBusStationIconUrl(
  stationId: number,
  variant: "intro" | "map" | "label" = "intro",
): string | undefined {
  if (variant === "label") return DREAM_BUS_STATION_LABEL_ICON[stationId];
  const map = variant === "map" ? DREAM_BUS_STATION_MAP_ICON : DREAM_BUS_STATION_INTRO_ICON;
  return map[stationId];
}

export function dreamBusStationLabelUrl(stationId: number): string | undefined {
  return DREAM_BUS_STATION_LABEL_ICON[stationId];
}
