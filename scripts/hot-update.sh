#!/usr/bin/env bash
# 热更新：在不打断正在运行的任务的前提下滚动重启。
#
#   bash scripts/hot-update.sh status | begin | bridges | gateway | end | run
#
# 为什么顺序是「先 Bridge 后 Gateway」：
#   Gateway 在线时重启 Bridge，新实例注册的那一刻就会把认领到的任务改绑过去，
#   赶在第一次心跳的归属校验之前。反过来做，Bridge 会先注册进一个冷的 Gateway，
#   然后还要再重启一次，多一轮改绑就多一次出错机会。
#
# 1.3.3 自身的部署仍会中断任务：旧 Bridge 的 cc 子进程挂在管道上，
# 父进程一退出就被 SIGPIPE 杀掉。1.3.4 起才是真正的热更新。
set -uo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
cd "$R" || exit 1

python3 "$R/scripts/guard-isolation.py" || exit 1

j(){ python3 -c "import json,sys;d=json.load(open('config/backend.json'));print(eval('d'+sys.argv[1]))" "$1"; }
GW="http://$(j "['deployment']['gateway']['host']"):$(j "['deployment']['gateway']['port']")"
TOKEN=$(grep -oP '(?<=^CVW_INTERNAL_TOKEN=).*' runtime/.secrets 2>/dev/null | tr -d '"'"'"'')
C=(curl -s --noproxy '*' --max-time 15)
WINDOW="${CVW_UPDATE_WINDOW:-900}"

