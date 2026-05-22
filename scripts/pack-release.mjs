/**
 * 将 dist/ 复制到 release/<fmzReleaseLabel>/，便于按版本归档、上传服务器。
 * 由 npm run pack 在 vite build 之后调用。
 *
 * ★ 强制确认机制：打包前会列出所有模块的发布状态，
 *   用户必须手动输入 "yes" 确认后才会执行归档。
 *   非交互环境（无 TTY / CI）或 --yes / -y 时自动跳过确认。
 *
 * 数据归档：按「发布」的模块，将 server/data/ 中对应子路径复制到
 *   release/<label>/server/data/，便于与静态资源一并备份或上传节点。
 *   不含 defense_tower.db（由服务在线生成）。--skip-data 禁用；--exclude-audio-source 排除 source.* 大文件。
 *
 * 后端脚本镜像：按 fmzFeatures 将需上线的 Node 服务 .mjs（及 AI 的 package.json）
 *   复制到 release/<label>/opt/<远端目录名>/，与服务器 /opt/fmz-*-server/ 对齐，
 *   供 npm run deploy 一并 SCP。**不含密钥**（如 ai-agent-keys.json）。--skip-opt 禁用。
 *
 * 配置样例：将仓库 deploy/ 下 Nginx、systemd 单元样例复制到 release/<label>/config/，
 *   便于与版本一并归档；**默认不**自动覆盖远端 /etc（deploy 需 FMZ_DEPLOY_SYNC_NGINX=1）。--skip-config 禁用。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
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
  sanguoUi:    "三国守塔 UI（仅本地）",
  baobao:      "百宝箱（B站搜索）",
  audio:        "🎶 忽闻宝声 / 曲库与播放（及拾观宝片、遥忆宝章提取链路）",
  audioPlugin:  "音频提取插件（仅本地）",
  battle:      "战斗爽",
  treasury:    "团员金库",
  preliminary: "预赛数据",
  users:       "用户积分",
  quota:       "用量看板",
  crimes:      "🎵 细数宝罪",
  douyuDanmaku: "🎯 弹幕捕捉",
  dreamBus:     "🚌 宝宝巴士",
  aiAgent:      "🤖 AI 分析与对话（前端面板 + ai-agent-server）",
  voiceClone:   "🎤 幻化宝音",
  ruinsRebuild: "废墟重建 · 调试（仅 local，发布关闭）",
};

/* ------------------------------------------------------------------ */
/*  Display release module summary                                    */
/* ------------------------------------------------------------------ */
const features = pkg.fmzFeatures || {};
const skipConfirm =
  process.argv.includes("--yes") ||
  process.argv.includes("-y") ||
  !process.stdin.isTTY ||
  process.env.CI === "true" ||
  process.env.CI === "1";

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
    if (process.argv.includes("--yes") || process.argv.includes("-y")) {
      console.log("(--yes 已指定，跳过手动确认)");
    } else {
      console.log("(非交互环境，跳过模块确认)");
    }
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
const skipOpt = process.argv.includes("--skip-opt");
const skipConfig = process.argv.includes("--skip-config");

/**
 * 与生产环境 /opt/<remoteName>/ 目录一致；仅在对应特性为 true 时纳入 release（赞踩见 include）。
 * 注：quota（用量看板）**不**走本流水线，仅使用 `npm run pack:quota`（`scripts/pack-quota.mjs`）。
 * copies: [ 仓库相对路径, 放入 opt 内文件名 ]
 */
const OPT_RELEASE_BUNDLES = [
  {
    remoteName: "fmz-danmaku-server",
    include: (f) => f.douyuDanmaku === true || f.dreamBus === true,
    copies: [
      ["server/douyu-danmaku-server.mjs", "douyu-danmaku-server.mjs"],
      ["server/gemini-openai-compat-chat-filter.mjs", "gemini-openai-compat-chat-filter.mjs"],
    ],
  },
  {
    remoteName: "fmz-ai-agent-server",
    include: (f) => f.aiAgent === true,
    copies: [
      ["server/ai-agent-server.mjs", "ai-agent-server.mjs"],
      ["server/gemini-openai-compat-chat-filter.mjs", "gemini-openai-compat-chat-filter.mjs"],
      ["deploy/fmz-ai-agent-server.package.json", "package.json"],
    ],
  },
  {
    remoteName: "fmz-audio-server",
    include: (f) => f.audio === true,
    copies: [["server/audio-extractor-server.mjs", "audio-extractor-server.mjs"]],
  },
  {
    remoteName: "fmz-crimes-server",
    include: (f) => f.crimes === true,
    copies: [["server/crimes-server.mjs", "crimes-server.mjs"]],
  },
  {
    remoteName: "fmz-defense-server",
    include: (f) => f.sanguo === true,
    copies: [
      ["server/defense-tower-server.mjs", "defense-tower-server.mjs"],
      ["server/package.json", "package.json"],
    ],
  },
  {
    remoteName: "fmz-reactions-server",
    include: (f) =>
      f.battle === true || f.treasury === true || f.preliminary === true || f.users === true,
    copies: [
      ["server/reactions-server.mjs", "reactions-server.mjs"],
      ["server/package.json", "package.json"],
    ],
  },
];

/**
 * 与各 opt 目录并列：`douyu-danmaku-server.mjs` import `./fmz-static.mjs`；
 * JSON 供该模块运行时读取（与 runnable *.mjs 同目录）。
 */
