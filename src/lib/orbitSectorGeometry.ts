/**
 * 与 CaptainCornersHud 一致：扇形 clip 与百分比半径（0°=正上，顺时针）。
 */
export function sectorArcToXY(deg: number, rPct: number): string {
  const rad = (deg * Math.PI) / 180;
  return `${50 + rPct * Math.sin(rad)}% ${50 - rPct * Math.cos(rad)}%`;
}

export function sectorClipPathForArc(
  a0: number,
  a1: number,
  innerPct: number,
  outerPct: number,
): string {
  if (outerPct <= innerPct) return "none";
  let span = a1 - a0;
  if (span <= 0 && a1 >= 360 - 1e-6 && a0 <= 1e-6) span = 360;
  if (span <= 0) return "none";
  const segments = Math.max(4, Math.min(36, Math.ceil(span / 5)));
  const pts: string[] = [sectorArcToXY(a0, outerPct)];
  for (let s = 1; s <= segments; s++) {
    const t = a0 + (span * s) / segments;
    pts.push(sectorArcToXY(t, outerPct));
  }
  for (let s = segments; s >= 0; s--) {
    const t = a0 + (span * s) / segments;
    pts.push(sectorArcToXY(t, innerPct));
  }
  return `polygon(${pts.join(", ")})`;
}

export function sectorRadiiPctFromRem(
  innerRem: number,
  outerRem: number,
  sideRem: number,
): { innerPct: number; outerPct: number } {
  const half = sideRem / 2;
  const innerPct = (innerRem / half) * 50;
  const outerPct = (outerRem / half) * 50;
  const inP = Math.max(0.5, Math.min(innerPct, 47));
  const outP = Math.max(inP + 0.85, Math.min(outerPct, 49.85));
  return { innerPct: inP, outerPct: outP };
}

export function orbitArcMidDeg(a0: number, a1: number): number {
  let span = a1 - a0;
  if (span < -1e-6) span += 360;
  if (span <= 1e-6) {
    let m = a0 % 360;
    if (m < 0) m += 360;
    return m;
  }
  if (Math.abs(span - 360) < 1e-6 || span >= 360 - 1e-6) return 0;
  let mid = a0 + span / 2;
  mid = mid % 360;
  if (mid < 0) mid += 360;
  return mid;
}
