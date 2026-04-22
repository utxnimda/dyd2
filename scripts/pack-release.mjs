/**
 * 将 dist/ 复制到 release/<fmzReleaseLabel>/，便于按版本归档、上传服务器。
 * 由 npm run pack 在 vite build 之后调用。
 *
 * ★ 强制确认机制：打包前会列出所有模块的发布状态，
 *   用户必须手动输入 "yes" 确认后才会执行归档。
 *   可通过 --yes 或 -y 跳过确认（仅限 CI 场景）。
 *
 * 数据归档：按「发布」的模块，将 server/data/ 中对应子路径复制到
 *   release/<label>/server/data/，便于与静态资源一并备份或上传节点。
 *   不含 defense_tower.db（由服务在线生成）。--skip-data 禁用；--exclude-audio-source 排除 source.* 大文件。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const label = String(pkg.fmzReleaseLabel ?? `v${pkg.version}`).trim() || "v0.0.0";
const dist = join(root, "dist");
const target = join(root, "release", label);
const metaPath = join(target, "BUILD_INFO.txt");

/* ------------------------------------------------------------------ */
/*  Feature module display names                                      */
/* ------------------------------------------------------------------ */
const FEATURE_LABELS = {
  sanguo:      "三国守塔",
  baobao:      "百宝箱（B站搜索）",
  audio:        "🎶 忽闻宝声 / 曲库与播放",
  audioPlugin:  "音频提取插件（仅本地）",
  battle:      "战斗爽",
  treasury:    "团员金库",
  preliminary: "预赛数据",
  users:       "用户积分",
  quota:       "用量看板",
};

/* ------------------------------------------------------------------ */
/*  Display release module summary                                    */
/* ------------------------------------------------------------------ */
const features = pkg.fmzFeatures || {};
const skipConfirm = process.argv.includes("--yes") || process.argv.includes("-y");

console.log("");
console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║           📦 发布模块确认（Release Confirmation）        ║");
console.log("╠══════════════════════════════════════════════════════════╣");
console.log(`║  版本: ${label.padEnd(48)}║`);
console.log("╠══════════════════════════════════════════════════════════╣");

const enabledModules = [];
const disabledModules = [];

for (const [key, rawVal] of Object.entries(features)) {
  const displayName = FEATURE_LABELS[key] || key;
  // After bump-patch.mjs runs, "local" should already be downgraded to false.
  // If it's still "local" here, something went wrong (e.g. bump-patch was skipped).
  let status;
  let icon;
  if (rawVal === true) {
    status = "✅ 发布";
    icon = "✅";
    enabledModules.push(displayName);
  } else if (rawVal === "local") {
    // "local" should NOT appear here — bump-patch should have downgraded it.
    status = "⚠️  仍为 local（未经 bump-patch 降级！）";
    icon = "⚠️";
    enabledModules.push(`${displayName} ⚠️ [local未降级]`);
  } else {
    status = "⛔ 不发布";
    icon = "⛔";
    disabledModules.push(displayName);
  }
  console.log(`║  ${icon} ${displayName.padEnd(25)} ${status.padEnd(25)}║`);
}

console.log("╠══════════════════════════════════════════════════════════╣");

