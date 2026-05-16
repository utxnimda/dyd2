/**
 * 托管本地进程：分别拉起 Vite + 各后端，写入 PID；支持一键全停、按 git 变更选择性重启。
 *
 *   npm run dev:services:start           启动（与 fmzFeatures 一致的全部服务）
 *   npm run dev:services:stop            关闭全部
 *   npm run dev:services:restart-changed  仅重启「工作区相对 HEAD 有改动」所影响到的进程
 *   npm run dev:services:status          查看 PID 与日志路径
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
  appendFileSync,
} from "node:fs";
import { spawn, spawnSync, execSync } from "node:child_process";
import { join } from "node:path";
import {
  ROOT,
  readFeatures,
  getSupervisedLaunchList,
  preflightAudioDeps,
  matchFilesToRestartIds,
  envWithPhantomPrebuilt,
} from "./fmz-dev-services.mjs";

const STATE_DIR = join(ROOT, ".fmz-dev");
const STATE_FILE = join(STATE_DIR, "pids.json");
const LOG_DIR = join(STATE_DIR, "logs");

function readState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function writeState(obj) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), "utf-8");
}

function clearState() {
  try {
    unlinkSync(STATE_FILE);
  } catch {
    /* */
  }
}

function isAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* */
      }
    }
  }
}

function pruneDeadPids(state) {
  const next = {};
  let changed = false;
  for (const [id, pid] of Object.entries(state)) {
    if (isAlive(pid)) next[id] = pid;
    else changed = true;
  }
  if (changed && Object.keys(next).length === 0) clearState();
  else if (changed) writeState(next);
  return next;
}

