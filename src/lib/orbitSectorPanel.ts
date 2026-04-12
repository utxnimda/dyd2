/**
 * 战斗爽轨道：单人扇形面板一体配置。
 * 几何（相对轨道板圆心）、头像、昵称/积分、扇形填充与透明度均由此集中定义；
 * CaptainCornersHud 通过 orbitSectorPanelCssVars() 注入为 CSS 变量，子组件用 var(--orbit-*) 引用。
 */
/**
 * 单人物轨道槽：名字+积分布局。
 * - arc：弧排昵称 + 外弧积分（保留模板，便于对照）。
 * - experimental：当前保存的定稿——积分在头像上、昵称在头像下，绝对定位不扰动轨道锚点。
 */
export type OrbitNameScoreVariant = "arc" | "experimental";

/** 默认与 `ORBIT_SECTOR_PANEL.orbitNameScoreVariant` 一致，便于单测或引用 */
export const DEFAULT_ORBIT_NAME_SCORE_VARIANT: OrbitNameScoreVariant =
  "experimental";

export const ORBIT_SECTOR_PANEL = {
  /** 见 {@link OrbitNameScoreVariant}；默认 experimental（已保存样式） */
  orbitNameScoreVariant:
    DEFAULT_ORBIT_NAME_SCORE_VARIANT as OrbitNameScoreVariant,
  /** 扇形内弧不得小于此半径（rem，相对板心） */
  hubSectorInnerRem: 2.95,
  /** 相对槽轨道半径 r：内侧带、外侧带（rem），决定径向厚度 */
  bandInnerRem: 1.9,
  bandOuterRem: 2.75,
  /** 轨道基环半径、圈间距（rem） */
  orbitBaseRem: 5.5,
  orbitStepRem: 3.65,
  /** 队长内环在 base 上的最小加量（rem） */
  captainRingFloorOffsetRem: 1.85,
  /** 弦长占位（px） */
  slotChordPx: { captain: 80, member: 118 },
  /** 头像尺寸与描边 */
  avatar: { sizePx: 36, borderPx: 2 },
  /** 赤道槽内：昵称（圆心侧）与积分（外圈侧） */
  orbitStack: {
    radialPadRem: 1.82,
    radialGapRem: 0.1,
    radialTailRem: 0.38,
    nameFontRem: 0.62,
    nameLineHeight: 1.15,
    scoreFontRem: 0.66,
    scoreLineHeight: 1.05,
    labelMaxWidthRem: 4.35,
    metaMaxWidthRem: 4.25,
  },
  /** 队长扇形圆心角收紧（与头像列宽匹配） */
  captainArcTight: {
    colWidthRem: 4.28,
    padDeg: 2,
    minDeg: 14,
    maxDeg: 72,
  },
  /**
   * 相邻阵营象限之间的角向留空（度）：每个象限从 90° 两侧各收 g/2，净可用弧长为 90°−g；
   * 队内多名队长仍等分整块可用弧，彼此不留缝。
   */
  interTeamBoundaryGapDeg: 2.8,
  /**
   * 队内相邻队长扇形 clip 在径向边上的亚像素缝：两侧各扩约一半此角（度），仅队内多于 1 人且非象限外缘；
   * 略重叠以盖住抗锯齿缝隙，不影响阵营分界。
   */
  captainIntraTeamSeamOverlapDeg: 0.28,
  /**
   * 队员/其他外圈：同色相邻两侧各扩此角（度）以角向重叠，与队长队内缝一致；
   * 异色（队员↔其他）相邻则两侧各收此角，留缝总宽 2×本值，与重叠带同宽。
   */
  memberIntraRingSeamOverlapDeg: 0.28,
  /**
   * 相邻轨道圈扇形底图之间的径向缝（rem），clip 时内弧/外弧各让出约一半，避免圈与圈叠色。
   */
  ringRadialSeamRem: 0.07,
  /** 每位一员一块扇形底图 */
  sectorFill: {
    opacity: 0.5,
    gradientAngleDeg: 168,
    accentMixStrongPct: 40,
    accentMixWeakPct: 14,
    borderAccentMixPct: 28,
  },
  /** 轨道正方形边长 = 2*maxOuter + sidePadding，且不小于 sideMin */
  board: {
    sidePaddingRem: 5,
    sideMinRem: 20,
  },
  /**
   * 弧排昵称：整段以扇形角域中点为对称中心（与内弧中点共径向，即在内弧法线上），
   * 半径在内弧与赤道之间插值以靠近头像；角向收紧并留边，保证落在扇形内。
   */
  nameArc: {
    /** R_name = inner + towardAvatarT * (equator - inner)，1 最靠头像 */
    towardAvatarT: 0.58,
    /** 相邻两字圆心角上限（度），越小越紧凑 */
    maxDegBetweenChars: 5,
    /** 整段名字最多占用扇形圆心角的比例（与上一项共同限制） */
    maxSpanFracOfSector: 0.34,
    /** 与扇形边界留角（度），避免贴边出界 */
    sectorEdgeMarginDeg: 1.35,
    /** 头像圆外再留的间隙（px，16px=1rem），与字不相切 */
    avatarExtraPadPx: 5,
    /** 单字径向占位：约 nameFontRem × 此系数（半行高量级） */
    glyphHalfLineEm: 0.48,
  },
  /**
   * 外弧积分：与 nameArc 对称，贴在扇形外弧附近（赤道～外弧之间插值），
   * 角向对称、防与头像重叠、不越出扇形外缘。
   */
  scoreArc: {
    /** R_score = equator + towardOutsideT * (outer - equator)，1 最靠外弧 */
    towardOutsideT: 0.55,
    maxDegBetweenChars: 5,
    maxSpanFracOfSector: 0.34,
    sectorEdgeMarginDeg: 1.35,
    avatarExtraPadPx: 5,
    /** 单字径向占位：约 scoreFontRem × 此系数 */
    glyphHalfLineEm: 0.48,
  },
} as const;

