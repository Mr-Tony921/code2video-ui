#!/usr/bin/env bash
# whitebox 3D 真实渲染：three.js 场景 → Chrome 逐帧 → ffmpeg 编码 → mp4
set -euo pipefail
R="$(cd "$(dirname "$0")/../.." && pwd)"
SKILL=$R/assets/skillsets/blockout_3d/whitebox-previs
export CHROME_BIN="$R/runtime/browser/chrome-linux64/chrome"
export PREVIS_DEPENDENCY_ROOT="$R/runtime/previs-deps"
export NO_PROXY="localhost,127.0.0.1,.svc.cluster.local"; export no_proxy="$NO_PROXY"
NODE=/usr/local/bin/node
P=$(mktemp -d /tmp/cvw-codex-wb-e2e.XXXXXX)
trap '"$NODE" "$SKILL/scripts/runtime.mjs" stop --project "$P" >/dev/null 2>&1 || true; rm -rf "$P"' EXIT
python3 "$R/scripts/guard-isolation.py"

echo "=== 启动 runtime ==="
OUT=$(timeout 90 "$NODE" "$SKILL/scripts/runtime.mjs" start --project "$P" --init 2>&1 | tail -1)
echo "  $OUT"
URL=$(echo "$OUT" | python3 -c "import json,sys;print(json.load(sys.stdin)['url'])" 2>/dev/null)
[ -z "$URL" ] && { echo "❌ 启动失败"; exit 1; }

echo "=== 写白模场景（three.js，时间为唯一输入）==="
cat > "$P/main.js" <<'JS'
// 白模预演：灰阶几何体 + 相机环绕。frame(t) 必须是 t 的纯函数。
import * as THREE from 'three';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(640, 360, false);
document.body.style.margin = '0';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202024);

const camera = new THREE.PerspectiveCamera(50, 640 / 360, 0.1, 100);

// 白模材质：无贴图，纯灰阶
const mat = new THREE.MeshStandardMaterial({ color: 0xb8b8bc, roughness: 0.75 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: 0x6e6e74, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// 一个"演员"方块 + 两个遮挡物，用于测试空间站位
const actor = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), mat);
actor.position.y = 1;
scene.add(actor);
for (const x of [-3, 3]) {
  const b = new THREE.Mesh(new THREE.BoxGeometry(1.2, 3, 1.2), mat);
  b.position.set(x, 1.5, -2);
  scene.add(b);
}

scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 1.4);
dir.position.set(5, 8, 4);
scene.add(dir);

// ★ 时间是唯一输入：同一个 t 必须永远给出同一帧
window.seek = async (t) => {
  const DUR = 3;
  const u = Math.min(Math.max(t / DUR, 0), 1);
  // 演员沿直线走动
  actor.position.z = -4 + u * 8;
  // 相机环绕 90°
  const a = (-Math.PI / 4) + u * (Math.PI / 2);
  camera.position.set(Math.sin(a) * 10, 4.5, Math.cos(a) * 10);
  camera.lookAt(0, 1, 0);
  renderer.render(scene, camera);
};
window.READY = true;
JS

echo "=== 渲染 3 秒 @ 24fps（Chrome 逐帧 + ffmpeg 编码）==="
timeout 170 "$NODE" "$SKILL/scripts/render.mjs" \
  --url "$URL" --project "$P" --out "$P/previs.mp4" \
  --duration 3 --width 640 --height 360 --fps 24 2>&1 | tail -12

echo "=== 产物验证 ==="
if [ -f "$P/previs.mp4" ]; then
  ls -la "$P/previs.mp4" | awk '{print "  "$9"  "$5" bytes"}'
  ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,nb_frames \
    -show_entries format=duration -of default=noprint_wrappers=1 "$P/previs.mp4" 2>&1 | sed 's/^/  /'
  echo "  --- 完整解码检查 ---"
  ffmpeg -v error -i "$P/previs.mp4" -f null - 2>&1 | head -3
  echo "  解码: $([ $? -eq 0 ] && echo '✅ 无错误' || echo '❌ 有错误')"
  cp "$P/previs.mp4" "$R/runtime/whitebox-previs-sample.mp4" 2>/dev/null && echo "  已复制到 runtime/whitebox-previs-sample.mp4"
else
  echo "  ❌ 未产出 mp4"
  tail -20 "$P/runtime-server.log" 2>/dev/null || true
  exit 1
fi

timeout 40 "$NODE" "$SKILL/scripts/runtime.mjs" stop --project "$P" 2>&1 | tail -1
