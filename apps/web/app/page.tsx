import { ClientOnly } from './client-only';

/**
 * 主页面。
 *
 * 工作区必须【纯客户端渲染】：它依赖 localStorage、EventSource 与登录状态，
 * SSR 时这些都不存在 —— 服务端渲染 loading 态、客户端渲染登录页，
 * 两者 DOM 结构不同会触发 hydration mismatch，React 丢弃 SSR 结果重建，
 * 表现为 "Application error: a client-side exception has occurred"。
 */
export default function Page() {
  return <ClientOnly />;
}
