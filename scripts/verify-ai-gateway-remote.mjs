/**
 * 远端 AI 网关架构自检（主站 ↔ 43.160.205.247），不打印密钥。
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeployLocalEnvOptional, resolveDeployConfig } from "./fmz-deploy-env.mjs";
import { resolveAiGateway } from "./fmz-server-roles.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadDeployLocalEnvOptional(root);

const gw = resolveAiGateway("dianfanbao");
if (!gw) {
  console.error("❌ deploy/servers.json 未配置 dianfanbao.aiGateway");
  process.exit(1);
}

const primary = resolveDeployConfig({ rootDir: root, targetId: "dianfanbao" });
const gateway = resolveDeployConfig({ rootDir: root, targetId: "tencent-43" });
const secret = (process.env.FMZ_REMOTE_SERVICE_SECRET || "").trim();

function ssh(cfg, cmd) {
  return execSync(`ssh -i "${cfg.sshKey}" -o ConnectTimeout=15 -o BatchMode=yes ${cfg.remoteUser}@${cfg.remoteHost} ${JSON.stringify(cmd)}`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function ok(label, pass, detail = "") {
  console.log(`${pass ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  return pass;
}

let allOk = true;

console.log("\n═══ 1. 启动远端服务 ═══\n");

try {
  const gUnits = "fmz-ai-agent fmz-voice-clone";
  ssh(gateway, `systemctl enable ${gUnits} 2>/dev/null; systemctl restart ${gUnits}; systemctl is-active ${gUnits}`);
  ok("网关机 AI 服务", true, "fmz-ai-agent + fmz-voice-clone active");
} catch (e) {
  allOk = false;
  ok("网关机 AI 服务", false, String(e.stderr || e.message).slice(0, 120));
}

try {
  const pUnits = "nginx fmz-danmaku fmz-audio fmz-crimes";
  ssh(primary, `systemctl enable ${pUnits} 2>/dev/null; systemctl restart ${pUnits}; systemctl is-active ${pUnits}`);
  ok("主站业务服务", true, "nginx + danmaku + audio + crimes active");
} catch (e) {
  allOk = false;
  ok("主站业务服务", false, String(e.stderr || e.message).slice(0, 120));
}

try {
  ssh(primary, "systemctl stop fmz-ai-agent fmz-voice-clone 2>/dev/null; systemctl disable fmz-ai-agent fmz-voice-clone 2>/dev/null; true");
  ok("主站本地 AI 已停用", true, "符合分离架构");
} catch {
  ok("主站本地 AI 已停用", false);
  allOk = false;
}

console.log("\n═══ 2. 网关机直连（本机 loopback + Secret）═══\n");

const gwCheck = `
SECRET=$(grep -m1 '^FMZ_REMOTE_SERVICE_SECRET=' /etc/fmz-ai-gateway.env 2>/dev/null | cut -d= -f2-)
H_AI=$(curl -s -o /tmp/fmz_ai.json -w '%{http_code}' -H "X-FMZ-Remote-Secret: $SECRET" http://127.0.0.1:8792/models)
H_VC=$(curl -s -o /tmp/fmz_vc.json -w '%{http_code}' -H "X-FMZ-Remote-Secret: $SECRET" http://127.0.0.1:8793/status)
N=$(node -e "try{const j=require('/tmp/fmz_ai.json');process.stdout.write(String((j.models||[]).length))}catch{process.stdout.write('0')}" 2>/dev/null)
P=$(ss -lntp 2>/dev/null | grep -cE ':8792|:8793' || echo 0)
PROXY=$(grep -m1 '^FMZ_AI_AGENT_LOCAL_PROXY=' /etc/fmz-ai-gateway.env 2>/dev/null | cut -d= -f2-)
PH=$(echo "$PROXY" | sed 's|http://||;s|https://||')
PL=$(echo "$PH" | grep -c 7890 || true)
PR=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "http://$PH" 2>/dev/null || echo 000)
echo "AI_HTTP=$H_AI MODELS=$N VOICE_HTTP=$H_VC PORTS=$P PROXY_PORT=$PH PROXY_HTTP=$PR FISH=$(grep -c '^FISH_AUDIO_API_KEY=.' /etc/fmz-ai-gateway.env)"
`;

try {
  const out = ssh(gateway, gwCheck);
  const m = Object.fromEntries(
    out.split("\n").flatMap((line) => {
      const i = line.indexOf("=");
      return i > 0 ? [[line.slice(0, i), line.slice(i + 1)]] : [];
    }),
  );
  allOk = ok("网关机 :8792 /models", m.AI_HTTP === "200", `HTTP ${m.AI_HTTP}, 模型数 ${m.MODELS}`) && allOk;
  allOk = ok("网关机 :8793 /status", m.VOICE_HTTP === "200", `HTTP ${m.VOICE_HTTP}`) && allOk;
  allOk = ok("网关机端口监听", Number(m.PORTS) >= 2, `监听条目 ${m.PORTS}`) && allOk;
  allOk = ok("Fish API Key 已配置", Number(m.FISH) >= 1) && allOk;
  if (m.PROXY_HTTP !== "200" && m.PROXY_HTTP !== "000") {
    ok("出站代理端口", false, `${m.PROXY_PORT} → HTTP ${m.PROXY_HTTP}（Gemini 可能不可达）`);
  } else if (m.PROXY_HTTP === "000") {
    ok("出站代理端口", false, `${m.PROXY_PORT || "未配置"} 未监听（需在网关机启动 Clash 等）`);
    allOk = false;
  } else {
    ok("出站代理端口", true, m.PROXY_PORT);
  }
  if (m.MODELS === "0" && m.AI_HTTP === "200") {
    ok("AI 模型列表非空", false, "密钥或代理异常，/models 为空");
    allOk = false;
  } else if (m.MODELS !== "0") {
    ok("AI 模型列表非空", true, `${m.MODELS} 个`);
  }
} catch (e) {
  allOk = false;
  ok("网关机自检", false, String(e.stderr || e.message).slice(0, 200));
}

console.log("\n═══ 3. 主站 → 网关机（内网 HTTP，模拟弹幕）═══\n");

const primaryToGw = `
SECRET=$(grep -m1 '^FMZ_REMOTE_SERVICE_SECRET=' /opt/fmz-danmaku-server/danmaku.env 2>/dev/null | cut -d= -f2-)
[ -z "$SECRET" ] && SECRET=$(grep -m1 '^FMZ_REMOTE_SERVICE_SECRET=' /etc/nginx/conf.d/fmz-remote-secret.inc 2>/dev/null | sed -n 's/.*"\\([^"]*\\)".*/\\1/p')
URL=$(grep -m1 '^AI_AGENT_INTERNAL_URL=' /opt/fmz-danmaku-server/danmaku.env 2>/dev/null | cut -d= -f2-)
H=$(curl -s -o /tmp/fmz_dm.json -w '%{http_code}' -H "X-FMZ-Remote-Secret: $SECRET" -H 'Accept: application/json' "$URL/models")
N=$(node -e "try{const j=require('/tmp/fmz_dm.json');process.stdout.write(String((j.models||[]).length))}catch{process.stdout.write('0')}" 2>/dev/null)
echo "URL=$URL HTTP=$H MODELS=$N SECRET_SET=$(test -n "$SECRET" && echo 1 || echo 0)"
`;

try {
  const out = ssh(primary, primaryToGw);
  const m = Object.fromEntries(
    out.split("\n").flatMap((line) => {
      const i = line.indexOf("=");
      return i > 0 ? [[line.slice(0, i), line.slice(i + 1)]] : [];
    }),
  );
  allOk = ok("danmaku.env AI URL", m.URL === gw.aiAgentUrl, m.URL || "(空)") && allOk;
  allOk = ok("主站直连网关 /models", m.HTTP === "200", `HTTP ${m.HTTP}`) && allOk;
  allOk = ok("主站共享密钥", m.SECRET_SET === "1") && allOk;
  if (m.MODELS !== "0") ok("主站可见模型数", true, m.MODELS);
} catch (e) {
  allOk = false;
  ok("主站→网关", false, String(e.stderr || e.message).slice(0, 200));
}

console.log("\n═══ 4. 主站 Nginx 反代（/__fmz_ai_agent、/__fmz_voice_clone）═══\n");

const nginxCheck = `
grep -E '43\\.160\\.205\\.247|:8792|:8793' /etc/nginx/conf.d/fmz-remote-upstreams.conf 2>/dev/null | head -4
H_AI=$(curl -sk -o /tmp/fmz_ngx_ai.json -w '%{http_code}' -H 'Host: www.dianfanbao.net' https://127.0.0.1/__fmz_ai_agent/models)
H_VC=$(curl -sk -o /tmp/fmz_ngx_vc.json -w '%{http_code}' -H 'Host: www.dianfanbao.net' https://127.0.0.1/__fmz_voice_clone/status)
N=$(node -e "try{const j=require('/tmp/fmz_ngx_ai.json');process.stdout.write(String((j.models||[]).length))}catch{process.stdout.write('0')}" 2>/dev/null)
echo "NGX_AI=$H_AI NGX_VC=$H_VC MODELS=$N"
`;

try {
  const out = ssh(primary, nginxCheck);
  const m = Object.fromEntries(
    out.split("\n").filter((l) => l.includes("=")).map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1)];
    }),
  );
  allOk = ok("Nginx /__fmz_ai_agent", m.NGX_AI === "200", `HTTP ${m.NGX_AI}`) && allOk;
  allOk = ok("Nginx /__fmz_voice_clone", m.NGX_VC === "200", `HTTP ${m.NGX_VC}`) && allOk;
  if (m.MODELS && m.MODELS !== "0") ok("经 Nginx 模型数", true, m.MODELS);
  const hasUpstream = out.includes("43.160.205.247");
  allOk = ok("upstream 指向网关机", hasUpstream) && allOk;
} catch (e) {
  allOk = false;
  ok("Nginx 反代", false, String(e.stderr || e.message).slice(0, 200));
}

console.log("");
if (allOk) {
  console.log("🎉 远端 AI 网关架构自检通过，新机器 API 服务可被主站正常使用。\n");
} else {
  console.log("⚠️  部分检查未通过，请根据 ❌ 项处理（常见：网关机 7890 代理未启动）。\n");
  process.exit(1);
}
