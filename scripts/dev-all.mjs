/**
 * dev-all.mjs — Start dev server + only the backend services required by enabled features.
 * Reads `fmzFeatures` from package.json to decide which services to launch.
 */
import { readFileSync } from "node:fs";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const features = pkg.fmzFeatures || {};
const require = createRequire(import.meta.url);

/** 子进程是否以退出码 0 结束（启动前自检） */
function commandOk(command, args, env = process.env) {
  const r = spawnSync(command, args, {
    encoding: "utf-8",
    env,
    shell: process.platform === "win32",
    timeout: 12_000,
  });
  return r.status === 0;
}

/** 与 audio-extractor-server 一致：将 phantomjs-prebuilt 置于 PATH / Path 前部 */
function envWithPhantomPrebuilt(base = process.env) {
  try {
    const dir = path.dirname(require("phantomjs-prebuilt").path);
    const sep = path.delimiter;
    const cur = base.PATH || base.Path || "";
    const norm = path.normalize(dir);
    if (cur.split(sep).some((p) => path.normalize(p) === norm)) return base;
    const prep = `${dir}${sep}${cur}`;
    return { ...base, PATH: prep, Path: prep };
  } catch {
    return base;
  }
}

/** fmzFeatures.audio 开启时的依赖自检（斗鱼 yt-dlp 另需 phantomjs） */
function preflightAudioDeps() {
  const missingCore = [];
  if (!commandOk("yt-dlp", ["--version"])) missingCore.push("yt-dlp");
  if (!commandOk("ffmpeg", ["-version"])) missingCore.push("ffmpeg");

  const phantomReady = commandOk("phantomjs", ["--version"], envWithPhantomPrebuilt());

  let phantomPrebuiltMissing = false;
  try {
    require.resolve("phantomjs-prebuilt/package.json");
  } catch {
    phantomPrebuiltMissing = true;
  }

  if (missingCore.length > 0) {
    console.error(
      `[dev-all] 已在 package.json 中启用 fmzFeatures.audio，但当前环境找不到：${missingCore.join("、")}`,
    );
    console.error("[dev-all] 音频提取不可用。可先安装后再运行（示例）： winget install yt-dlp ffmpeg");
    console.error("[dev-all] 安装后重新打开终端，以便 PATH 生效。");
    process.exit(1);
  }

  if (!phantomReady) {
    console.warn(
      "[dev-all] ⚠️  未检测到 phantomjs — B 站链接仍可试用；斗鱼点播会因 yt-dlp DouyuShow 签名报错。"
      + "\n       在项目根目录执行 npm install（会安装 phantomjs-prebuilt），audio-server 会把它加入 PATH。",
    );
    if (phantomPrebuiltMissing) {
      console.warn("[dev-all] ⚠️  node_modules 中尚无 phantomjs-prebuilt，请先执行 npm install");
    }
  }
}

// Map feature keys to their required backend npm scripts
const FEATURE_SERVICES = {
  sanguo: { name: "defense", script: "defense-tower-server", color: "blue" },
  audio: { name: "audio", script: "audio-server", color: "yellow" },
  quota: { name: "quota", script: "quota-server", color: "green" },
  crimes: { name: "crimes", script: "crimes-server", color: "red" },
  douyuDanmaku: { name: "danmaku", script: "danmaku-server", color: "white" },
  // reactions server is needed by battle/treasury/users/preliminary
  battle: { name: "reactions", script: "reactions-server", color: "cyan" },
  treasury: { name: "reactions", script: "reactions-server", color: "cyan" },
  users: { name: "reactions", script: "reactions-server", color: "cyan" },
  preliminary: { name: "reactions", script: "reactions-server", color: "cyan" },
};

const servicesToStart = new Map(); // dedup by name
for (const [feature, svc] of Object.entries(FEATURE_SERVICES)) {
  // "local" and true both count as enabled for dev
  if (features[feature] === true || features[feature] === "local") {
    servicesToStart.set(svc.name, svc);
  }
}

// Always start vite
const names = [...[...servicesToStart.values()].map((s) => s.name), "vite"];
const colors = [...[...servicesToStart.values()].map((s) => s.color), "magenta"];
const commands = [
  ...[...servicesToStart.values()].map((s) => `npm run ${s.script}`),
  "npm run dev",
];

const concurrentlyArgs = [
  "-n", names.join(","),
  "-c", colors.join(","),
  ...commands.map((c) => JSON.stringify(c)),
];

if (features.audio === true || features.audio === "local") {
  preflightAudioDeps();
}

console.log(`[dev-all] Enabled features: ${Object.entries(features).filter(([,v]) => v === true || v === "local").map(([k]) => k).join(", ")}`);
console.log(`[dev-all] Starting services: ${names.join(", ")}`);

const child = spawn("npx", ["concurrently", ...concurrentlyArgs], {
  cwd: join(__dirname, ".."),
  stdio: "inherit",
  shell: true,
});

child.on("exit", (code) => process.exit(code ?? 0));
