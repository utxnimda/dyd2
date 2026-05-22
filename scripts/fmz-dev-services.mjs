/**
 * 本地多服务定义：与 dev-all / fmz-dev 共用（features → 要拉起的后端 + 文件变更 → 影响哪些进程）。
 */
import { readFileSync } from "node:fs";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, "..");
const require = createRequire(import.meta.url);

/** Map feature keys to their required backend npm scripts（与 package.json scripts 一致） */
export const FEATURE_SERVICES = {
  sanguo: { name: "defense", script: "defense-tower-server", color: "blue" },
  audio: { name: "audio", script: "audio-server", color: "yellow" },
  quota: { name: "quota", script: "quota-server", color: "green" },
  crimes: { name: "crimes", script: "crimes-server", color: "red" },
  douyuDanmaku: { name: "danmaku", script: "danmaku-server", color: "white" },
  dreamBus: { name: "danmaku", script: "danmaku-server", color: "white" },
  aiAgent: { name: "ai-agent", script: "ai-agent-server", color: "gray" },
  voiceClone: { name: "voice-clone", script: "voice-clone-server", color: "magentaBright" },
  battle: { name: "reactions", script: "reactions-server", color: "cyan" },
  treasury: { name: "reactions", script: "reactions-server", color: "cyan" },
  users: { name: "reactions", script: "reactions-server", color: "cyan" },
  preliminary: { name: "reactions", script: "reactions-server", color: "cyan" },
};

/** 进程 id（写入 pids.json）→ 匹配 git 路径的正则（用于 restart-changed） */
export const SERVICE_FILE_WATCH = {
  reactions: [/^server\/reactions-server\.mjs$/, /^server\/package\.json$/, /^server\/package-lock\.json$/],
  defense: [/^server\/defense-tower-server\.mjs$/],
  audio: [/^server\/audio-extractor-server\.mjs$/],
  crimes: [/^server\/crimes-server\.mjs$/],
  danmaku: [/^server\/douyu-danmaku-server\.mjs$/],
  "ai-agent": [/^server\/ai-agent-server\.mjs$/, /^server\/gemini-openai-compat-chat-filter\.mjs$/],
  "voice-clone": [/^server\/voice-clone-server\.mjs$/],
  quota: [/^server\/quota-server\.cjs$/],
  vite: [/^vite\.config\./, /^src\//, /^public\//, /^index\.html$/],
};

export function readFeatures() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  return pkg.fmzFeatures || {};
}

function featureEnabled(features, key) {
  return features[key] === true || features[key] === "local";
}

/** 去重后的后端进程列表（不含 Vite） */
export function getEnabledBackendServices(features) {
  const map = new Map();
  for (const [feature, svc] of Object.entries(FEATURE_SERVICES)) {
    if (!featureEnabled(features, feature)) continue;
    map.set(svc.name, { id: svc.name, script: svc.script, color: svc.color });
  }
  return [...map.values()];
}

/** 托管启动完整列表：后端 + 始终带上的 Vite */
export function getSupervisedLaunchList(features) {
  return [...getEnabledBackendServices(features), { id: "vite", script: "dev", color: "magenta" }];
}

/** 给 concurrently 用的展开（与现 dev-all 一致） */
export function getConcurrentlySpecs(features) {
  const map = new Map();
  for (const [feature, svc] of Object.entries(FEATURE_SERVICES)) {
    if (!featureEnabled(features, feature)) continue;
    map.set(svc.name, svc);
  }
  const names = [...[...map.values()].map((s) => s.name), "vite"];
  const colors = [...[...map.values()].map((s) => s.color), "magenta"];
  const commands = [...[...map.values()].map((s) => `npm run ${s.script}`), "npm run dev"];
  return { names, colors, commands };
}

/** 子进程是否以退出码 0 结束（启动前自检） */
export function commandOk(command, args, env = process.env) {
  const r = spawnSync(command, args, {
    encoding: "utf-8",
    env,
    shell: process.platform === "win32",
    timeout: 12_000,
  });
  return r.status === 0;
}

/** 与 audio-extractor-server 一致：将 phantomjs-prebuilt 置于 PATH / Path 前部 */
export function envWithPhantomPrebuilt(base = process.env) {
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

/** fmzFeatures.audio 开启时的依赖自检 */
export function preflightAudioDeps(features) {
  if (!featureEnabled(features, "audio")) return;
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
      `[fmz-dev] 已启用 fmzFeatures.audio，但当前环境找不到：${missingCore.join("、")}`,
    );
    console.error("[fmz-dev] 可先安装后再运行（示例）： winget install yt-dlp ffmpeg");
    process.exit(1);
  }

  if (!phantomReady) {
    console.warn(
      "[fmz-dev] ⚠️  未检测到 phantomjs — B 站链接仍可试用；斗鱼点播可能受 Douyu 签名影响。\n"
        + "       在项目根执行 npm install（含 phantomjs-prebuilt）；audio 服务会自动把其加入 PATH。",
    );
    if (phantomPrebuiltMissing) {
      console.warn("[fmz-dev] ⚠️  node_modules 中尚无 phantomjs-prebuilt，请先执行 npm install");
    }
  }
}

/**
 * @param {string[]} files git 路径（/ 分隔）
 * @param {Set<string>} enabledIds 当前已托管的进程 id
 * @returns {Set<string>} 需要重启的 id（含 vite）
 */
export function matchFilesToRestartIds(files, enabledIds) {
  const normalized = files.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""));
  const matched = new Set();

  let restartAllBackends = false;
  let restartAll = false;

  outer: for (const f of normalized) {
    if (f === "package.json" || f === "package-lock.json") {
      restartAll = true;
      break;
    }
    if (f.startsWith("scripts/")) {
      continue;
    }

    let hit = false;
    for (const id of enabledIds) {
      const rules = SERVICE_FILE_WATCH[id];
      if (!rules) continue;
      for (const re of rules) {
        if (re.test(f)) {
          matched.add(id);
          hit = true;
        }
      }
    }

    if (!hit && f.startsWith("server/")) {
      restartAllBackends = true;
      break outer;
    }
  }

  if (restartAll) {
    for (const id of enabledIds) matched.add(id);
    return matched;
  }
  if (restartAllBackends) {
    for (const id of enabledIds) {
      if (id !== "vite") matched.add(id);
    }
  }
  return matched;
}
