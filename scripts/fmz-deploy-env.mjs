/**
 * 本机部署 SSH 配置：加载 deploy.local.env，并按 FMZ_DEPLOY_TARGET 解析 deploy/servers.json。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVERS_JSON = join(root, "deploy", "servers.json");

/** @param {string} rootDir */
export function loadDeployLocalEnvOptional(rootDir = root) {
  const p = join(rootDir, "deploy", "deploy.local.env");
  if (!existsSync(p)) return;
  const txt = readFileSync(p, "utf-8");
  for (const raw of txt.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

/** @returns {Record<string, { label?: string; host: string; key: string; user?: string; webRoot?: string }>} */
function readServersRegistry() {
  if (!existsSync(SERVERS_JSON)) return {};
  try {
    const data = JSON.parse(readFileSync(SERVERS_JSON, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/** @param {string} keyPath @param {string} rootDir */
function resolveKeyPath(keyPath, rootDir) {
  const trimmed = keyPath.trim();
  if (!trimmed) return trimmed;
  return isAbsolute(trimmed) ? trimmed : resolve(rootDir, trimmed);
}

/**
 * @param {{ rootDir?: string; targetId?: string }} [opts]
 */
export function resolveDeployConfig(opts = {}) {
  const rootDir = opts.rootDir ?? root;
  loadDeployLocalEnvOptional(rootDir);

  const registry = readServersRegistry();
  const targetId = (opts.targetId ?? process.env.FMZ_DEPLOY_TARGET ?? "dianfanbao").trim();
  const preset = registry[targetId];

  if (targetId && !preset && Object.keys(registry).length > 0) {
    const known = Object.keys(registry).join(", ");
    throw new Error(`未知 FMZ_DEPLOY_TARGET="${targetId}"，可选：${known}`);
  }

  const sshKey = resolveKeyPath(
    (process.env.FMZ_DEPLOY_SSH_KEY || preset?.key || "token/118.195.150.4.pem").trim(),
    rootDir,
  );
  const remoteUser = (process.env.FMZ_DEPLOY_SSH_USER || preset?.user || "root").trim();
  const remoteHost = (process.env.FMZ_DEPLOY_SSH_HOST || preset?.host || "118.195.150.4").trim();
  const webRoot = (
    process.env.FMZ_DEPLOY_WEB_ROOT || preset?.webRoot || "/var/www/fmz-dashboard"
  )
    .trim()
    .replace(/\/+$/, "");

  const role = typeof preset?.role === "string" ? preset.role.trim() : "";
  const deployStatic =
    process.env.FMZ_DEPLOY_STATIC === "1"
    || (preset?.deployStatic !== false && role !== "ai-gateway");

  return {
    targetId,
    targetLabel: preset?.label ?? remoteHost,
    role,
    deployStatic,
    sshKey,
    remoteUser,
    remoteHost,
    webRoot,
  };
}

/** 从 argv 解析 --target=xxx */
export function parseDeployTargetArg(argv = process.argv.slice(2)) {
  const hit = argv.find((a) => a.startsWith("--target="));
  return hit ? hit.slice("--target=".length).trim() : "";
}

/** 去掉 --target= 后的 argv（供 deploy 版本号参数） */
export function stripDeployCliFlags(argv = process.argv.slice(2)) {
  return argv.filter((a) => !a.startsWith("--target="));
}

function isCliMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isCliMain() && process.argv.includes("--print-env")) {
  const targetArg = parseDeployTargetArg(process.argv.slice(2));
  const cfg = resolveDeployConfig({ targetId: targetArg || undefined });
  const lines = [
    ["FMZ_DEPLOY_TARGET", cfg.targetId],
    ["FMZ_DEPLOY_SSH_KEY", cfg.sshKey],
    ["FMZ_DEPLOY_SSH_USER", cfg.remoteUser],
    ["FMZ_DEPLOY_SSH_HOST", cfg.remoteHost],
    ["FMZ_DEPLOY_WEB_ROOT", cfg.webRoot],
  ];
  for (const [k, v] of lines) process.stdout.write(`${k}=${v}\n`);
}