export type OrbitSectorPanelConfig = typeof ORBIT_SECTOR_PANEL;

/** 注入到 .orbit-board，供扇形与 HudBattleMemberSlot 继承 */
export function orbitSectorPanelCssVars(
  P: OrbitSectorPanelConfig = ORBIT_SECTOR_PANEL,
): Record<string, string> {
  const av = P.avatar.sizePx;
  const half = av / 2;
  const os = P.orbitStack;
  const sf = P.sectorFill;
  return {
    "--orbit-hub-inner-rem": String(P.hubSectorInnerRem),
    "--orbit-band-in-rem": String(P.bandInnerRem),
    "--orbit-band-out-rem": String(P.bandOuterRem),
    "--orbit-base-rem": String(P.orbitBaseRem),
    "--orbit-step-rem": String(P.orbitStepRem),
    "--orbit-avatar-size": `${av}px`,
    "--orbit-avatar-border": `${P.avatar.borderPx}px`,
    "--orbit-avatar-half": `${half}px`,
    "--orbit-radial-pad": `${os.radialPadRem}rem`,
    "--orbit-radial-gap": `${os.radialGapRem}rem`,
    "--orbit-radial-tail": `${os.radialTailRem}rem`,
    "--orbit-score-font": `${os.scoreFontRem}rem`,
    "--orbit-score-lh": String(os.scoreLineHeight),
    "--orbit-score-block": `calc(${os.scoreFontRem}rem * ${os.scoreLineHeight})`,
    "--orbit-shift-radial": `calc(var(--orbit-score-block) + var(--orbit-radial-gap) + var(--orbit-avatar-half))`,
    "--orbit-name-font": `${os.nameFontRem}rem`,
    "--orbit-name-lh": String(os.nameLineHeight),
    "--orbit-label-max": `${os.labelMaxWidthRem}rem`,
    "--orbit-meta-max": `${os.metaMaxWidthRem}rem`,
    "--orbit-sector-opacity": String(sf.opacity),
    "--orbit-sector-gradient-deg": `${sf.gradientAngleDeg}deg`,
    "--orbit-sector-mix-strong": `${sf.accentMixStrongPct}%`,
    "--orbit-sector-mix-weak": `${sf.accentMixWeakPct}%`,
    "--orbit-sector-border-mix": `${sf.borderAccentMixPct}%`,
  };
}
