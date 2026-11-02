#!/usr/bin/env bash
# 安装 Chrome for Testing 到共享目录（两台机器共用一份）。
#
# ⚠️ 关键：zip 不保留 Unix 权限位，解压后必须从 zip 元数据恢复可执行权限。
# 否则 chrome 能报版本，但一跑就崩在 chrome_crashpad_handler: Permission denied。
set -uo pipefail
V="${CHROME_VERSION:-138.0.7204.168}"
R="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$R/runtime/browser"
ZIP="$ROOT/dl/chrome-linux64.zip"
URL="https://storage.googleapis.com/chrome-for-testing-public/$V/linux64/chrome-linux64.zip"

export HTTP_PROXY="${HTTP_PROXY:-http://10.120.0.246:7890}"
export HTTPS_PROXY="$HTTP_PROXY"
export http_proxy="$HTTP_PROXY" https_proxy="$HTTP_PROXY"
export NO_PROXY="localhost,127.0.0.1,.svc.cluster.local"
export no_proxy="$NO_PROXY"

mkdir -p "$ROOT/dl"

echo "[1/3] 下载 $V（断点续传；代理对大文件易断，-C - 可反复执行直至完整）"
# --retry-all-errors + -C - ：中断后重跑本脚本即可续传
curl -fL --proxytunnel --retry 20 --retry-all-errors --retry-delay 3 \
     -C - --connect-timeout 20 --max-time 1800 -o "$ZIP" "$URL" || true
echo "      大小: $(stat -c%s "$ZIP" 2>/dev/null || echo 0)"

echo "[2/3] 校验并解压"
python3 - "$ZIP" "$ROOT" <<'PY'
import sys, zipfile
zip_path, root = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(zip_path)
bad = z.testzip()
if bad is not None:
    sys.exit(f'zip 损坏于 {bad}；重跑本脚本会续传')
print(f'      zip 完整，{len(z.namelist())} 项')
z.extractall(root)
PY

echo "[3/3] 恢复可执行权限（zip 不保留权限位 —— 这步不能省）"
python3 - "$ZIP" "$ROOT/chrome-linux64" <<'PY'
import sys, zipfile, os, stat
zip_path, target = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(zip_path)
fixed = 0
for info in z.infolist():
    mode = info.external_attr >> 16
    if not mode or info.is_dir():
        continue
    rel = info.filename.split('/', 1)[-1]
    if not rel:
        continue
    p = os.path.join(target, rel)
    if os.path.exists(p) and (mode & stat.S_IXUSR):
        os.chmod(p, mode & 0o7777)
        fixed += 1
print(f'      恢复 {fixed} 个可执行文件')
PY

C="$ROOT/chrome-linux64/chrome"
echo "验证: $("$C" --version 2>&1 | head -1)"
echo
echo "回填到 config/backend.json 的 runtime_binaries.chrome_bin:"
echo "  $C"
