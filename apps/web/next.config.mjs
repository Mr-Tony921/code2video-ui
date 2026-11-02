import { readFileSync } from 'node:fs';
/** @type {import('next').NextConfig} */
// 不用 rewrites —— 它在 build 时固化目标地址，运行时改环境变量无效
// （实测：build 时是 127.0.0.1，部署到前端机器后仍连本机，ECONNREFUSED）。
// 改用 app/api/[...path]/route.ts 在运行时读 CVW_GATEWAY_BASE_URL 转发。

/**
 * Base Path（Kong Ingress 子路径部署）。
 *
 * Next 的 basePath 是【构建期】常量，负责页面路由与 _next/* 静态资源；
 * 我们手写的 fetch/EventSource/<a href> 另由 lib/base-path.ts 处理。
 * 两者读同一个环境变量，保证一致。
 *
 *   根路径（EIP+Port 直连）：不设 → basePath 为空，行为与现在完全一致
 *   子路径（Kong）：NEXT_PUBLIC_BASE_PATH=/subpath 后重新 build
 */
const raw = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').trim();
const basePath = !raw || raw === '/' ? '' : `/${raw.replace(/^\/+|\/+$/g, '')}`;

/**
 * 版本号与环境角标：构建期从【唯一来源】读，不要在组件里写死。
 *
 * ★ 为什么必须这样：
 *   原来 `_workspace.tsx` 里是两个写死的常量
 *     const APP_VERSION = '1.4.1';
 *     const ENV_LABEL   = '开发环境';
 *   前者每次发版都要手工改，忘了就界面显示旧版本 —— 实测 VERSION 已经是
 *   1.4.2、Gateway 也报 1.4.2，而页面角标还是 v1.4.1，
 *   偏偏 `release-check.sh` 的「前后端版本一致」比的是 VERSION 文件 vs Gateway，
 *   **前端那一侧根本没查**，所以它还是绿的（假绿，已一并修）。
 *   后者更危险：dev 写死「开发环境」，于是这个文件在 dev 与线上永远有一行差异，
 *   每次同步都得人工记住「这行不要带过去」—— 带错一次线上就显示「开发环境」。
 *
 *   改成从文件派生后，这个文件在两个环境**完全一致**，可以整文件覆盖同步。
 *   `config/backend.json` 的 `environment.display` 本来就是为此准备的
 *   （它的 $note 写着「前端显示角标」），只是一直没接上。
 *
 * 读不到就退化成空：构建不该因为读配置失败而挂。
 */
const repoRoot = new URL('../../', import.meta.url);
const readOr = (rel, pick) => {
  try { return pick(readFileSync(new URL(rel, repoRoot), 'utf8')) ?? ''; }
  catch { return ''; }
};
const appVersion = readOr('VERSION', (t) => t.trim());
const envLabel = readOr('config/backend.json',
  (t) => (JSON.parse(t).environment ?? {}).display ?? '');

const nextConfig = {
  reactStrictMode: true,
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  env: {
    NEXT_PUBLIC_APP_VERSION: appVersion,
    NEXT_PUBLIC_ENV_LABEL: envLabel,
  },
};
export default nextConfig;
