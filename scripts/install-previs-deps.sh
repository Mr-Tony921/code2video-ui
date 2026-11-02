#!/usr/bin/env bash
# 安装 whitebox 渲染所需的 node 依赖到共享目录（两台机器共用）。
# 版本来自 assets/skillsets/blockout_3d/whitebox-previs/scripts/package.json
set -uo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$R/runtime/previs-deps"
SRC="$R/assets/skillsets/blockout_3d/whitebox-previs/scripts/package.json"
export PATH="${CVW_NODE22_BIN:-/mnt/afs_toolcall/codevideo/.nvm/versions/node/v22.23.4/bin}:$PATH"
export NO_PROXY="localhost,127.0.0.1,.svc.cluster.local"; export no_proxy="$NO_PROXY"
mkdir -p "$DEST"
cp "$SRC" "$DEST/package.json"
cd "$DEST"
npm install --no-audit --no-fund
echo
echo "已安装到 $DEST"
node -e "
for (const p of ['three','puppeteer-core']) {
  const v = require(\`\${p}/package.json\`).version;
  console.log(\`  \${p} \${v}\`);
}
" 2>/dev/null || true
echo "回填到 config/backend.json 的 runtime_binaries.previs_dependency_root: $DEST"
