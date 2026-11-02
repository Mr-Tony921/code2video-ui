#!/usr/bin/env bash
# 后端机器依赖完整性核查。保存镜像快照前跑这个确认。
#   bash scripts/verify-deps.sh            # 查两台
#   bash scripts/verify-deps.sh 10.120.3.60
set -uo pipefail
KEY="${CVW_SSH_KEY:-$HOME/.ssh/id_rsa}"
PORT="${CVW_SSH_PORT:-8888}"
USER_="${CVW_SSH_USER:-codevideo}"
HOSTS="${*:-10.120.3.60 10.120.3.50}"
export NO_PROXY="localhost,127.0.0.1,$(echo $HOSTS|tr ' ' ',')"
export no_proxy="$NO_PROXY"
S="ssh -p $PORT -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o IdentitiesOnly=yes"
R="$(cd "$(dirname "$0")/.." && pwd)"

for IP in $HOSTS; do
echo "################################ $IP ################################"
timeout 180 $S "$USER_@$IP" "R=$R bash -s" <<'EOF'
PASS=0; FAIL=0
ok(){ printf "  ✅ %-34s %s\n" "$1" "${2:-}"; PASS=$((PASS+1)); }
no(){ printf "  ❌ %-34s %s\n" "$1" "${2:-}"; FAIL=$((FAIL+1)); }
chk(){ if [ -n "$2" ]; then ok "$1" "$2"; else no "$1" "缺失"; fi; }

echo "── 系统二进制 ──"
for b in claude node npm python3 ffmpeg ffprobe git unshare ps pgrep; do
  chk "$b" "$(command -v $b 2>/dev/null)"
done
chk "latex (manim MathTex)" "$(command -v latex 2>/dev/null)"
N=$(fc-list 2>/dev/null | grep -ci 'noto.*cjk' || true)
[ "$N" -gt 0 ] && ok "Noto CJK 字体" "$N 个" || no "Noto CJK 字体"

echo "── 版本 ──"
ok "node" "$(node -v 2>/dev/null)"
ok "claude" "$(claude --version 2>/dev/null | head -1)"
ok "ffmpeg" "$(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)"
ok "python3" "$(python3 -V 2>&1 | cut -d' ' -f2)"

echo "── /opt/videokit node 包 ──"
for m in three gsap roughjs p5 @napi-rs/canvas playwright puppeteer puppeteer-core; do
  V=$(node -e "try{console.log(require('/opt/videokit/node_modules/$m/package.json').version)}catch(e){}" 2>/dev/null)
  chk "$m" "$V"
done

echo "── /opt/videokit venv python 包 ──"
P=/opt/videokit/venv/bin/python
if [ -x "$P" ]; then
  ok "venv python" "$($P -V 2>&1 | cut -d' ' -f2)"
  for m in manim numpy scipy cv2 matplotlib soundfile librosa edge_tts faster_whisper PIL; do
    if $P -c "import $m" 2>/dev/null; then ok "$m"; else no "$m"; fi
  done
else
  no "venv python" "/opt/videokit/venv/bin/python 不存在"
fi

echo "── Chrome（whitebox 3D 渲染）──"
C=$R/runtime/browser/chrome-linux64/chrome
if [ -x "$C" ]; then
  ok "chrome 可执行" "$("$C" --version 2>/dev/null | head -1)"
  for f in chrome_crashpad_handler chrome_sandbox; do
    [ -x "$R/runtime/browser/chrome-linux64/$f" ] && ok "$f 有执行权" || no "$f 无执行权（zip 不保留权限位）"
  done
  CHECKDIR=$(mktemp -d /tmp/cvw-codex-deps.XXXXXX)
  trap 'rm -rf "$CHECKDIR"' EXIT
  cd "$CHECKDIR"
  echo '<body style="margin:0;background:#06b6d4"><h1>OK</h1></body>' > t.html
  if timeout 60 "$C" --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \
       --screenshot=s.png --window-size=200,100 "file://$CHECKDIR/t.html" >/dev/null 2>&1 && [ -s s.png ]; then
    ok "headless 截图" "$(stat -c%s s.png) bytes"
  else
    no "headless 截图"
  fi
else
  no "chrome" "$C 不存在或无执行权"
fi

echo "── previs 渲染依赖 ──"
PD=$R/runtime/previs-deps/node_modules
for m in three puppeteer-core; do
  V=$(node -e "try{console.log(require('$PD/$m/package.json').version)}catch(e){}" 2>/dev/null)
  chk "previs-deps/$m" "$V"
done

echo "── 隔离能力 ──"
if unshare --mount --propagation private true 2>/dev/null; then
  ok "unshare --mount" "（root 级，最佳）"
elif unshare --user --map-root-user --mount --propagation private true 2>/dev/null; then
  ok "unshare --user --map-root-user --mount" "（非 root 可用）"
