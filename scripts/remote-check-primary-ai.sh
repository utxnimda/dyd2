#!/bin/bash
set -euo pipefail
SECRET=$(grep -m1 '^FMZ_REMOTE_SERVICE_SECRET=' /opt/fmz-danmaku-server/danmaku.env 2>/dev/null | cut -d= -f2-)
URL=$(grep -m1 '^AI_AGENT_INTERNAL_URL=' /opt/fmz-danmaku-server/danmaku.env 2>/dev/null | cut -d= -f2-)
H=$(curl -s -o /tmp/fmz_dm.json -w '%{http_code}' -H "X-FMZ-Remote-Secret: $SECRET" -H 'Accept: application/json' "${URL}/models")
MODELS=$(python3 -c "import json; d=json.load(open('/tmp/fmz_dm.json')); print(len(d.get('models',[])))" 2>/dev/null || echo 0)
H_NGX_AI=$(curl -sk -o /tmp/fmz_ngx_ai.json -w '%{http_code}' -H 'Host: www.dianfanbao.net' https://127.0.0.1/__fmz_ai_agent/models)
H_NGX_VC=$(curl -sk -o /tmp/fmz_ngx_vc.json -w '%{http_code}' -H 'Host: www.dianfanbao.net' https://127.0.0.1/__fmz_voice_clone/status)
UP=$(grep -c '43.160.205.247' /etc/nginx/conf.d/fmz-remote-upstreams.conf 2>/dev/null || echo 0)
echo "DM_URL=$URL DM_HTTP=$H DM_MODELS=$MODELS NGX_AI=$H_NGX_AI NGX_VC=$H_NGX_VC UPSTREAM=$UP SECRET_OK=$(test -n "$SECRET" && echo 1 || echo 0)"
