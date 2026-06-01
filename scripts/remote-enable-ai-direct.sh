#!/bin/bash
set -euo pipefail
for f in /etc/fmz-ai-gateway.env /opt/fmz-ai-agent-server/local-ai-agent.env; do
  [ -f "$f" ] || continue
  cp -a "$f" "${f}.bak-proxy" 2>/dev/null || true
  sed -i 's/^\(FMZ_AI_AGENT_LOCAL_PROXY=\)/#\1/' "$f"
  sed -i 's/^\(HTTPS_PROXY=\)/#\1/' "$f"
  sed -i 's/^\(HTTP_PROXY=\)/#\1/' "$f"
done
systemctl restart fmz-ai-agent fmz-voice-clone
echo "waiting probe (up to 90s)..."
sleep 25
SECRET=$(grep -m1 '^FMZ_REMOTE_SERVICE_SECRET=' /etc/fmz-ai-gateway.env | cut -d= -f2-)
curl -s -H "X-FMZ-Remote-Secret: $SECRET" "http://127.0.0.1:8792/models?refresh=1" -o /tmp/fmz_m.json
python3 -c "
import json
d=json.load(open('/tmp/fmz_m.json'))
m=d.get('models') or []
print('MODEL_COUNT='+str(len(m)))
if m: print('SAMPLE='+','.join(x['id'] for x in m[:8]))
u=(d.get('meta') or {}).get('reachability',{}).get('unreachableIds') or []
print('UNREACHABLE='+str(len(u)))
"
journalctl -u fmz-ai-agent -n 3 --no-pager | grep -E '出站|proxy|ids' || true