else
  no "挂载命名空间" "两种方式都不可用 → 只能软隔离"
fi

# 运行时依赖必须在【命名空间内】可见。
# 踩过的坑：hide_paths 遮蔽了 /mnt，而 chrome/previs-deps 就装在 /mnt 下，
# 宿主上检查一切正常，任务里却找不到 —— 用户白模任务因此报
# "Browser was not found"，cc 只好自行下载 250MB。所以必须进命名空间验。
ISO_OK=$(python3 -c "import json;c=json.load(open('$R/config/backend.json'));print('1' if (c.get('isolation') or {}).get('enabled') else '0')" 2>/dev/null)
if [ "$ISO_OK" = "1" ]; then
  BINDS=$(python3 -c "
import json
c=json.load(open('$R/config/backend.json'))
bs=(c.get('isolation') or {}).get('bind_paths') or []
print(','.join(b['src']+':'+b['dst'] for b in bs if b.get('src') and b.get('dst')))" 2>/dev/null)
  CHROME_NS=$(python3 -c "import json;print(json.load(open('$R/config/backend.json'))['runtime_binaries']['chrome_bin'])" 2>/dev/null)
  PREVIS_NS=$(python3 -c "import json;print(json.load(open('$R/config/backend.json'))['runtime_binaries']['previs_dependency_root'])" 2>/dev/null)
  NSW=$(mktemp -d /tmp/cvw-nscheck.XXXXXX)
  NSOUT=$(unshare --user --map-root-user --mount --propagation private \
    bash "$R/apps/worker-bridge/scripts/isolate.sh" "$NSW" "/mnt" "/workspace" "$BINDS" -- \
    bash -c "[ -x '$CHROME_NS' ] && echo CHROME_OK; [ -d '$PREVIS_NS/node_modules' ] && echo PREVIS_OK" 2>/dev/null)
  rm -rf "$NSW"
  echo "$NSOUT" | grep -q CHROME_OK \
    && ok "chrome（命名空间内）" "$CHROME_NS" \
    || no "chrome（命名空间内）" "$CHROME_NS 不可见/不可执行 → 白模任务会自行下载 250MB"
  echo "$NSOUT" | grep -q PREVIS_OK \
    && ok "previs-deps（命名空间内）" "$PREVIS_NS" \
    || no "previs-deps（命名空间内）" "$PREVIS_NS 在命名空间内不可见"
fi

echo "── 共享存储与工作区 ──"
[ -d "$R" ] && ok "工作区可见" "$R" || no "工作区不可见"
touch "$R/runtime/.dep_probe" 2>/dev/null && ok "runtime 可写" && rm -f "$R/runtime/.dep_probe" || no "runtime 不可写"
ok "uid" "$(id -u)"

echo "── skill 与模板 ──"
for d in coding_to_video blockout_3d; do
  N=$(ls -d "$R/assets/skillsets/$d"/*/ 2>/dev/null | wc -l)
  [ "$N" -gt 0 ] && ok "skillset $d" "$N 个 skill" || no "skillset $d"
done
[ -f "$R/assets/prompt-templates/dense_prompt_template.md" ] \
  && ok "dense prompt 模板" "$(wc -c < "$R/assets/prompt-templates/dense_prompt_template.md") bytes" \
  || no "dense prompt 模板"

echo "── 模型可达性 ──"
M=$(python3 -c "import json;print(json.load(open('$R/config/video_settings.json'))['env']['ANTHROPIC_BASE_URL'])" 2>/dev/null)
H=$(echo "$M" | sed 's|http://||;s|:.*||')
getent hosts "$H" >/dev/null 2>&1 && ok "生产模型 DNS" "$H" || no "生产模型 DNS" "$H 解析失败"
CODE=$(curl -sS --noproxy '*' -m 15 -o /dev/null -w '%{http_code}' "$M/v1/models" 2>/dev/null)
[ "$CODE" = "200" ] && ok "生产模型 /v1/models" "HTTP 200" || no "生产模型 /v1/models" "HTTP $CODE"

E=$(python3 -c "import json;print(json.load(open('$R/config/backend.json'))['prompt_enhancement']['aux_model']['base_url'])" 2>/dev/null)
EH=$(echo "$E" | sed 's|https\?://||;s|/.*||')
getent hosts "$EH" >/dev/null 2>&1 && ok "增强模型 DNS" "$EH" || no "增强模型 DNS" "$EH"

echo
echo "  ══ $(hostname) : 通过 $PASS 项，失败 $FAIL 项 ══"
[ "$FAIL" -eq 0 ] && echo "  ✅ 依赖完整，可保存快照" || echo "  ⚠️ 有 $FAIL 项缺失，见上方 ❌"
EOF
echo
done
