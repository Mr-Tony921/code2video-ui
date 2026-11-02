#!/usr/bin/env bash
# 清理属于某 job 工作区的残留进程（headless Chromium、脱离的渲染、后台 shell）。
#   kill-leftovers.sh <job_ws> [<job_token>]
#
# 判定归属（任一成立）：
#   · 环境里有 CVW_JOB_TOKEN=<job_token>（给了 token 就按它精确匹配）
#   · 环境里有 CVW_JOB_TOKEN=<job_ws>... （没给 token 时的旧规矩，兼容 1.3.x）
#   · 工作目录在 <job_ws> 之下
#   · 命令行里出现 <job_ws>
# 永不匹配：调用者自身与其祖先、裸交互 shell、tmux。
#
# ★ 1.4.0：工作区按会话共用后，CVW_JOB_TOKEN 变成 `<job_ws>#<job_id>`，
#   不再是工作区路径本身。所以必须把 token 单独传进来 ——
#   只按 `CVW_JOB_TOKEN=$DIR(/|$)` 匹配会一个都匹配不上，清残留静默失效，
#   headless Chromium 会一轮一轮堆下去。
#   仍然【只按归属】匹配，绝不按进程名/模式匹配（当年 pgrep -f "chrome-linux64"
#   把 cc 自己匹配上并 SIGKILL 的事故，根因就是模式匹配）。
#
# 改编自 wupenghao 的 bench_runner/procs.sh。
set -uo pipefail
DIR=${1%/}
TOKEN=${2:-}
[ -n "$DIR" ] || exit 0

ancestors() {
    local chain=" " p=$$
    while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do
        chain+="$p "
        p=$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null)
    done
    echo "$chain"
}

find_procs() {
    local chain pid args cwd d
    chain=$(ancestors)
    for d in /proc/[0-9]*; do
        pid=${d#/proc/}
        case "$chain" in *" $pid "*) continue ;; esac
        args=$(tr '\0' ' ' 2>/dev/null < "$d/cmdline") || continue
        [ -n "$args" ] || continue
        case "$args" in
            "bash " | "-bash " | "sh " | "zsh " | "-zsh " | "fish " | tmux*) continue ;;
        esac
        cwd=$(readlink "$d/cwd" 2>/dev/null)
        tokhit=1
        if [ -n "$TOKEN" ]; then
            tr '\0' '\n' 2>/dev/null < "$d/environ" | grep -qxF "CVW_JOB_TOKEN=$TOKEN" || tokhit=0
        else
            tr '\0' '\n' 2>/dev/null < "$d/environ" | grep -q "^CVW_JOB_TOKEN=$DIR\(/\|$\)" || tokhit=0
        fi
        if [ "$tokhit" = 1 ] \
            || [ "$cwd" = "$DIR" ] || [ "${cwd#"$DIR"/}" != "$cwd" ] \
            || [ "${args#*"$DIR"}" != "$args" ]; then
            echo "$pid"
        fi
    done
}

killed=0
for round in 1 2 3; do
    pids=$(find_procs)
    [ -z "$pids" ] && break
    n=$(echo "$pids" | wc -l)
    kill -9 $pids 2>/dev/null
    killed=$((killed + n))
    sleep 1
done
echo "{\"killed\":$killed}"
