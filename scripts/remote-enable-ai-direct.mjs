#!/usr/bin/env node
/**
 * 网关机：注释失效的本地代理配置，重启 fmz-ai-agent，检查 /models 数量。
 */
import { execSync } from "node:child_process";
import { resolveDeployConfig } from "./fmz-deploy-env.mjs";

const cfg = resolveDeployConfig({ targetId: "tencent-43" });
const SSH = `ssh -i "${cfg.sshKey}" ${cfg.remoteUser}@${cfg.remoteHost}`;

const sh = `
set -e
for f in /etc/fmz-ai-gateway.env /opt/fmz-ai-agent-server/local-ai-agent.env; do
  [ -f "$f" ] || continue
  cp -a "$f" "\${f}.bak-proxy-$(date +%Y%m%d%H%M)" 2>/dev/null || cp -a "$f" "\${f}.bak-proxy"
  sed -i 's/^\\(FMZ_AI_AGENT_LOCAL_PROXY=\\)/#\\1/' "$f"
  sed -i 's/^\\(HTTPS_PROXY=\\)/#\\1/' "$f"
  sed -i 's/^\\(HTTP_PROXY=\\)/#\\1/' "$f"
done
systemctl restart fmz-ai-agent fmz-voice-clone
sleep 5
SECRET=$(grep -m1 '^FMZ_REMOTE_SERVICE_SECRET=' /etc/fmz-ai-gateway.env | cut -d= -f2-)
curl -s -H "X-FMZ-Remote-Secret: $SECRET" http://127.0.0.1:8792/models -o /tmp/fmz_m.json
python3 << 'PY'
import json
with open("/tmp/fmz_m.json") as f:
    d = json.load(f)
models = d.get("models") or []
print("MODEL_COUNT=" + str(len(models)))
if models:
    print("SAMPLE_IDS=" + ",".join(m["id"] for m in models[:6]))
bad = (d.get("meta") or {}).get("reachability", {}).get("unreachableIds") or []
print("UNREACHABLE=" + str(len(bad)))
PY
journalctl -u fmz-ai-agent -n 4 --no-pager | tail -3
`;

const out = execSync(`${SSH} ${JSON.stringify(sh)}`, { encoding: "utf-8" });
console.log(out);
const count = Number((out.match(/MODEL_COUNT=(\d+)/) || [])[1] || 0);
if (count > 0) {
  console.log(`\n✅ 网关机 AI 模型可用：${count} 个`);
  process.exit(0);
}
console.error("\n❌ 模型列表仍为空，请检查 API Key 或稍后再试（可达性探测约 22s/模型）");
process.exit(1);