const FMZ_STATIC_OPT_EXTRA_COPIES = [
  ["server/fmz-static.mjs", "fmz-static.mjs"],
  ["shared/fmz-static.json", "fmz-static.json"],
];

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

/* ------------------------------------------------------------------ */
/*  server/*.mjs → release/<label>/opt/<fmz-*-server>/（与 /opt 对齐）   */
/* ------------------------------------------------------------------ */

const archivedOpt = [];
if (!skipOpt) {
  for (const bundle of OPT_RELEASE_BUNDLES) {
    if (!bundle.include(features)) continue;
    const destDir = join(target, "opt", bundle.remoteName);
    mkdirSync(destDir, { recursive: true });
    let ok = true;
    for (const [relFrom, baseName] of bundle.copies.concat(FMZ_STATIC_OPT_EXTRA_COPIES)) {
      const absFrom = join(root, relFrom);
      const absTo = join(destDir, baseName);
      if (!existsSync(absFrom)) {
        console.warn(`  [opt] ⚠️  跳过 ${bundle.remoteName}：缺少源文件 ${relFrom}`);
        ok = false;
        break;
      }
      copyFileSync(absFrom, absTo);
    }
    if (ok) {
      archivedOpt.push(bundle.remoteName);
      console.log(`  [opt] 已复制 → release/${label}/opt/${bundle.remoteName}/`);
    }
  }
  if (archivedOpt.length === 0) {
    console.log("\n  [opt] 当前发布特性未包含需归档的后端目录（或已全部跳过）。");
  }
} else {
  console.log("\n  [opt] 已使用 --skip-opt，跳过后端脚本归档。");
}

/* ------------------------------------------------------------------ */
/*  deploy/nginx|systemd 样例 → release/<label>/config/                */
/* ------------------------------------------------------------------ */

let archivedConfigDirs = false;
if (!skipConfig) {
  const cfgNginx = join(target, "config", "nginx");
  const cfgSystemd = join(target, "config", "systemd");
  const nginxPairs = [
    ["deploy/nginx-fmz-dashboard.conf", join(cfgNginx, "nginx-fmz-dashboard.conf")],
    ["deploy/nginx-fmz-dashboard-locations.inc", join(cfgNginx, "nginx-fmz-dashboard-locations.inc")],
  ];
  const systemdPairs = [
    ["deploy/fmz-ai-agent.service", join(cfgSystemd, "fmz-ai-agent.service")],
    ["deploy/fmz-danmaku.env.example", join(cfgSystemd, "fmz-danmaku.env.example")],
    [
      "deploy/fmz-danmaku.service.d-ai-report.conf.example",
      join(cfgSystemd, "fmz-danmaku.service.d-ai-report.conf.example"),
    ],
  ];
  let any = false;
  for (const [relSrc, absDest] of [...nginxPairs, ...systemdPairs]) {
    const absSrc = join(root, relSrc);
    if (!existsSync(absSrc)) continue;
    mkdirSync(dirname(absDest), { recursive: true });
    copyFileSync(absSrc, absDest);
    any = true;
  }
  if (any) {
    archivedConfigDirs = true;
    console.log(`  [config] 已复制 → release/${label}/config/{nginx,systemd}/`);
  }
  if (features.dreamBus === true && features.douyuDanmaku !== true) {
    const roomId = String(process.env.FMZ_DREAM_BUS_ROOM_ID || "9046690").trim();
    const danmakuEnvPath = join(target, "config", "danmaku.env");
    mkdirSync(dirname(danmakuEnvPath), { recursive: true });
    writeFileSync(
      danmakuEnvPath,
      [
        "# 由 pack-release 生成：窃听宝语关闭，fmz-danmaku 仅宝宝巴士",
        "FMZ_DANMAKU_MODE=dream-bus-only",
        `FMZ_DREAM_BUS_ROOM_ID=${roomId || "9046690"}`,
        "",
      ].join("\n"),
      "utf-8",
    );
    archivedConfigDirs = true;
    console.log(`  [config] 已生成 → release/${label}/config/danmaku.env（dream-bus-only）`);
  }
} else {
  console.log("\n  [config] 已使用 --skip-config，跳过 config/ 镜像（Nginx、systemd 样例）。");
}

const meta = [
  `release: ${label}`,
  `package.version: ${pkg.version}`,
  `packedAt: ${new Date().toISOString()}`,
  `enabledFeatures: ${enabledModules.join(", ") || "(none)"}`,
  `disabledFeatures: ${disabledModules.join(", ") || "(none)"}`,
  `archivedServerData: ${archivedData.length ? archivedData.join(", ") : "(none)"}`,
  `archivedOptServices: ${archivedOpt.length ? archivedOpt.join(", ") : "(none)"}`,
  `archivedConfigBundle: ${archivedConfigDirs ? "config/nginx,config/systemd" : "(none)"}`,
  "",
].join("\n");
writeFileSync(metaPath, meta, "utf-8");

const optHint = archivedOpt.length ? `、opt/${archivedOpt.length} 个后端目录` : "";
const cfgHint = archivedConfigDirs ? "、config/（Nginx/systemd）" : "";
console.log(`\n✅ 已打包到 release/${label}/（含 BUILD_INFO.txt${archivedData.length ? "、server/data" : ""}${optHint}${cfgHint}）`);
