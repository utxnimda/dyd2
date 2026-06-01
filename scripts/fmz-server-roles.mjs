/**
 * 多机角色：主站 (dianfanbao) / AI 网关 (tencent-43) 的 opt 过滤与 Nginx 上游生成。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVERS_JSON = join(root, "deploy", "servers.json");

/** @returns {Record<string, object>} */
export function readServersRegistry() {
  if (!existsSync(SERVERS_JSON)) return {};
  try {
    const data = JSON.parse(readFileSync(SERVERS_JSON, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/**
 * 主站 → 远端 AI 网关 HTTP 基址（不含尾斜杠）。
 * @param {string} [deployTargetId]
 */
export function resolveAiGateway(deployTargetId = "dianfanbao") {
  const registry = readServersRegistry();
  const preset = registry[deployTargetId];
  const gw = preset?.aiGateway;
  if (!gw?.target) return null;

  const remote = registry[gw.target];
  if (!remote?.host) return null;

  const host = String(remote.host).trim();
  const ports = gw.ports || {};
  const aiPort = Number(ports.aiAgent ?? 8792);
  const voicePort = Number(ports.voiceClone ?? 8793);

  return {
    targetId: gw.target,
    targetLabel: remote.label || host,
    host,
    aiAgentUrl: `http://${host}:${aiPort}`,
    voiceCloneUrl: `http://${host}:${voicePort}`,
    optSkipOnPrimary: Array.isArray(gw.optSkipOnPrimary)
      ? gw.optSkipOnPrimary
      : ["fmz-ai-agent-server"],
    optDeployOnGateway: Array.isArray(gw.optDeployOnGateway)
      ? gw.optDeployOnGateway
      : ["fmz-ai-agent-server", "fmz-voice-clone-server"],
  };
}

/**
 * @param {string} deployTargetId
 * @param {string[]} optDirs
 */
export function filterOptDirsForDeploy(deployTargetId, optDirs) {
  const registry = readServersRegistry();
  const preset = registry[deployTargetId];
  const role = preset?.role;

  if (role === "ai-gateway") {
    const allow = new Set(
      preset.optDeployOnGateway || ["fmz-ai-agent-server", "fmz-voice-clone-server"],
    );
    return optDirs.filter((d) => allow.has(d));
  }

  const gw = resolveAiGateway(deployTargetId);
  if (gw) {
    const skip = new Set(gw.optSkipOnPrimary);
    return optDirs.filter((d) => !skip.has(d));
  }

  return optDirs;
}

/**
 * @param {{ useRemote: boolean; gateway?: ReturnType<typeof resolveAiGateway> | null }} opts
 */
export function buildNginxRemoteUpstreamsConf(opts) {
  const gw = opts.gateway;
  const useRemote = opts.useRemote && gw;

  const aiPort = gw?.aiAgentUrl?.match(/:(\d+)$/)?.[1] || "8792";
  const voicePort = gw?.voiceCloneUrl?.match(/:(\d+)$/)?.[1] || "8793";
  const aiHost = useRemote ? `${gw.host}:${aiPort}` : "127.0.0.1:8792";
  const voiceHost = useRemote ? `${gw.host}:${voicePort}` : "127.0.0.1:8793";

  return `# 由 pack-release / deploy 生成；勿手改（改 deploy/servers.json 后重新 pack + deploy）
# useRemote=${useRemote ? "yes" : "no"}${useRemote ? ` → ${gw.host}（AI + Fish 音声）` : ""}
# 音频提取 /__fmz_audio 始终在主站 127.0.0.1:8789（见 nginx-fmz-dashboard-locations.inc）

upstream fmz_ai_agent_upstream {
    server ${aiHost};
    keepalive 8;
}

upstream fmz_voice_clone_upstream {
    server ${voiceHost};
    keepalive 4;
}
`;
}

/**
 * @param {string} absPath
 * @param {ReturnType<typeof resolveAiGateway> | null} gateway
 */
export function writeNginxRemoteUpstreamsConf(absPath, gateway) {
  const text = buildNginxRemoteUpstreamsConf({
    useRemote: !!gateway,
    gateway,
  });
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, text, "utf-8");
}

/** @param {string} absPath @param {string} secret */
export function writeNginxRemoteSecretInc(absPath, secret) {
  const val = String(secret || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const text = `# 由 deploy 生成（chmod 600）\nset $fmz_remote_service_secret "${val}";\n`;
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, text, "utf-8");
}

/**
 * @param {string} absPath
 * @param {ReturnType<typeof resolveAiGateway> | null} gateway
 */
export function writeDanmakuEnvAiRemote(absPath, gateway) {
  const lines = [
    "# 由 pack-release 根据 deploy/servers.json 生成（主站 AI 走远端网关）",
    ...(gateway
      ? [
          `AI_AGENT_INTERNAL_URL=${gateway.aiAgentUrl}`,
          "# 与远端 /etc/fmz-ai-gateway.env 中 FMZ_REMOTE_SERVICE_SECRET 一致（主站侧注入）",
          "# FMZ_REMOTE_SERVICE_SECRET=请写在 /opt/fmz-danmaku-server/danmaku.env 或 systemd EnvironmentFile",
        ]
      : [
          "# AI_AGENT_INTERNAL_URL=http://127.0.0.1:8792",
        ]),
    "",
  ];
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, lines.join("\n"), "utf-8");
}
