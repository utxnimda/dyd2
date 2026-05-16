/**
 * deploy.mjs — Automated deploy script for fmz-dashboard
 *
 * Uploads the latest release to the remote server and cleans up
 * stale asset files that are no longer referenced by the current build.
 *
 * Usage:
 *   node scripts/deploy.mjs            # deploy latest release label
 *   node scripts/deploy.mjs v1.1.20    # deploy a specific release label
 *
 * Steps performed:
 *   1. Read package.json to determine the release label
 *   2. Verify the release directory exists locally
 *   3. SCP upload assets/, index.html, BUILD_INFO.txt to remote
 *   4. SSH to remote: list assets/ files, diff against local release,
 *      delete any files not present in the current release
 *   5. SSH verify BUILD_INFO.txt on remote
 *
 * SSH/远端路径可由环境变量覆盖（与 deploy/deploy.local.env.example 一致；
 * PowerShell 可先执行 . ./deploy/load-deploy-env.ps1 加载 deploy.local.env）：
 *   FMZ_DEPLOY_SSH_KEY、FMZ_DEPLOY_SSH_USER、FMZ_DEPLOY_SSH_HOST、FMZ_DEPLOY_WEB_ROOT
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */
const SSH_KEY = (process.env.FMZ_DEPLOY_SSH_KEY || String.raw`D:\nimda1.pem`).trim();
const REMOTE_USER = (process.env.FMZ_DEPLOY_SSH_USER || "root").trim();
const REMOTE_HOST = (process.env.FMZ_DEPLOY_SSH_HOST || "118.195.150.4").trim();
const REMOTE_WEB_ROOT = (process.env.FMZ_DEPLOY_WEB_ROOT || "/var/www/fmz-dashboard").replace(
  /\/+$/,
  "",
);
const SSH_CMD = `ssh -i "${SSH_KEY}" ${REMOTE_USER}@${REMOTE_HOST}`;
const SCP_CMD = `scp -i "${SSH_KEY}"`;

