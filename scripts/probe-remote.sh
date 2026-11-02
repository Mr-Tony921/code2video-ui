#!/usr/bin/env bash
# 探测后端机器环境，结果可回填 config/backend.json。
# SSH 仅用于此类部署/调试动作；生产数据通路是 Bridge 的 HTTP。
set -uo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$R/scripts/guard-isolation.py"
KEY="${CVW_SSH_KEY:-$HOME/.ssh/id_rsa}"
PORT="${CVW_SSH_PORT:-8888}"
USER_="${CVW_SSH_USER:-codevideo}"
HOSTS="${*:-10.120.3.60 10.120.3.50}"
export NO_PROXY="localhost,127.0.0.1,$(echo $HOSTS|tr ' ' ',')"
export no_proxy="$NO_PROXY"
S="ssh -p $PORT -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o IdentitiesOnly=yes"

for IP in $HOSTS; do
  echo "################ $IP ################"
  timeout 90 $S "$USER_@$IP" "R=$R bash -s" <<'EOF'
printf "%-16s %s\n" hostname "$(hostname)"
printf "%-16s %s\n" uid "$(id -u)"
for b in claude node npm python3 ffmpeg ffprobe nvidia-smi git; do
  printf "%-16s %s\n" "$b" "$(command -v $b 2>/dev/null || echo 缺失)"
done
printf "%-16s %s\n" node-ver "$(node -v 2>/dev/null)"
printf "%-16s %s\n" claude-ver "$(claude --version 2>/dev/null|head -1)"
printf "%-16s %s\n" gpu "$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null|head -1) ×$(nvidia-smi -L 2>/dev/null|wc -l)"
printf "%-16s %s\n" workspace "$([ -d $R ] && echo 可见 || echo 不可见)"
printf "%-16s %s\n" runtime-w "$(touch $R/runtime/.probe_$$ 2>/dev/null && rm -f $R/runtime/.probe_$$ && echo 可写 || echo 不可写)"
printf "%-16s %s\n" chrome "$(find $R/runtime/browser -maxdepth 3 -name chrome -type f -perm -u+x 2>/dev/null|head -1 || echo 缺失)"
M=$(python3 -c "import json;print(json.load(open('$R/config/video_settings.json'))['env']['ANTHROPIC_BASE_URL'])" 2>/dev/null)
printf "%-16s %s\n" model-url "$M"
printf "%-16s %s\n" model-dns "$(getent hosts $(echo $M|sed 's|http://||;s|:.*||') >/dev/null 2>&1 && echo 可解析 || echo 解析失败)"
printf "%-16s %s\n" model-http "$(curl -sS --noproxy '*' -m 15 -o /dev/null -w '%{http_code}' $M/v1/models 2>/dev/null)"
EOF
  echo
done
