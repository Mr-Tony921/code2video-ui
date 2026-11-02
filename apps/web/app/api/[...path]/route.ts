/**
 * BFF 转发：把 /api/* 透传到 Gateway。
 *
 * 为什么不用 next.config 的 rewrites：它在 **build 时**固化目标地址，
 * 部署到另一台机器后仍连构建时的地址（实测 ECONNREFUSED 127.0.0.1:9998）。
 * Route Handler 在**运行时**读环境变量，前后端分机部署才成立。
 *
 * 后端地址只出现在这里与环境变量，组件里没有任何 IP/Port。
 */
import type { NextRequest } from 'next/server';
import { gzipSync } from 'node:zlib';

const GATEWAY = process.env.CVW_GATEWAY_BASE_URL ?? 'http://127.0.0.1:9998';

/**
 * 不能转发给上游的逐跳头；host 必须重写，否则上游可能拒绝。
 *
 * ★ accept-encoding 也要挡掉 —— 我们向上游**显式要明文**（见下面的 fetch），
 *   压缩在本层做。原因见 maybeGzip 的注释。
 */
const SKIP_REQ = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding',
  'upgrade', 'proxy-connection', 'content-length', 'accept-encoding']);
/** content-encoding 必须剥掉：上游给的是明文，压缩与这个头都由本层自己设 */
const SKIP_RES = new Set(['connection', 'keep-alive', 'transfer-encoding',
  'content-encoding', 'content-length']);

/** 超过这个大小才值得压（小响应压完更大，还白耗 CPU） */
const GZIP_MIN_BYTES = 1024;

/**
 * 对 JSON 响应做 gzip —— **压缩必须发生在这一层，不是 Gateway**。
 *
 * ★ 为什么不是 Gateway（线上报告建议加在那里，核查后位置是错的）：
 *   真正拥堵的是 **浏览器 ↔ 前端容器**（过公司入口，实测下行只有 43~71 KB/s），
 *   而 **Gateway ↔ 前端** 是局域网（实测 204 MB/s，根本不缺带宽）。
 *   更要紧的是：原来 SKIP_REQ 不含 accept-encoding，浏览器的 gzip 请求头会
 *   原样透传到上游，Node 的 fetch(undici) 拿到 gzip 响应**会自动解压**，
 *   而 SKIP_RES 又把 content-encoding 剥掉 —— 净效果是
 *   「局域网那一跳压了，面向用户的那一跳照旧全量」，等于没救到堵的地方。
 *
 * 所以这里：向上游要 identity（明文，绕开 undici 自动解压的歧义），
 * 然后按浏览器的 accept-encoding 自己压。
 *
 * ⚠️ SSE 与视频流绝不能走这里：
 *   SSE 压缩会因为缓冲破坏实时性；视频本来就是压缩过的，再压纯浪费 CPU，
 *   而且两者都不能缓冲进内存。调用方用 1.4.4 已有的 isSse / isStream 判据跳过。
 */
function maybeGzip(req: NextRequest, body: ArrayBuffer, headers: Headers): BodyInit {
  const accepts = (req.headers.get('accept-encoding') ?? '').toLowerCase().includes('gzip');
  if (!accepts || body.byteLength < GZIP_MIN_BYTES) {
    headers.set('content-length', String(body.byteLength));
    return body;
  }
  const z = gzipSync(Buffer.from(body));
  headers.set('content-encoding', 'gzip');
  headers.set('content-length', String(z.byteLength));
  headers.set('vary', 'accept-encoding');
  return z;
}

/**
 * 上游请求该用的 AbortSignal。
 *
 * ★ 必须把【客户端断开】传下去。原来这里只有「120 秒超时」或 `undefined`，
 *   从来没传过 `req.signal` —— 浏览器 seek、暂停、关页之后，到 Gateway 的
 *   那条请求没有任何人取消，Gateway 的文件读流就一直开着。
 *
 *   1.4.2 为了修「大文件被 120 秒掐断」给视频流去掉了超时，顺手也把那个
 *   「120 秒兜底强关」去掉了 —— 于是有界泄漏变成了无界泄漏。
 *   线上实测：Gateway 141 个 mp4 句柄（78 个压在同一个文件上）、
 *   代理↔网关 153 条 ESTABLISHED、前端 RSS 1.9GB 且仍在涨。
 *
 *   机制是老的（从来不传客户端断开），无界是 1.4.2 造成的。
 *
 * 流式请求（SSE、视频播放/下载）只跟客户端的生命周期，不设超时：
 *   耗时由文件大小与客户端带宽决定，超时会把慢链路上的正常下载切断。
 * 其余请求在客户端断开之外再加 120 秒兜底。
 */
