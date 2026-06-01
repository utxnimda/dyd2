/**
 * 将本机 AI / Fish 密钥同步到网关机 43.160.205.247（/etc/fmz-ai-gateway.env + /opt/.../data/）。
 * 不打印密钥内容。依赖 deploy/deploy.local.env 中的 FMZ_REMOTE_SERVICE_SECRET（无则自动生成并写回）。
 */
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeployLocalEnvOptional, resolveDeployConfig } from "./fmz-deploy-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY_LOCAL_ENV = join(root, "deploy", "deploy.local.env");
const LOCAL_AI_ENV = join(root, "server", "local-ai-agent.env");
const AI_KEYS_JSON = join(root, "server", "data", "ai-agent-keys.json");
const VOICE_KEYS_JSON = join(root, "server", "data", "voice-clone-keys.json");
const STAGING_ENV = join(root, "deploy", ".fmz-ai-gateway.env.staging");

const KEY_MAP = [
  ["GEMINI_API_KEY", "gemini"],
  ["OPENAI_API_KEY", "openai"],
  ["DASHSCOPE_API_KEY", "qwen"],
  ["QWEN_API_KEY", "qwen"],
  ["FISH_AUDIO_API_KEY", "fishAudio"],
];

function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf-8").split(/\n/)) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"'))
      || (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

function ensureRemoteSecret() {
  loadDeployLocalEnvOptional(root);
  let secret = (process.env.FMZ_REMOTE_SERVICE_SECRET || "").trim();
  if (secret) return secret;

  secret = randomBytes(32).toString("hex");
  const line = `FMZ_REMOTE_SERVICE_SECRET=${secret}`;
  let body = existsSync(DEPLOY_LOCAL_ENV) ? readFileSync(DEPLOY_LOCAL_ENV, "utf-8") : "";
  if (!body.includes("FMZ_REMOTE_SERVICE_SECRET=")) {
    if (body.length && !body.endsWith("\n")) body += "\n";
    body += `${line}\n`;
    writeFileSync(DEPLOY_LOCAL_ENV, body, "utf-8");
    console.log(`[sync-ai-gateway] 已在 deploy/deploy.local.env 写入 FMZ_REMOTE_SERVICE_SECRET（新生成）`);
  }
  process.env.FMZ_REMOTE_SERVICE_SECRET = secret;
  return secret;
}

function buildGatewayEnv(secret) {
  const lines = [
    "# 由 scripts/sync-ai-gateway-remote.mjs 从本机生成，勿提交 Git",
    `FMZ_REMOTE_SERVICE_SECRET=${secret}`,
    "FMZ_SERVICE_BIND_HOST=0.0.0.0",
    "AI_AGENT_BIND_HOST=0.0.0.0",
  ];
  const fromLocal = parseEnvFile(LOCAL_AI_ENV);
  const passthrough = [
    "FMZ_AI_AGENT_LOCAL_PROXY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "FMZ_AI_AGENT_HTTPS_PROXY",
    "FMZ_AI_AGENT_HTTP_PROXY",
    "OPENAI_BASE_URL",
    "QWEN_BASE_URL",
    "FISH_AUDIO_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "DASHSCOPE_API_KEY",
    "QWEN_API_KEY",
  ];
  for (const k of passthrough) {
    const v = (fromLocal[k] || "").trim();
    if (v) lines.push(`${k}=${v}`);
  }
  let fileKeys = {};
  if (existsSync(AI_KEYS_JSON)) {
    try {
      fileKeys = JSON.parse(readFileSync(AI_KEYS_JSON, "utf-8").replace(/^\uFEFF/, ""));
    } catch {
      /* ignore */
    }
  }
  for (const [envName, jsonField] of KEY_MAP) {
    if (lines.some((l) => l.startsWith(`${envName}=`))) continue;
    const v = typeof fileKeys[jsonField] === "string" ? fileKeys[jsonField].trim() : "";
    if (v) lines.push(`${envName}=${v}`);
  }
  let voiceKeys = {};
  if (existsSync(VOICE_KEYS_JSON)) {
    try {
      voiceKeys = JSON.parse(readFileSync(VOICE_KEYS_JSON, "utf-8").replace(/^\uFEFF/, ""));
    } catch {
      /* ignore */
    }
  }
  if (!lines.some((l) => l.startsWith("FISH_AUDIO_API_KEY="))) {
    const fish = typeof voiceKeys.fishAudio === "string" ? voiceKeys.fishAudio.trim() : "";
    if (fish) lines.push(`FISH_AUDIO_API_KEY=${fish}`);
  }
  lines.push("");
  return lines.join("\n");
}

function run(cmd) {
  console.log(`$ ${cmd.replace(/FMZ_REMOTE_SERVICE_SECRET=\S+/g, "FMZ_REMOTE_SERVICE_SECRET=***")}`);
  execSync(cmd, { stdio: "inherit", cwd: root });
}

const secret = ensureRemoteSecret();
const cfg = resolveDeployConfig({ rootDir: root, targetId: "tencent-43" });
const { sshKey: SSH_KEY, remoteUser: USER, remoteHost: HOST } = cfg;
const SSH = `ssh -i "${SSH_KEY}" ${USER}@${HOST}`;
const SCP = `scp -i "${SSH_KEY}"`;

mkdirSync(dirname(STAGING_ENV), { recursive: true });
writeFileSync(STAGING_ENV, buildGatewayEnv(secret), "utf-8");
console.log(`[sync-ai-gateway] 已生成本地 staging → deploy/.fmz-ai-gateway.env.staging`);

run(`${SCP} "${STAGING_ENV}" ${USER}@${HOST}:/tmp/fmz-ai-gateway.env`);
run(
  `${SSH} "install -d -m 700 /opt/fmz-ai-agent-server/data /opt/fmz-voice-clone-server/data/voice-clone && mv /tmp/fmz-ai-gateway.env /etc/fmz-ai-gateway.env && chmod 600 /etc/fmz-ai-gateway.env"`,
);

if (existsSync(AI_KEYS_JSON)) {
  run(`${SCP} "${AI_KEYS_JSON}" ${USER}@${HOST}:/opt/fmz-ai-agent-server/data/ai-agent-keys.json`);
  run(`${SSH} "chmod 600 /opt/fmz-ai-agent-server/data/ai-agent-keys.json"`);
  console.log("[sync-ai-gateway] 已上传 ai-agent-keys.json → /opt/fmz-ai-agent-server/data/");
}

if (existsSync(LOCAL_AI_ENV)) {
  run(`${SCP} "${LOCAL_AI_ENV}" ${USER}@${HOST}:/opt/fmz-ai-agent-server/local-ai-agent.env`);
  run(`${SSH} "chmod 600 /opt/fmz-ai-agent-server/local-ai-agent.env"`);
}

if (existsSync(VOICE_KEYS_JSON)) {
  run(
    `${SCP} "${VOICE_KEYS_JSON}" ${USER}@${HOST}:/opt/fmz-voice-clone-server/data/voice-clone-keys.json`,
  );
  run(`${SSH} "chmod 600 /opt/fmz-voice-clone-server/data/voice-clone-keys.json"`);
} else if (existsSync(AI_KEYS_JSON)) {
  const j = JSON.parse(readFileSync(AI_KEYS_JSON, "utf-8"));
  if (typeof j.fishAudio === "string" && j.fishAudio.trim()) {
    const tmp = join(root, "deploy", ".voice-clone-keys.staging.json");
    writeFileSync(tmp, JSON.stringify({ fishAudio: j.fishAudio.trim() }, null, 2), "utf-8");
    run(`${SCP} "${tmp}" ${USER}@${HOST}:/opt/fmz-voice-clone-server/data/voice-clone-keys.json`);
    run(`${SSH} "chmod 600 /opt/fmz-voice-clone-server/data/voice-clone-keys.json"`);
  }
}

console.log("[sync-ai-gateway] 网关机 /etc/fmz-ai-gateway.env 与密钥文件已更新。");
console.log("[sync-ai-gateway] 若尚未部署 systemd 单元，请先 deploy --target=tencent-43 再 systemctl restart fmz-ai-agent fmz-voice-clone");