function getChangedGitPaths() {
  const paths = new Set();
  try {
    const diff = execSync("git diff --name-only HEAD", {
      encoding: "utf-8",
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    for (const line of diff.split("\n")) {
      if (line) paths.add(line.trim().replace(/\\/g, "/"));
    }
  } catch {
    console.warn("[fmz-dev] 无法执行 git diff，将视为「无变更文件列表」（可改用全停后重新 start）");
  }
  try {
    const st = execSync("git status --porcelain -u", {
      encoding: "utf-8",
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    for (const line of st.split("\n")) {
      if (line.startsWith("?? ")) {
        paths.add(line.slice(3).trim().replace(/\\/g, "/"));
      }
    }
  } catch {
    /* */
  }
  return [...paths];
}

function spawnService(svc, baseEnv) {
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `${svc.id}.log`);
  const stamp = `\n\n======== ${new Date().toISOString()} npm run ${svc.script} ========\n`;
  appendFileSync(logPath, stamp, "utf8");

  const outFd = openSync(logPath, "a");
  const errFd = openSync(logPath, "a");
  const child = spawn("npm", ["run", svc.script], {
    cwd: ROOT,
    env: baseEnv,
    shell: true,
    detached: true,
    stdio: ["ignore", outFd, errFd],
  });
  closeSync(outFd);
  closeSync(errFd);
  child.unref();
  return { pid: child.pid, logPath };
}

function cmdStart() {
  const features = readFeatures();
  preflightAudioDeps(features);

  let state = readState();
  state = pruneDeadPids(state);
  const linger = Object.entries(state).filter(([, p]) => isAlive(p));
  if (linger.length > 0) {
    console.error("[fmz-dev] 检测到仍在运行的托管进程：");
    for (const [id, pid] of linger) console.error(`  ${id}  pid=${pid}`);
    console.error("[fmz-dev] 请先执行: npm run dev:services:stop");
    process.exit(1);
  }
  clearState();

  const list = getSupervisedLaunchList(features);
  const baseEnv =
    features.audio === true || features.audio === "local"
      ? envWithPhantomPrebuilt(process.env)
      : process.env;

  console.log(
    `[fmz-dev] 将启动: ${list.map((s) => s.id).join(", ")}（日志目录 .fmz-dev/logs/）`,
  );

  const newState = {};
  for (const svc of list) {
    const { pid, logPath } = spawnService(svc, baseEnv);
    newState[svc.id] = pid;
    console.log(`[fmz-dev] ✓ ${svc.id} pid=${pid}  →  ${logPath}`);
  }
  writeState(newState);
  console.log("[fmz-dev] 完成。停止全部请执行: npm run dev:services:stop");
}

function cmdStop() {
  const state = readState();
  const ids = Object.keys(state);
  if (ids.length === 0) {
    console.log("[fmz-dev] 无记录的托管进程（pids.json 为空或已清理）");
    return;
  }
  for (const id of ids) {
    const pid = state[id];
    console.log(`[fmz-dev] 结束 ${id} pid=${pid}…`);
    killTree(pid);
  }
  clearState();
  console.log("[fmz-dev] 已全部尝试结束（含子进程树）");
}

function cmdStatus() {
  const state = readState();
  if (Object.keys(state).length === 0) {
    console.log("[fmz-dev] 当前无 pids.json 或未启动");
    return;
  }
  for (const [id, pid] of Object.entries(state)) {
    const ok = isAlive(pid);
    const logPath = join(LOG_DIR, `${id}.log`);
    console.log(`[fmz-dev] ${id}\tpid=${pid}\t${ok ? "运行中" : "无响应/已退出"}\t${logPath}`);
  }
}

function cmdRestartChanged() {
  const state = readState();
  const aliveIds = new Set(
    Object.entries(state)
      .filter(([, p]) => isAlive(p))
      .map(([id]) => id),
  );
  if (aliveIds.size === 0) {
    console.log("[fmz-dev] 没有运行中的托管进程。可直接: npm run dev:services:start");
    return;
  }

  const files = getChangedGitPaths();
  if (files.length === 0) {
    console.log("[fmz-dev] 未发现相对 HEAD 的变更（含未跟踪文件），跳过重启");
    return;
  }

  const toRestart = matchFilesToRestartIds(files, aliveIds);
  if (toRestart.size === 0) {
    console.log(
      `[fmz-dev] 本次变更未映射到运行中的服务，跳过。\n  变更文件示例: ${files.slice(0, 8).join(", ")}${files.length > 8 ? "…" : ""}`,
    );
    return;
  }

  const features = readFeatures();
  const baseEnv =
    features.audio === true || features.audio === "local"
      ? envWithPhantomPrebuilt(process.env)
      : process.env;

  const launchById = new Map(getSupervisedLaunchList(features).map((s) => [s.id, s]));
  const nextState = { ...state };

  for (const id of toRestart) {
    if (!aliveIds.has(id)) continue;
    const pid = state[id];
    const spec = launchById.get(id);
    if (!spec) {
      console.warn(`[fmz-dev] 跳过 ${id}：当前 fmzFeatures 未启用对应后端`);
      continue;
    }
    console.log(`[fmz-dev] 重启 ${id}（原 pid=${pid}）…`);
    killTree(pid);
    const { pid: newPid, logPath } = spawnService(spec, baseEnv);
    nextState[id] = newPid;
    console.log(`[fmz-dev] ✓ ${id} 新 pid=${newPid}  →  ${logPath}`);
  }

  writeState(nextState);
  console.log("[fmz-dev] 选择性重启完成");
}

function printHelp() {
  console.log(`用法:
  npm run dev:services:start             启动全部（Vite + 已启用特性的后端）
  npm run dev:services:stop              关闭全部托管进程
  npm run dev:services:restart-changed   仅重启与 git 工作区变更相关的进程
  npm run dev:services:status            查看 PID 与日志

说明:
  - PID 保存在 .fmz-dev/pids.json；标准输出写入 .fmz-dev/logs/<id>.log
  - restart-changed 依据: git diff HEAD + 未跟踪文件；根目录 package.json / package-lock 变更会重启全部托管项
  - 若需在单终端彩色前缀，请仍使用 npm run dev:all（concurrently），二者不要同时开两套
`);
}

const cmd = process.argv[2];
switch (cmd) {
  case "start":
    cmdStart();
    break;
  case "stop":
    cmdStop();
    break;
  case "restart-changed":
    cmdRestartChanged();
    break;
  case "status":
    cmdStatus();
    break;
  default:
    printHelp();
    if (cmd && cmd !== "help" && cmd !== "-h") process.exitCode = 1;
}
