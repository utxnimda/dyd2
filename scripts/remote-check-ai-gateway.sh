#!/bin/bash
set -euo pipefail
SECRET=$(grep -m1 '^FMZ_REMOTE_SERVICE_SECRET=' /etc/fmz-ai-gateway.env 2>/dev/null | cut -d= -f2-)
H_AI=$(curl -s -o /tmp/fmz_ai.json -w '%{http_code}' -H "X-FMZ-Remote-Secret: $SECRET" http://127.0.0.1:8792/models)
H_VC=$(curl -s -o /tmp/fmz_vc.json -w '%{http_code}' -H "X-FMZ-Remote-Secret: $SECRET" http://127.0.0.1:8793/status)
MODELS=$(python3 -c "import json; d=json.load(open('/tmp/fmz_ai.json')); print(len(d.get('models',[])))" 2>/dev/null || echo 0)
FISH=$(grep -c '^FISH_AUDIO_API_KEY=.' /etc/fmz-ai-gateway.env 2>/dev/null || echo 0)
PROXY=$(grep -m1 '^FMZ_AI_AGENT_LOCAL_PROXY=' /etc/fmz-ai-gateway.env 2>/dev/null | cut -d= -f2- | sed 's|http://||;s|https://||')
PR=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "http://$PROXY" 2>/dev/null || echo 000)
echo "GW_AI_HTTP=$H_AI GW_MODELS=$MODELS GW_VC_HTTP=$H_VC GW_FISH=$FISH GW_PROXY_HTTP=$PR"
