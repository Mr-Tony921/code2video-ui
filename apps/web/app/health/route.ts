/**
 * 前端存活探针，供公网转发/负载均衡使用：GET|HEAD /health → 200 "ok"
 *
 * 刻意【只反映本进程能否服务】，不去探 Gateway：
 * 探针若依赖后端，Gateway 抖一下就会让转发把前端整个摘掉 —— 可那时候
 * 登录页、静态资源其实都还好着，摘掉只会让故障面变大。
 * 后端健康另有 Gateway 自己的 /healthz。
 *
 * 不鉴权、不碰 Cookie、不输出任何内部信息（地址/版本/路径都不给），
 * 因为这个地址是公网可达的。
 */
export async function GET() {
  return new Response('ok', {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  });
}

/** 有些负载均衡用 HEAD 探活 */
export async function HEAD() {
  return new Response(null, {
    status: 200,
    headers: { 'cache-control': 'no-store, no-cache, must-revalidate' },
  });
}

// 探针必须反映【当前】进程状态，不能被预渲染成静态产物
export const dynamic = 'force-dynamic';
export const revalidate = 0;