workers(){ python3 -c "
import json;c=json.load(open('config/backend.json'))
for w in c['workers']:
    if w.get('enabled') is not False:
        print(w['worker_id'], w['bridge']['host'], w['bridge']['port'])"; }

bridge_health(){ "${C[@]}" "http://$1:$2/health" 2>/dev/null; }

say(){ echo "  $*"; }

maint(){   # $1=true|false
  local body
  if [ "$1" = true ]; then
    body="{\"active\":true,\"expected_seconds\":$WINDOW,\"version_to\":\"$(cat VERSION)\"}"
  else
    body='{"active":false}'
  fi
  "${C[@]}" -X POST "$GW/internal/maintenance" \
    -H 'Content-Type: application/json' -H "x-internal-token: $TOKEN" -d "$body" >/dev/null 2>&1
}

# 兜底：Gateway 连不上时直接写/删标记文件（部署中它本来就可能是停的）
maint_file(){
  local f="$(j "['storage']['root']")/gateway/maintenance.json"
  if [ "$1" = true ]; then
    mkdir -p "$(dirname "$f")"
    python3 - "$f" "$WINDOW" "$(cat VERSION)" <<'PY'
import json,sys,datetime
f,win,ver=sys.argv[1],int(sys.argv[2]),sys.argv[3]
now=datetime.datetime.now(datetime.timezone.utc)
json.dump({"active":True,"title":"系统正在更新",
  "message":"正在运行的任务不受影响，更新期间暂时无法新建对话或提交任务",
  "started_at":now.isoformat(),
  "expires_at":(now+datetime.timedelta(seconds=win)).isoformat(),
  "expected_seconds":win,"version_to":ver},
  open(f,'w'),ensure_ascii=False,indent=2)
PY
  else rm -f "$f"; fi
}

cmd_status(){
  echo "════════ 热更新状态 ════════"
  "${C[@]}" "$GW/healthz" 2>/dev/null | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except: print('  Gateway: 连不上'); raise SystemExit
m=d.get('maintenance') or {}
print('  Gateway:', d.get('version'), '| 维护中:', m.get('active') is True)
print('  进程数:', d.get('processes'), '| 全局在跑:', d.get('global_used'))" 2>/dev/null || say "Gateway: 连不上"
  while read -r id host port; do
    local h; h=$(bridge_health "$host" "$port")
    if [ -z "$h" ]; then say "$id: DOWN"; continue; fi
    echo "$h" | python3 -c "
import sys,json;d=json.load(sys.stdin)
print('  %-14s running=%s adopted=%s 认领能力=%s' % (
  d.get('worker_id'), d.get('running_jobs'),
  len(d.get('adopted_jobs') or []), d.get('supports_adoption') is True))"
  done < <(workers)
}

cmd_begin(){ maint true || true; maint_file true; say "✅ 已置维护态（最长 ${WINDOW}s 后自动失效）"; }
cmd_end(){   maint false || true; maint_file false; say "✅ 已清除维护态"; }

cmd_bridges(){
  local rc=0
  while read -r id host port; do
    echo "── 重启 $id ($host) ──"
    local before pids
    before=$(bridge_health "$host" "$port" | python3 -c "
import sys,json
try: print(' '.join(json.load(sys.stdin).get('running_job_refs') or []))
except: print('')" 2>/dev/null)
    say "重启前在跑: ${before:-无}"
    # 记下这些任务的 cc pid，重启后要断言它们还活着
    # ★ 只收【这台 worker】的 cc pid。原来扫的是 runtime/bridge/*（所有 worker），
    #   却拿到当前这台机器上去 [ -d /proc/<pid> ] —— 别台机器的 pid 在这里当然不存在，
    #   于是误报「cc 进程已消失」并中止整次热更新（线上 1.3.6 实测踩到，任务其实好好的）。
    #   dev 也有两台 worker，同样会触发。（从线上拉回）
    pids=$(python3 - "$R" "$id" <<'PY'
import json,sys,glob,os
root,wid=sys.argv[1],sys.argv[2]
out=[]
for f in glob.glob(os.path.join(root,'runtime','bridge',wid,'running','*.json')):
    try:
        idx=json.load(open(f))
        sc=json.load(open(os.path.join(idx['job_dir'],'.running.json')))
        out.append(f"{sc['job_id']}:{sc['pid']}")
    except Exception: pass
print(' '.join(out))
PY
)
    ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -p 8888 "codevideo@$host" \
      "bash $R/scripts/restart-service.sh bridge $id" </dev/null || return 1

    # ★ 关键断言：cc 子进程必须还活着，否则热更新没有生效，立刻停手
    if [ -n "$pids" ]; then
      for e in $pids; do
        local jid=${e%%:*} pid=${e##*:}
        # </dev/null：不加的话 ssh 会吃掉外层 while 循环的 stdin，
        # 后续循环项被静默跳过（经典坑）。（从线上拉回）
        if ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -p 8888 "codevideo@$host" \
             "[ -d /proc/$pid ]" </dev/null 2>/dev/null; then
          say "✅ $jid 的 cc 进程 $pid 仍在运行"
        else
          say "❌ $jid 的 cc 进程 $pid 已消失 —— 热更新未生效，中止（不再动下一台）"
          rc=1; break 2
        fi
      done
    fi
    # 等它注册回来
    for i in $(seq 1 30); do
      local h; h=$(bridge_health "$host" "$port")
      if echo "$h" | grep -q '"registered":true'; then
        echo "$h" | python3 -c "
import sys,json;d=json.load(sys.stdin)
print('  ✅ 已注册，认领 %d 个运行中任务' % len(d.get('adopted_jobs') or []))"
        break
      fi
      sleep 2
    done
  done < <(workers)
  return $rc
}

cmd_gateway(){
  echo "── 重启 Gateway ──"
  GWH=$(j "['deployment']['gateway']['host']")
  ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -p 8888 "codevideo@$GWH" \
    "bash $R/scripts/restart-service.sh gateway" </dev/null || return 1
  for i in $(seq 1 30); do
    if "${C[@]}" -o /dev/null -w '%{http_code}' "$GW/healthz" 2>/dev/null | grep -q 200; then
      say "✅ Gateway 已回来"; return 0
    fi
    sleep 2
  done
  say "❌ Gateway 未在 60s 内恢复"; return 1
}

cmd_run(){
  trap 'cmd_end' EXIT INT TERM       # ★ 任何异常退出都不能把横幅留在那
  # 旧 Bridge 没有认领能力 ⇒ 本次重启会中断任务，必须让人知道
  local legacy=0 n=0
  while read -r id host port; do
    local h; h=$(bridge_health "$host" "$port")
    echo "$h" | grep -q '"supports_adoption":true' || legacy=1
    n=$((n + $(echo "$h" | python3 -c "
import sys,json
try: print(json.load(sys.stdin).get('running_jobs') or 0)
except: print(0)" 2>/dev/null)))
  done < <(workers)
  if [ "$legacy" = 1 ]; then
    echo "当前 Bridge 未确认支持任务认领；拒绝热更新。"; return 1
  fi
  cmd_begin
  cmd_bridges || { echo "❌ Bridge 阶段失败，保留维护态以便排查"; trap - EXIT; return 1; }
  cmd_gateway || { echo "❌ Gateway 阶段失败"; trap - EXIT; return 1; }
  cmd_end
  trap - EXIT
  echo "── 自检 ──"
  # ★ release-check 的「单实例」与「公网入口」两段都只在前端所在机器上成立：
  #   前者按 cwd 查本机进程，后者要能连 NodePort。在后端机器上跑必然红 ——
  #   红的是「跑错机器」，不是部署。所以把自检送到 web.host 上去跑。
  local WEBH out st
  WEBH=$(j "['deployment']['web']['host']")
  # ⚠️ 不能写成 `ssh … | tail || 本机兜底`：release-check 有失败项时也返回非零，
  #    那样「检查发现问题」会被当成「连不上」，于是又在本机跑一遍、
  #    再假红两项公网入口 —— 真正的失败项被噪声埋掉。只认 ssh 自身的 255。
  # ★ 顺序是「先 Bridge 后 Gateway」，所以 Gateway 刚回来的那几秒里
  #   各 Bridge 还在向新 Gateway 重新注册 —— 这时候自检会有一两项瞬时红
  #   （实测：热更新内跑 12/1，隔十几秒单独跑 13/0）。先沉淀，红了再重试一次。
  local rc_once
  rc_once(){ ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -p 8888 \
      "codevideo@$WEBH" "cd $R && bash scripts/release-check.sh" </dev/null 2>&1; }
  sleep 8
  out=$(rc_once); st=$?
  if [ "$st" != 0 ] && [ "$st" != 255 ]; then
    say "自检有红项，等 15s 后重试一次（Bridge 向新 Gateway 重注册需要时间）"
    sleep 15
    out=$(rc_once); st=$?
  fi
  if [ "$st" = 255 ]; then
    say "⚠️ 连不上 $WEBH，自检只能在本机跑（公网入口那两项会假红）"
    bash scripts/release-check.sh 2>&1 | tail -3
  else
    echo "$out" | tail -4
    [ "$st" = 0 ] || return "$st"
  fi
}

case "${1:-status}" in
  status)  cmd_status ;;
  begin)   cmd_begin ;;
  end)     cmd_end ;;
  bridges) cmd_bridges ;;
  gateway) cmd_gateway ;;
  run)     cmd_run ;;
  *) echo "用法: $0 status|begin|bridges|gateway|end|run"; exit 1 ;;
esac
