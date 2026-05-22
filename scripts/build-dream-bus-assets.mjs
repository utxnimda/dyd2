/**
 * 处理宝宝巴士 UI 资源：站牌 / 巴士去底（透明 PNG）。
 * 源图：image/station.png、image/bus.png、image/dream-bus/bus3.png
 * 输出为 RGBA 透明底；勿用未去底的 bus3.png 直接当 bus-body3.png 使用。
 *
 *   node scripts/build-dream-bus-assets.mjs
 */
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "image/dream-bus");

const SOURCES = [
  {
    src: join(ROOT, "image/station.png"),
    dest: join(OUT_DIR, "station-board.png"),
    colorkey: "0xFFFFFF:0.06:0.02",
  },
  {
    src: join(ROOT, "image/bus.png"),
    dest: join(OUT_DIR, "bus-body.png"),
    colorkey: "0xFFFFFF:0.06:0.02",
  },
  {
    src: join(OUT_DIR, "bus3.png"),
    dest: join(OUT_DIR, "bus-body3.png"),
    colorkey: "0x000000:0.08:0.02",
  },
  {
    src: join(ROOT, "image/dream-bus/baobaozuoche.png"),
    dest: join(OUT_DIR, "passenger-head.png"),
    colorkey: "0xFFFFFF:0.05:0.02",
    crop: "crop=iw:ih*0.93:0:0",
  },
];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

function transparentize({ src, dest, colorkey, crop, extraColorkeys, optional }) {
  if (!existsSync(src)) {
    if (optional) {
      console.warn("Skip optional source:", src);
      return;
    }
    console.error("Missing source:", src);
    process.exit(1);
  }
  const keys = [colorkey, ...(extraColorkeys ?? [])].map((k) => `colorkey=${k}`);
  const filters = [crop, ...keys, "format=rgba"].filter(Boolean).join(",");
  run("ffmpeg", [
    "-y",
    "-i",
    src,
    "-vf",
    filters,
    "-frames:v",
    "1",
    "-update",
    "1",
    dest,
  ]);
  console.log("Wrote", dest);
}

mkdirSync(OUT_DIR, { recursive: true });

for (const item of SOURCES) {
  transparentize(item);
}
