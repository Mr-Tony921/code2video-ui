'use client';

import dynamic from 'next/dynamic';

/** ssr: false 必须在 Client Component 里声明 —— Server Component 中不允许 */
const Workspace = dynamic(() => import('./_workspace'), {
  ssr: false,
  loading: () => (
    <div className="center">
      <p className="muted">正在加载…</p>
    </div>
  ),
});

export function ClientOnly() {
  return <Workspace />;
}
