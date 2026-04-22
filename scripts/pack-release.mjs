/**
 * 将 dist/ 复制到 release/<fmzReleaseLabel>/，便于按版本归档、上传服务器。
 * 由 npm run pack 在 vite build 之后调用。
 *
 * ★ 强制确认机制：打包前会列出所有模块的发布状态，
 *   用户必须手动输入 "yes" 确认后才会执行归档。
 *   可通过 --yes 或 -y 跳过确认（仅限 CI 场景）。
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  audio:       "🎶 歌曲库 / 音频提取",
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

/* ------------------------------------------------------------------ */
/*  Archive dist/ → release/<label>/                                  */
/* ------------------------------------------------------------------ */

mkdirSync(join(root, "release"), { recursive: true });
rmSync(target, { recursive: true, force: true });
cpSync(dist, target, { recursive: true });

const meta = [
  `release: ${label}`,
  `package.version: ${pkg.version}`,
  `packedAt: ${new Date().toISOString()}`,
  `enabledFeatures: ${enabledModules.join(", ") || "(none)"}`,
  `disabledFeatures: ${disabledModules.join(", ") || "(none)"}`,
  "",
].join("\n");
writeFileSync(metaPath, meta, "utf-8");

console.log(`\n✅ 已打包到 release/${label}/（含 BUILD_INFO.txt）`);