// Warn if any feature is still "local" (bump-patch was likely skipped)
const localFeatures = Object.entries(features).filter(([, v]) => v === "local");
if (localFeatures.length > 0) {
  console.log("║  ⚠️  警告：以下模块仍为 \"local\"，可能跳过了 bump-patch！  ║");
  for (const [key] of localFeatures) {
    const name = FEATURE_LABELS[key] || key;
    console.log(`║     → ${name.padEnd(49)}║`);
  }
  console.log("║  请确认是否有意为之，否则请先运行 bump-patch.mjs          ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
}

console.log(`║  将发布 ${enabledModules.length} 个模块，关闭 ${disabledModules.length} 个模块`.padEnd(57) + "║");
console.log("╚══════════════════════════════════════════════════════════╝");
console.log("");

/* ------------------------------------------------------------------ */
/*  Interactive confirmation                                          */
/* ------------------------------------------------------------------ */

async function askConfirmation() {
  if (skipConfirm) {
    console.log("(--yes 已指定，跳过手动确认)");
    return true;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("确认以上模块列表正确？输入 yes 继续，其他任意键取消: ", (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

const confirmed = await askConfirmation();

if (!confirmed) {
  console.log("\n❌ 已取消打包。请检查 package.json 中的 fmzFeatures 配置后重试。");
  process.exit(1);
}

const skipData = process.argv.includes("--skip-data");
const excludeAudioSource = process.argv.includes("--exclude-audio-source");

/* ------------------------------------------------------------------ */
/*  server/data/ → release/<label>/server/data/ (按发布模块)           */
/* ------------------------------------------------------------------ */

/**
 * 根据启用的 feature（值为 true 视为会发布到线上）决定需要进包的数据路径。
 * reactions.db 与多个模块共享，用 Set 去重。
 */
function dataRelPathsToArchive(f) {
  const set = new Set();
  // defense_tower.db 由服务在线拉取/生成，不纳入发布包体归档
  if (f.audio === true) set.add("audio");
  for (const k of ["battle", "treasury", "preliminary", "users"]) {
    if (f[k] === true) {
      set.add("reactions.db");
      break;
    }
  }
  return [...set];
}

/**
 * 复制单文件或整目录到 release 镜像路径。
 */
function copyDataPath(rel, destRoot) {
  const src = join(root, "server", "data", rel);
  if (!existsSync(src)) {
    return { rel, ok: false, reason: "missing" };
  }
  const dest = join(destRoot, rel);
  mkdirSync(dirname(dest), { recursive: true });
  if (rel === "audio" && statSync(src).isDirectory()) {
    const opts = { recursive: true };
    if (excludeAudioSource) {
      Object.assign(opts, {
        filter: (p) => {
          const fn = p.split(/[/\\]/).pop() || "";
          if (fn.startsWith("source.")) return false;
          return true;
        },
      });
    }
    cpSync(src, dest, opts);
  } else {
    cpSync(src, dest, { recursive: true });
  }
  return { rel, ok: true, reason: "" };
}

/* ------------------------------------------------------------------ */
/*  Archive dist/ → release/<label>/                                  */
/* ------------------------------------------------------------------ */

mkdirSync(join(root, "release"), { recursive: true });
rmSync(target, { recursive: true, force: true });
cpSync(dist, target, { recursive: true });

const archivedData = [];
if (!skipData) {
  const rels = dataRelPathsToArchive(features);
  const outDataRoot = join(target, "server", "data");
  if (rels.length) {
    if (!existsSync(join(root, "server", "data"))) {
      console.log("\n⚠️  未找到 server/data/，跳过数据归档（本地尚无运行时数据时正常）。");
    } else {
      for (const rel of rels) {
        const r = copyDataPath(rel, outDataRoot);
        if (r.ok) {
          archivedData.push(rel);
          console.log(`  [data] 已复制: server/data/${rel}`);
        } else {
          console.log(`  [data] 跳过（无）: server/data/${rel}`);
        }
      }
      if (excludeAudioSource && rels.includes("audio")) {
        console.log("  [data] 已使用 --exclude-audio-source 排除各 BV 下的 source.*");
      }
    }
  } else {
    console.log("\n  [data] 当前无需要归档的数据子路径（所发布模块不依赖 server/data 文件）。");
  }
} else {
  console.log("\n  [data] 已使用 --skip-data，跳过。");
}

const meta = [
  `release: ${label}`,
  `package.version: ${pkg.version}`,
  `packedAt: ${new Date().toISOString()}`,
  `enabledFeatures: ${enabledModules.join(", ") || "(none)"}`,
  `disabledFeatures: ${disabledModules.join(", ") || "(none)"}`,
  `archivedServerData: ${archivedData.length ? archivedData.join(", ") : "(none)"}`,
  "",
].join("\n");
writeFileSync(metaPath, meta, "utf-8");

console.log(`\n✅ 已打包到 release/${label}/（含 BUILD_INFO.txt${archivedData.length ? "、server/data" : ""}）`);