if (!existsSync(SSH_KEY)) {
  console.error(`❌ SSH 私钥不存在: ${SSH_KEY}`);
  console.error(
    "   请放置密钥到该路径，或设置 FMZ_DEPLOY_SSH_KEY；"
      + "也可在 deploy/deploy.local.env 中填写后执行：. ./deploy/load-deploy-env.ps1",
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/*  Determine release label                                            */
/* ------------------------------------------------------------------ */
const explicitLabel = process.argv[2];
let label;

if (explicitLabel) {
  label = explicitLabel;
} else {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  label = String(pkg.fmzReleaseLabel ?? `v${pkg.version}`).trim() || "v0.0.0";
}

const releaseDir = join(root, "release", label);
const assetsDir = join(releaseDir, "assets");

console.log("");
console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║              🚀 远端部署（Remote Deploy）                ║");
console.log("╠══════════════════════════════════════════════════════════╣");
console.log(`║  版本: ${label.padEnd(48)}║`);
console.log(`║  远端: ${REMOTE_HOST}:${REMOTE_WEB_ROOT}`.padEnd(57) + "║");
console.log("╚══════════════════════════════════════════════════════════╝");
console.log("");

/* ------------------------------------------------------------------ */
/*  Verify local release exists                                        */
/* ------------------------------------------------------------------ */
if (!existsSync(releaseDir)) {
  console.error(`❌ 本地 release 目录不存在: release/${label}/`);
  console.error(`   请先执行 npm run pack`);
  process.exit(1);
}

if (!existsSync(join(releaseDir, "index.html"))) {
  console.error(`❌ release/${label}/index.html 不存在`);
  process.exit(1);
}

if (!existsSync(assetsDir)) {
  console.error(`❌ release/${label}/assets/ 不存在`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/*  Collect local asset filenames                                      */
/* ------------------------------------------------------------------ */
const localAssets = new Set(readdirSync(assetsDir));
console.log(`📦 本地 assets 文件数: ${localAssets.size}`);
for (const f of localAssets) {
  console.log(`   ${f}`);
}
console.log("");

/* ------------------------------------------------------------------ */
/*  Helper: run command and return stdout                               */
/* ------------------------------------------------------------------ */
function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: opts.silent ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "inherit"],
      ...opts,
    }).trim();
  } catch (e) {
    if (opts.ignoreError) return "";
    console.error(`\n❌ 命令执行失败: ${cmd}`);
    console.error(e.message);
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/*  Step 1: SCP upload                                                 */
/* ------------------------------------------------------------------ */
console.log("📤 上传文件到远端...");

// Upload assets/, index.html, BUILD_INFO.txt in one scp call
// IMPORTANT: use -r for assets dir, and upload all to the web root directly
const scpSources = [
  join(releaseDir, "assets"),
  join(releaseDir, "index.html"),
  join(releaseDir, "BUILD_INFO.txt"),
].map((p) => `"${p}"`).join(" ");

const scpTarget = `${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_WEB_ROOT}/`;
const uploadCmd = `${SCP_CMD} -r ${scpSources} ${scpTarget}`;

console.log(`   $ ${uploadCmd}`);
run(uploadCmd);
console.log("   ✅ 上传完成\n");

/* ------------------------------------------------------------------ */
/*  Step 2: Clean stale remote assets                                  */
/* ------------------------------------------------------------------ */
console.log("🧹 清理远端旧 assets 文件...");

// Get list of remote asset files
const remoteListRaw = run(
  `${SSH_CMD} "ls ${REMOTE_WEB_ROOT}/assets/"`,
  { silent: true }
);

if (!remoteListRaw) {
  console.log("   远端 assets 目录为空，无需清理\n");
} else {
  const remoteFiles = remoteListRaw.split("\n").map((s) => s.trim()).filter(Boolean);
  const staleFiles = remoteFiles.filter((f) => !localAssets.has(f));

  if (staleFiles.length === 0) {
    console.log(`   远端共 ${remoteFiles.length} 个文件，全部为当前版本所需，无需清理\n`);
  } else {
    console.log(`   远端共 ${remoteFiles.length} 个文件，其中 ${staleFiles.length} 个为旧版本残留：`);
    for (const f of staleFiles) {
      console.log(`     🗑️  ${f}`);
    }

    // Build a single rm command for all stale files
    const rmPaths = staleFiles
      .map((f) => `${REMOTE_WEB_ROOT}/assets/${f}`)
      .join(" ");
    run(`${SSH_CMD} "rm -f ${rmPaths}"`);

    console.log(`   ✅ 已删除 ${staleFiles.length} 个旧文件\n`);
  }
}

/* ------------------------------------------------------------------ */
/*  Step 3: Verify remote BUILD_INFO.txt                               */
/* ------------------------------------------------------------------ */
console.log("🔍 验证远端版本...");
const remoteBuildInfo = run(
  `${SSH_CMD} "cat ${REMOTE_WEB_ROOT}/BUILD_INFO.txt"`,
  { silent: true }
);
console.log("   远端 BUILD_INFO.txt:");
for (const line of remoteBuildInfo.split("\n")) {
  console.log(`   │ ${line}`);
}
console.log("");

// Verify remote assets count matches local
const remoteCountRaw = run(
  `${SSH_CMD} "ls ${REMOTE_WEB_ROOT}/assets/ | wc -l"`,
  { silent: true }
);
const remoteCount = parseInt(remoteCountRaw, 10);
if (remoteCount === localAssets.size) {
  console.log(`✅ 远端 assets 文件数 (${remoteCount}) 与本地一致`);
} else {
  console.log(`⚠️  远端 assets 文件数 (${remoteCount}) 与本地 (${localAssets.size}) 不一致，请检查`);
}

console.log("");
console.log("🎉 部署完成！");
console.log("");