function upstreamSignal(req: NextRequest, streaming: boolean): AbortSignal | undefined {
  const client = req.signal;
  if (streaming) return client ?? undefined;
  const timeout = AbortSignal.timeout(120_000);
  if (!client) return timeout;
  // AbortSignal.any 需要 Node ≥20.3；拿不到就退回只用超时（至少不差于 1.4.1）
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([client, timeout]) : timeout;
}

async function proxy(req: NextRequest, path: string[]) {
  const url = new URL(req.url);
  // path 来自 Next 的动态段，basePath 已被 Next 剥掉，这里拿到的就是
  // /api 之后的部分 —— 所以【不需要】再处理前缀，直接拼给 Gateway。
  // Gateway 永远只认根路径的 /api/*，它不知道也不该知道外部前缀。
  const target = `${GATEWAY.replace(/\/$/, '')}/api/${path.join('/')}${url.search}`;

  const headers = new Headers();
  req.headers.forEach((v, k) => { if (!SKIP_REQ.has(k.toLowerCase())) headers.set(k, v); });

  // ★ 向上游要明文：压缩在本层做（见 maybeGzip）。
  //   不设的话 undici 会自己要 gzip 再自动解压，白做一轮压缩/解压。
  headers.set('accept-encoding', 'identity');

  const isSse = (req.headers.get('accept') ?? '').includes('text/event-stream');
  /**
   * ★ 大文件流式下发不能套超时。
   *
   * 下面那个 `AbortSignal.timeout(120_000)` 原来对【除 SSE 以外的一切】生效，
   * 包括成片播放与下载。40MB 的片子在慢链路上（比如 300KB/s）要 130 秒 ——
   * 到 120 秒连接被代理掐断，浏览器拿到的是截断的响应，于是重试、
   * 看起来就是「视频一直加载不出来/播一半断掉」。
   * 这类请求的耗时由文件大小与客户端带宽决定，不是后端卡住，不该用超时兜。
   */
  const p0 = `/${path.join('/')}`;
  const isStream = /^\/assets\/[^/]+\/(playback|download)$/.test(p0)
    || /^\/examples\/[^/]+\/video$/.test(p0);

  let res: Response;
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      // GET/HEAD 无 body；其余原样透传（含 multipart 的二进制流）
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
      // @ts-expect-error duplex 是 Node fetch 流式上传必需，类型未覆盖
      duplex: 'half',
      redirect: 'manual',
      // SSE、视频流不能有超时；增强虽已异步，仍留足余量
      signal: upstreamSignal(req, isSse || isStream),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    /**
     * 客户端自己断开（seek / 关页 / 暂停）会让上游 fetch 抛 AbortError。
     * 这不是故障：此时响应已经没人接收，返回 502 只会在日志里制造假告警，
     * 还会把「视频播放正常但用户拖了进度条」记成后端不可用。
     * 用 499（nginx 的「客户端已关闭请求」）表达，且不带 body。
     */
    if (req.signal?.aborted) return new Response(null, { status: 499 });
    return Response.json(
      { error: { code: 'GATEWAY_UNREACHABLE', message: `无法连接服务端：${msg}` } },
      { status: 502 },
    );
  }

  const out = new Headers();
  res.headers.forEach((v, k) => { if (!SKIP_RES.has(k.toLowerCase())) out.append(k, v); });

  // SSE / 视频流：直接透传 body，不缓冲（也绝不压缩，见 maybeGzip 的 ⚠️）
  if (isSse || isStream) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  }
  /**
   * 其余（基本都是 JSON API）：缓冲后按需 gzip。
   * 缓冲是安全的 —— 这些响应来自局域网那一跳（204 MB/s），且体积有界
   * （最大的 active-context 全量 dev 实测 652 KB）。
   * 非 JSON（比如个别 text/plain）也走这条，gzip 对它们同样有效。
   */
  const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!res.body || !/json|text\/|javascript/.test(ctype)) {
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  }
  const buf = await res.arrayBuffer();
  const body = maybeGzip(req, buf, out);
  return new Response(body, { status: res.status, statusText: res.statusText, headers: out });
}

type Ctx = { params: Promise<{ path: string[] }> };
const handler = async (req: NextRequest, ctx: Ctx) => proxy(req, (await ctx.params).path);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;

// 转发层不缓存，也不走静态优化
export const dynamic = 'force-dynamic';
export const revalidate = 0;
