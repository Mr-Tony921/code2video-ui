#!/usr/bin/env bash
# 挑一个 ≥22 的 node 钉到 PATH 最前；挑不到就让调用方拒绝启动。
#   用法: . scripts/node-guard.sh && require_node18 "Gateway" runtime/logs/gateway.log
#
# ★ 为什么不能信任 PATH（2026-10-28 线上真实事故）：
#   Gateway 当天迁到前端机，那台机器 /usr/local/bin 下没有 node，
#   PATH 一路落到 /usr/local/nvm/versions/node/v16.20.2/bin —— node 16 没有全局 fetch。
#   结果 Gateway 起来了、healthz 也通，但【每一次派发都失败】：
#       [dispatcher] job_617ea4f0 失败: E_BRIDGE_START_FAILED fetch is not defined
#   用户 timmy_demo 的两个任务就这么没了，11:04 换成 v22 重启才恢复。
#
#   所以宁可【起不来被立刻发现】，也不要起一个「看着健康、一派发就崩」的服务。
#
# ★ Bridge 同样需要 ≥22：它靠 fetch 调 Gateway（gateway-client.mjs）、
#   也用 fetch 探测模型的 max_model_len（config.mjs）。线上的 svc-run-bridge.sh
#   目前没有这道守卫，是同一个坑还没堵的那一半。
require_node18() {
  local who="${1:-服务}" logf="${2:-}" c maj v
  # 显式指定优先（CVW_NODE_BIN；CVW_NODE22_BIN 是旧名，保持兼容）
  local pin="${CVW_NODE_BIN:-${CVW_NODE22_BIN:-}}"
  if [ -n "$pin" ] && [ -x "$pin/node" ]; then
    export PATH="$pin:$PATH"
  else
    for c in /usr/local/bin \
             /mnt/afs_toolcall/codevideo/.nvm/versions/node/v22.23.4/bin \
             /usr/local/nvm/versions/node/v22*/bin; do
      [ -x "$c/node" ] || continue
      maj=$("$c/node" --version 2>/dev/null); maj=${maj#v}; maj=${maj%%.*}
      [ -n "$maj" ] && [ "$maj" -ge 22 ] 2>/dev/null && { export PATH="$c:$PATH"; break; }
    done
  fi
  v=$(node --version 2>/dev/null); maj=${v#v}; maj=${maj%%.*}
  if [ -z "$maj" ] || [ "$maj" -lt 22 ] 2>/dev/null; then
    local m="❌ node 版本过低（${v:-未找到 node}），$who 需要 ≥22（全局 fetch）。用 CVW_NODE_BIN 指定一个 ≥22 的 node 目录。"
    echo "  $m"
    [ -n "$logf" ] && echo "[node-guard] $m" >> "$logf" 2>/dev/null
    return 1
  fi
  echo "  node $v ($(command -v node))"
  return 0
}
