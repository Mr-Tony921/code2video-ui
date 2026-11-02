/**
 * Base Path 适配（Kong Ingress 子路径部署）。
 *
 * 背景：Kong 转发 `/subpath/xxx` 时会剥掉前缀，应用收到的是 `/xxx`，
 * 于是应用以为自己在根路径。但【浏览器地址栏仍带 /subpath】，
 * 所以页面里写死的 `/api/...` 会被浏览器解析成 `https://host/api/...`，
 * 绕过了 Kong 的路由规则 → 404。
 *
 * 做法：所有前端发起的绝对路径统一经 withBase() 加前缀。
 * Next.js 自身的 basePath 配置负责页面路由与静态资源（_next/*），
 * 这里只负责我们手写的 fetch / EventSource / sendBeacon / <a href>。
 *
 * 配置：构建时设 NEXT_PUBLIC_BASE_PATH=/subpath（不设即根路径，行为不变）。
 * 必须是 NEXT_PUBLIC_ 前缀 —— 客户端代码要读它。
 */

/** 规范化：去尾斜杠、补头斜杠；根路径统一成空串 */
function normalize(v: string | undefined): string {
  if (!v) return '';
  let s = v.trim();
  if (!s || s === '/') return '';
  if (!s.startsWith('/')) s = `/${s}`;
  return s.replace(/\/+$/, '');
}

/**
 * 构建时注入的前缀。
 * 注意：不能写成 process.env[someVar] —— Next 的替换是【字面量匹配】，
 * 动态下标取不到值，构建后会变成 undefined。
 */
export const BASE_PATH = normalize(process.env.NEXT_PUBLIC_BASE_PATH);

/**
 * 给站内绝对路径加前缀。
 * 只处理以 "/" 开头的路径；完整 URL（http://、//cdn）原样返回。
 */
export function withBase(path: string): string {
  if (!BASE_PATH) return path;
  if (!path.startsWith('/')) return path;        // 相对路径不碰
  if (path.startsWith('//')) return path;        // 协议相对 URL
  if (path.startsWith(`${BASE_PATH}/`) || path === BASE_PATH) return path;  // 已加过，不重复
  return `${BASE_PATH}${path}`;
}
