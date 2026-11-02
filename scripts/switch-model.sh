#!/usr/bin/env bash
# 切换/核对【本环境】的推理模型端点。
#
#   bash scripts/switch-model.sh --check                 只核对，不改任何东西
#   bash scripts/switch-model.sh http://<host>:8000      切到新端点
#
# 为什么要有这个脚本（2026-10-29 手工切 v4→v23 时踩到的几件事）：
#
#  1. **地址要带端口。** 新端点只在 `:8000` 上通，不带端口 curl 返回 000。
#  2. **模型名必须跟着改，但端点不会告诉你。** 实测这个 Anthropic 兼容代理
#     **不校验模型名**：你传 v4 它回 v4、传 v23 它回 v23，而 /v1/models 里只有 v23。
#     也就是说名字写错【请求照样 200】，但 healthz、页面、job 记录、cc 轨迹里
#     全都记成错的模型 —— 做版本/模型对比时会得出完全错误的结论，
#     而且因为响应原样回显，**从返回里看不出不一致**。所以名字一律从 /v1/models 取。
#  3. **要从 worker 机器探。** 真正调模型的是 bridge 机器上的 cc，不是前端机。
#     只在一台上探通不代表另一台通。
#  4. **max_model_len 变了就要改 max_context_tokens。** 配小了白浪费上下文，
#     配大了模型直接拒绝请求（配置注释里记着这条）。
#
# 本脚本【不会自动重启任何服务】—— 有任务在跑时重启 bridge 会打断它，
# 什么时候重启由人决定。改完它会把需要执行的命令打印出来。
set -uo pipefail
R="${CVW_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$R" || exit 1
CFG=config/backend.json
MODE="${1:?用法: $0 --check | <新的 base_url（带端口）>}"

j(){ python3 -c "import json,sys;print(json.load(open('$CFG'))$1)" 2>/dev/null; }
CUR_URL=$(j "['model']['base_url']")
CUR_NAME=$(j "['model']['model']")
CUR_CTX=$(j "['model']['max_context_tokens']")

# 探一个端点：回显 模型名|max_model_len，取不到则空
probe(){
  local url="$1" host="${2:-}"
  local cmd="curl -s --noproxy '*' --max-time 12 '$url/v1/models'"
  local out
  if [ -n "$host" ]; then
    out=$(ssh -p 8888 -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=yes "$host" "$cmd" 2>/dev/null)
  else
    out=$(eval "$cmd" 2>/dev/null)
  fi
  python3 -c "
import json,sys
try: d=json.loads('''$out''')
except Exception: sys.exit(1)
ms=d.get('data') or []
if not ms: sys.exit(1)
print('|'.join([','.join(m.get('id','?') for m in ms), str(ms[0].get('max_model_len') or '')]))
" 2>/dev/null
}

# 本环境所有 enabled 的 worker 机器（真正调模型的那些）
HOSTS=$(python3 -c "
import json
c=json.load(open('$CFG'))
print(' '.join(w['ssh']['host'] for w in c['workers'] if w.get('enabled',True)))
" 2>/dev/null)

echo "════════ 当前配置 ════════"
echo "  base_url            $CUR_URL"
echo "  model               $CUR_NAME"
echo "  max_context_tokens  $CUR_CTX"
echo "  worker 机器         $HOSTS"
echo

TARGET="$CUR_URL"; [ "$MODE" != "--check" ] && TARGET="$MODE"
case "$TARGET" in
  *://*:[0-9]*) ;;
  *) echo "⚠️  地址没带端口：$TARGET"
     echo "    实测过不带端口会连不上（curl 返回 000）。请写成 http://<host>:8000"
     [ "$MODE" != "--check" ] && exit 1 ;;
esac

echo "════════ 从每台 worker 机器探测 $TARGET ════════"
FAIL=0; NAME=""; CTX=""
for h in $HOSTS; do
  r=$(probe "$TARGET" "$h")
  if [ -z "$r" ]; then echo "  ❌ $h  /v1/models 取不到"; FAIL=1; continue; fi
  ids="${r%%|*}"; mml="${r##*|}"
  echo "  ✅ $h  模型=$ids  max_model_len=$mml"
  [ -z "$NAME" ] && NAME="$ids" && CTX="$mml"
  [ "$ids" != "$NAME" ] && { echo "  ⚠️  各机器看到的模型不一致！"; FAIL=1; }
done
[ "$FAIL" = 1 ] && { echo; echo "❌ 有机器探测失败或不一致，不做任何修改。"; exit 1; }

case "$NAME" in
  *,*) echo; echo "⚠️  该端点列出了多个模型（$NAME）。"
       echo "    这种情况模型名就是路由依据，必须人工指定要用哪个，脚本不猜。"; exit 1 ;;
