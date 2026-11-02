#!/usr/bin/env bash
# 在新建的挂载命名空间里重排视图，然后 exec 真正的命令。
#   isolate.sh <job_ws> <hide_paths_csv> <mount_point> <binds_csv> -- <command> [args...]
#   binds_csv: 形如 "/src1:/dst1,/src2:/dst2"，在遮蔽前先把宿主路径 bind 到
#              命名空间内的浅路径。用于 chrome / previs-deps 这类装在被遮蔽
#              目录（/mnt）下、但任务必须用到的运行时依赖。
#
# agent 看到的：
#   /tmp              本 job 的 <job_ws>/.tmp（私有、持久）
#   共享存储          空目录（遮蔽 AFS）—— 避免 claude 跑 find / 全盘搜索卡数分钟
#   工作区            仍在原路径可读写
# 只改本命名空间，宿主视图不变。
#
# 改编自 wupenghao 的 bench_runner/isolate.sh。
# 差异：我们非 root（uid 10207），用 unshare --user --map-root-user；
# 暂存点用 /tmp（它最后会被换掉），不能用 /mnt —— 工作区就在 /mnt 下面。
set -uo pipefail
WS=$1; HIDE_CSV=$2; MOUNT_POINT=${3:-/workspace}; BINDS_CSV=${4:-}; shift 5   # $5 是 "--"

fallback() {
    echo "[isolate] $1，放弃隔离直接执行（宿主视图）" >&2
    cd "$WS" || exit 1
    exec "$@"
}

mount --make-rprivate / 2>/dev/null || true

# 1) 暂存：把工作区先 bind 到 /tmp 下。
#    /tmp 在第 4 步会被整体换成本 job 的 .tmp，所以借用它不留痕迹。
STAGE=/tmp/.cvw-stage.$$
mkdir -p "$STAGE" 2>/dev/null || fallback "无法建暂存点" "$@"
mount --bind "$WS" "$STAGE" 2>/dev/null || fallback "bind 工作区失败" "$@"

# 1b) 运行时依赖（chrome / previs-deps）同样要先暂存：
#     它们装在 /mnt 下，第 2 步一遮蔽就看不见了。做法与工作区一致 ——
#     先 bind 到 /tmp 暂存点，遮蔽后再挂到命名空间内的浅路径。
#     这样不必把 500MB 依赖拷贝到每台机器的本地盘。
DEP_N=0
declare -a DEP_STAGE DEP_DST
if [ -n "$BINDS_CSV" ]; then
    IFS=',' read -ra BINDS <<< "$BINDS_CSV"
    for pair in "${BINDS[@]}"; do
        [ -z "$pair" ] && continue
        src=${pair%%:*}; dst=${pair#*:}
        [ -z "$src" ] || [ -z "$dst" ] && continue
        [ -e "$src" ] || { echo "[isolate] 依赖不存在，跳过: $src" >&2; continue; }
        st="/tmp/.cvw-dep.$$.$DEP_N"
        if [ -d "$src" ]; then mkdir -p "$st" 2>/dev/null; else : > "$st" 2>/dev/null; fi
        if mount --bind "$src" "$st" 2>/dev/null; then
            DEP_STAGE[$DEP_N]="$st"; DEP_DST[$DEP_N]="$dst"; DEP_N=$((DEP_N+1))
        else
            echo "[isolate] 暂存依赖失败: $src" >&2
        fi
    done
fi

# 2) 遮蔽共享存储（这会同时盖住工作区的原路径，第 3 步再挂回来）
IFS=',' read -ra HIDE <<< "$HIDE_CSV"
for d in "${HIDE[@]}"; do
    [ -z "$d" ] && continue
    [ -d "$d" ] && mount -t tmpfs -o mode=755,size=1m cvw-hidden "$d" 2>/dev/null || true
done

# 3) 工作区挂到【浅路径】 $CVW_WS_MOUNT（默认 /workspace）。
#    不挂回原来的深路径：那条路径在 /mnt/afs_toolcall/... 之下，
#    find / 必须穿过它，实测 maxdepth 7 要 40 秒。挂到浅路径后
#    遮蔽层下面什么都不剩，全盘搜索瞬间返回。
MP=$MOUNT_POINT
mkdir -p "$MP" 2>/dev/null || true
if ! mount --bind "$STAGE" "$MP" 2>/dev/null; then
    echo "[isolate] 工作区挂到 $MP 失败" >&2
    cd "$STAGE" || exit 1          # 退一步：在暂存路径下跑，仍是隔离的
    exec "$@"
fi
umount "$STAGE" 2>/dev/null || true
rmdir "$STAGE" 2>/dev/null || true
WS=$MP                             # 后续的 .tmp 与 cd 都用新路径

# 3b) 依赖挂到命名空间内的浅路径（必须在换 /tmp 之前完成 —— 暂存点在 /tmp 下）
i=0
while [ $i -lt $DEP_N ]; do
    st=${DEP_STAGE[$i]}; dst=${DEP_DST[$i]}
    # dst 必须【已存在】：/ 在容器 overlay 下不可写，即便 map-root 也建不了
    # 新目录（实测 mkdir /cvw → Permission denied）。所以挂到现成的空目录。
    if [ ! -e "$dst" ]; then
        mkdir -p "$dst" 2>/dev/null \
            || { echo "[isolate] 挂载点不存在且无法创建: $dst —— 请改用已存在的空目录" >&2
                 umount "$st" 2>/dev/null; i=$((i+1)); continue; }
    fi
    mount --bind "$st" "$dst" 2>/dev/null \
        || echo "[isolate] 依赖挂载失败: $dst（任务可能回退到自行下载）" >&2
    umount "$st" 2>/dev/null || true
    [ -d "$st" ] && rmdir "$st" 2>/dev/null || rm -f "$st" 2>/dev/null
    i=$((i+1))
done

# 4) /tmp 换成本 job 的 .tmp
#    Chromium 的 Unix socket 有 ~108 字节路径限制，深层工作区路径会让它起不来，
#    换成短 /tmp 可规避。
mkdir -p "$WS/.tmp" 2>/dev/null || true
mount --bind "$WS/.tmp" /tmp 2>/dev/null || true

cd "$WS"
exec "$@"
