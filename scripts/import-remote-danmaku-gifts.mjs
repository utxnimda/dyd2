/**
 * 将远端弹幕服务目录下的归档同步到本机（SCP）：
 *   远端：<FMZ_REMOTE_DANMAKU_DATA>/{gifts,records}/  （默认 …/data/danmaku）
 *   本地：<repo>/server/data/danmaku/{gifts,records}/
 *
 * 会先读取 deploy/deploy.local.env（若有）注入环境变量，与 npm run deploy 使用同一套
 * FMZ_DEPLOY_SSH_KEY / FMZ_DEPLOY_SSH_USER / FMZ_DEPLOY_SSH_HOST。
 *
 * 用法：
 *   npm run import:remote-danmaku-gifts
 *   npm run import:remote-danmaku-data
 *   node scripts/import-remote-danmaku-gifts.mjs --dry-run
 *   node scripts/import-remote-danmaku-gifts.mjs --only=gifts
 *   node scripts/import-remote-danmaku-gifts.mjs --only=records
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDeployConfig } from "./fmz-deploy-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** `scp -r remote:…/danmaku/<leaf>` 写入本机 danmaku 下同名目录 */
const LOCAL_DANMAKU_DIR = join(root, "server", "data", "danmaku");

let deployCfg;
try {
  deployCfg = resolveDeployConfig({ rootDir: root });
} catch (e) {
  console.error(`❌ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}

const dryRun =
  process.argv.includes("--dry-run") || /^1|true$/i.test(process.env.FMZ_IMPORT_DRY_RUN || "");

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const onlyRaw = onlyArg ? onlyArg.slice("--only=".length).trim().toLowerCase() : "both";
const mode = ["gifts", "records", "both"].includes(onlyRaw) ? onlyRaw : null;
if (!mode) {
  console.error("❌ --only= 只能是 gifts | records | both");
  process.exit(1);
}

const { sshKey: SSH_KEY, remoteUser: REMOTE_USER, remoteHost: REMOTE_HOST } = deployCfg;
const REMOTE_DANMAKU_DATA = (
  process.env.FMZ_REMOTE_DANMAKU_DATA || "/opt/fmz-danmaku-server/data/danmaku"
).replace(/\/+$/, "");

if (!REMOTE_HOST || !REMOTE_USER) {
  console.error("❌ FMZ_DEPLOY_SSH_HOST / FMZ_DEPLOY_SSH_USER 不能为空");
  process.exit(1);
}
if (!existsSync(SSH_KEY)) {
  console.error(`❌ SSH 私钥不存在: ${SSH_KEY}`);
  console.error("   可在 deploy/deploy.local.env 填写 FMZ_DEPLOY_SSH_KEY，或导出该变量后重试。");
  process.exit(1);
}

mkdirSync(join(root, "server", "data"), { recursive: true });
mkdirSync(LOCAL_DANMAKU_DIR, { recursive: true });

const dest = LOCAL_DANMAKU_DIR;

/**
 * @param {"gifts"|"records"} leaf
 * @param {string} labelZh
 */
function buildScpCmd(leaf, labelZh) {
  const remotePath = `${REMOTE_DANMAKU_DATA}/${leaf}`;
  const src = `${REMOTE_USER}@${REMOTE_HOST}:${remotePath}`;
  const cmd = `scp -o StrictHostKeyChecking=accept-new -r -i "${SSH_KEY}" "${src}" "${dest}"`;
  return { cmd, src, labelZh, leaf };
}

const jobs =
  mode === "both"
    ? [
        buildScpCmd("gifts", "礼物归档 gifts"),
        buildScpCmd("records", "弹幕归档 records"),
      ]
    : mode === "gifts"
      ? [buildScpCmd("gifts", "礼物归档 gifts")]
      : [buildScpCmd("records", "弹幕归档 records")];

console.log("");
console.log("╔════════════════════════════════════════════════════════════╗");
console.log(
  `║  远端弹幕数据 → 本地 server/data/danmaku/   mode=${mode.padEnd(8)}       ║`,
);
console.log("╚════════════════════════════════════════════════════════════╝");
console.log(`  远端根: ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DANMAKU_DATA}`);
console.log(`  本地父目录: ${dest}`);
for (const j of jobs) {
  console.log(`  · ${j.labelZh}: ${j.src}`);
}

if (dryRun) {
  console.log("");
  console.log("--dry-run，未执行：");
  for (const j of jobs) console.log(j.cmd);
  process.exit(0);
}

console.log("");
for (const j of jobs) {
  console.log(`── ${j.labelZh} ──`);
  try {
    execSync(j.cmd, { stdio: "inherit", cwd: root });
  } catch {
    console.error("");
    console.error(
      `❌ scp 失败（${j.labelZh}）。检查：远端是否存在 ${REMOTE_DANMAKU_DATA}/${j.leaf}、权限、SSH 与网络。`,
    );
    process.exit(1);
  }
}

console.log("");
console.log(
  "✅ 同步完成。若弹幕服务在读旧缓存，执行：npm run dev:services:stop && npm run dev:services:start（或重启 danmaku-server）",
);