esac

echo
if [ "$MODE" = "--check" ]; then
  echo "════════ 一致性核对 ════════"
  [ "$CUR_NAME" = "$NAME" ] && echo "  ✅ 模型名与端点一致（$NAME）" \
    || { echo "  ❌ 模型名不一致：配置写 $CUR_NAME，端点实际是 $NAME"
         echo "     ⚠️ 请求不会报错（代理不校验名字、原样回显），但所有记录都是错的"; }
  if [ -n "$CTX" ]; then
    [ "$CUR_CTX" = "$CTX" ] && echo "  ✅ max_context_tokens 与 max_model_len 一致（$CTX）" \
      || echo "  ❌ max_context_tokens=$CUR_CTX 与端点 max_model_len=$CTX 不一致"
  fi
  exit 0
fi

echo "════════ 即将修改 $CFG ════════"
echo "  base_url:           $CUR_URL"
echo "               →      $TARGET"
echo "  model:              $CUR_NAME  →  $NAME"
[ -n "$CTX" ] && [ "$CUR_CTX" != "$CTX" ] && echo "  max_context_tokens: $CUR_CTX  →  $CTX"
echo

python3 - "$TARGET" "$NAME" "$CTX" <<'PY'
import json,sys,datetime,re
cfg="config/backend.json"
new_url,new_name,new_ctx=sys.argv[1],sys.argv[2],sys.argv[3]
s=open(cfg,encoding="utf8").read()
d=json.loads(s)
m=d["model"]
old_url,old_name,old_ctx=m["base_url"],m["model"],m.get("max_context_tokens")
# 字符串级替换，保住原文件的排版与注释键顺序
def one(s,a,b,what):
    assert s.count(a)==1, f"{what} 锚点在配置里出现 {s.count(a)} 次，拒绝改"
    return s.replace(a,b,1)
s=one(s,f'"base_url": "{old_url}"',f'"base_url": "{new_url}"',"base_url")
if old_name!=new_name:
    s=one(s,f'"model": "{old_name}"',f'"model": "{new_name}"',"model")
if new_ctx and str(old_ctx)!=new_ctx:
    s=one(s,f'"max_context_tokens": {old_ctx}',f'"max_context_tokens": {new_ctx}',"max_context_tokens")
# 旧的进 $history
hist=f'''    "$history": [
      {{
        "url": "{old_url}",
        "model": "{old_name}",
        "retired_at": "{datetime.date.today().isoformat()}",
        "$why": "由 scripts/switch-model.sh 切换"
      }},'''
s=one(s,'    "$history": [',hist,"$history")
json.loads(s)   # 语法自检
open(cfg,"w",encoding="utf8").write(s)
print("  ✅ 已写入并通过 JSON 解析")
PY

echo
echo "════════ 接下来要做的（脚本不替你做）════════"
cat <<'TIP'
  1. 隔离护栏:   bash scripts/guard-isolation.sh
  2. 重启（每台 worker 一次 + Gateway）:
       bash scripts/restart-service.sh bridge <worker_id>
       bash scripts/restart-service.sh gateway

     ★ 有任务在跑时也可以重启 —— 实测 cc 不会被打断：
       cc 是 setsid 脱离 bridge 的独立进程，bridge 起来后按 job token 重新【认领】。
       2026-10-29 切 v23→SenseNova-6.8 时逐台实测（两台各有一个任务在跑）：
         重启前后 cc pid 完全未变（1016765 / 1204604），
         bridge /health 明确回 adopted=['job_f628fd18…'] / ['job_795e2e55…']，
         两个任务状态一直是 RUNNING。Gateway 重启同样无损。
       建议仍然【逐台】重启并在每台之后核对一次，而不是一把全推：
         ssh <worker> 'for d in /proc/[0-9]*; do [ "$(cat $d/comm)" = claude ] || continue;
           grep -q CVW_JOB_TOKEN /proc/$(basename $d)/environ && basename $d; done'
         curl -s --noproxy '*' http://<worker>:18080/health   # 看 adopted / running_jobs
     ⚠️ 已在跑的 cc 用的是【它启动时】注入的模型，不会中途切换；
        新模型只对**此后新提交**的任务生效。
  4. 核对:
       bash scripts/switch-model.sh --check
       curl -s --noproxy '*' http://<gateway>:9998/healthz | python3 -m json.tool | grep model
  5. 真正的连通性证明 —— 看新任务轨迹里实际回话的模型名：
       grep -o '"model":"[^"]*"' <session>/workspace/claude.jsonl | sort -u
TIP
