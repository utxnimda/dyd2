/**
 * 站名 label 胶囊内倍率数字的相对位置（固定比例，不随使用场景改变）。
 * 各场景仅调整 maxWidth / fontScale。
 */
export const DREAM_BUS_LABEL_VALUE_LAYOUT = {
  zoneLeft: "63%",
  zoneRight: "10%",
  zoneTop: "20%",
  zoneBottom: "8%",
  /** 在底色区内再向左微调 */
  valueShiftX: "-42%",
  /** 相对胶囊宽度的字号（container query） */
  fontCqw: 14.5,
} as const;

export const DREAM_BUS_LABEL_PRESETS = {
  route: { maxWidth: "72px", fontScale: 1 },
  grid: { maxWidth: "40px", fontScale: 0.88 },
  ratio: { maxWidth: "3.2rem", fontScale: 0.85 },
} as const;
