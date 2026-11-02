#!/usr/bin/env bash
# 发布检查清单：每次改完代码、重启服务后必须跑通这一条命令。
#   bash scripts/release-check.sh
#
# 它是"能不能对外"的唯一判据。任一项失败都不要交付。
set -uo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
cd "$R"
python3 "$R/scripts/guard-isolation.py" || exit 1
j(){ python3 -c "import json,sys;d=json.load(open('config/backend.json'));print(eval('d'+sys.argv[1]))" "$1"; }
LAN="http://$(j "['deployment']['web']['host']"):$(j "['deployment']['web']['port']")"
PUB=$(j "['deployment']['web'].get('public_url') or ''")
GW="http://$(j "['deployment']['gateway']['host']"):$(j "['deployment']['gateway']['port']")"
C=(curl -s --noproxy '*' --max-time 25)
P=0; F=0
ok(){ printf "  ✅ %-36s %s\n" "$1" "${2:-}"; P=$((P+1)); }
no(){ printf "  ❌ %-36s %s\n" "$1" "${2:-}"; F=$((F+1)); }

echo "════════ 发布检查 $(date '+%H:%M:%S') ════════"

echo "── A. 单实例（重复实例会服务旧代码）──"
# 按 cwd 归属统计：同一台机器可能并存多个环境（线上/开发），
# 只有【本工作区】的实例数才有意义。全局计数会把别的环境算进来。
N=0
for p in $(pgrep -f '^next-server' 2>/dev/null); do
  case "$(readlink /proc/$p/cwd 2>/dev/null)" in "$R"/*) N=$((N+1));; esac
done
# ⚠️ `pgrep -fc` 计数为 0 时【既打印 "0" 又返回非零退出码】，
#    所以 `$(pgrep -fc ... || echo 0)` 会拼成 "0\n0" → 算术展开报语法错。
#    用 `|| true` 兜住退出码，再把可能的多行压成一个数。
ALL=$(pgrep -fc '^next-server' 2>/dev/null | head -1 || true)
OTHER=$(( ${ALL:-0} - N ))
# ★ 这一段只在【前端所在机器】上有意义：按 cwd 查的是本机进程。
#   dev 的前端在 web.host（10.120.6.65），而本脚本常在后端机器跑 ——
#   那时 N 必然是 0，红的是"跑错机器"而不是部署。
WEB_HOST=$(j "['deployment']['web']['host']")
MY_IPS=$(hostname -I 2>/dev/null || echo)
case " $MY_IPS " in
  *" $WEB_HOST "*)
    [ "$N" = 1 ] && ok "本工作区前端实例数" "1（其他环境 $OTHER 个，不影响）" \
      || no "本工作区前端实例数异常" "$N（应为 1）" ;;
  *)
    echo "  ·  跳过：前端在 $WEB_HOST，本机不是它（实例数要在那台上查）" ;;
esac

echo "── B. 构建与线上一致 ──"
DISK=$(ls apps/web/.next/static/chunks/app/ 2>/dev/null | grep '^page-' | head -1)
SERVED=$("${C[@]}" "$LAN/" 2>/dev/null | grep -oE 'page-[a-f0-9]+\.js' | head -1)
[ -n "$DISK" ] && [ "$DISK" = "$SERVED" ] && ok "线上服务的是最新构建" "$DISK" \
  || no "线上跑的是旧构建" "disk=$DISK served=$SERVED → 重启前端"

echo "── C. 公网子路径前缀 ──"
BP=$(j "['deployment']['web'].get('base_path') or ''")
BUILT=$(python3 -c "import json;print(json.load(open('apps/web/.next/routes-manifest.json')).get('basePath',''))" 2>/dev/null)
[ "$BUILT" = "$BP" ] && ok "构建 basePath 与配置一致" "'${BP:-根路径}'" \
  || no "basePath 不一致" "配置='$BP' 产物='$BUILT' → 必须用 start-frontend.sh build"

echo "── D. 三层可达 ──"
[ "$("${C[@]}" -o /dev/null -w '%{http_code}' "$LAN/health")" = 200 ] && ok "前端 /health" || no "前端 /health"
"${C[@]}" "$GW/healthz" -o /tmp/rc.$$ 2>/dev/null
python3 - "$P" <<PY 2>/dev/null && P=$((P+1)) || no "Gateway healthz"
import json,sys
d=json.load(open('/tmp/rc.$$'))
print("  ✅ %-36s v%s | %s | %d 进程 | %d/%d 并发"%(
  "Gateway", d.get('version'), d.get('model_display_name'),
  d['processes'], d['global_used'], d['global_max_concurrent_jobs']))
assert d['processes']>=1
PY
for endpoint in $(python3 -c "import json;[print(str(w['bridge']['host'])+':'+str(w['bridge']['port'])) for w in json.load(open('config/backend.json'))['workers'] if w.get('enabled',True)]"); do
  h=$endpoint
  "${C[@]}" "http://$h/health" -o /tmp/rb.$$ 2>/dev/null
  python3 -c "
import json;d=json.load(open('/tmp/rb.$$'))
assert d['registered']; print('  ✅ %-36s %s running=%d/%d'%('Bridge $h',d['worker_id'],d['running_jobs'],d['max_concurrent_jobs']))
" 2>/dev/null && P=$((P+1)) || no "Bridge $h 未注册"
done

echo "── E. 公网入口（对外唯一判据）──"
if [ -n "$PUB" ]; then
  [ "$("${C[@]}" -o /dev/null -w '%{http_code}' "$PUB/")" = 200 ] && ok "公网首页" || no "公网首页打不开"
  [ "$("${C[@]}" -o /dev/null -w '%{http_code}' "$PUB/health")" = 200 ] && ok "公网 /health" || no "公网 /health"
  H=$("${C[@]}" "$PUB/" 2>/dev/null)
  A=$(echo "$H" | grep -oE 'href="[^"]*_next/static/css/[^"]*"' | head -1 | sed 's/href="//;s/"//')
  if [ -z "$BP" ]; then ok "资源前缀" "根路径"
  elif echo "$A" | grep -q "^$BP/"; then
    ok "页面资源带前缀" "$(basename "$A")"
    AC=$("${C[@]}" -o /dev/null -w '%{http_code}' "${PUB%$BP}$A")
    [ "$AC" = 200 ] && ok "资源实际可取" || no "资源取不到" "HTTP $AC（会白屏）"
  else no "资源丢前缀" "$A → 打到域名根（别的应用）"; fi
else echo "  ·  未配置 public_url，跳过"; fi

echo "── F. 数据面不变量 ──"
python3 - <<'PY' && P=$((P+1)) || F=$((F+1))
import json,glob,sys
bad=[];
for f in glob.glob('runtime/gateway/jobs/*.json'):
    try: json.load(open(f))
    except: bad.append(f.split('/')[-1][:22])
tmp=glob.glob('runtime/gateway/jobs/*.tmp')
if bad or tmp:
    print('  ❌ %-36s 损坏=%s 残留tmp=%d'%('job 记录完整性',bad[:3],len(tmp))); sys.exit(1)
print('  ✅ %-36s 无损坏、无残留 tmp'%'job 记录完整性')
PY

echo "── G. 版本 ──"
V=$(cat VERSION 2>/dev/null)
GV=$(python3 -c "import json;print(json.load(open('/tmp/rc.$$')).get('version'))" 2>/dev/null)
[ -n "$V" ] && [ "$V" = "$GV" ] && ok "VERSION 与 Gateway 一致" "v$V" || no "版本不一致" "VERSION=$V Gateway=$GV"

# ★ 还要查【构建产物】里的版本号。
#   原来这一项叫「前后端版本一致」，其实只比了 VERSION 文件 vs Gateway ——
#   **前端那一侧根本没查**。实测踩过：VERSION 与 Gateway 都是 1.4.2、
#   而页面角标还是 v1.4.1（版本号曾被写死在 _workspace.tsx 里，忘了改），
#   这一项照样绿。现在版本由 next.config 在构建期注入，必须验它真的进了产物，
#   否则「忘了重新 build」这件事依旧查不出来。
#   只在前端所在机器上查（.next 在那台）。
if [ -d apps/web/.next/static/chunks ]; then
  if grep -rqF "$V" apps/web/.next/static/chunks 2>/dev/null; then
    ok "构建产物含本版版本号" "v$V"
  else
    no "构建产物里没有 v$V（忘了重新 build？）" \
       "产物里的版本串: $(grep -rhoE '1\.[0-9]+\.[0-9]+' apps/web/.next/static/chunks 2>/dev/null | sort -u | tr '\n' ' ')"
  fi
else
  echo "  ·  跳过构建产物版本检查：本机没有 .next（前端不在这台）"
fi
grep -q "^## $V" CHANGELOG.md 2>/dev/null && ok "CHANGELOG 有本版记录" || no "CHANGELOG 缺 $V 的条目"

rm -f /tmp/rc.$$ /tmp/rb.$$
echo
echo "  ══ 通过 $P 项，失败 $F 项 ══"
if [ "$F" = 0 ]; then
  echo "  ✅ 可以对外。人工再确认：bash scripts/e2e-checklist.sh（真跑一轮生成+微调，约 10 分钟）"
else
  echo "  ❌ 有失败项，不要交付"
fi
exit $([ "$F" = 0 ] && echo 0 || echo 1)
