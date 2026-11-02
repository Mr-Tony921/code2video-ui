'use client';
/**
 * 示例 prompt 列表（左栏）。
 *
 * ★ 1.4.1：点击**不再直接填入输入框**，改为交给上层弹出 ExampleDialog
 * （用户要求：先把 prompt 与示例片展示出来，确认后再新建对话导入）。
 * 原来的「预览」折叠按钮随之去掉 —— 弹框里就是完整内容，两套预览只会互相干扰；
 * 底部那句扩写说明也挪进了弹框，那里才是真正要做决定的地方。
 *
 * 这里只负责「列出来 + 点开」，所以**不再需要 disabled**：
 * 看示例在任何状态下都应该可以，能不能导入由弹框按钮判断。
 */
import { Collapsible } from './Collapsible';
import type { ExamplePrompt, Mode } from '@/lib/types';

export function ExampleList({ examples, mode, onPick }: {
  examples: ExamplePrompt[];
  mode: Mode;
  onPick: (ex: ExamplePrompt) => void;
}) {
  // 只显示当前模式的 —— 白模示例在 Coding 模式下点了也用不上
  const list = examples.filter((e) => e.mode === mode);
  if (!list.length) return null;

  return (
    <Collapsible title="示例参考" count={list.length} storageKey="examples">
      {list.map((ex) => (
        <div key={ex.id} className="card compact click" style={{ marginBottom: 6 }}
             onClick={() => onPick(ex)}
             title="点击查看示例详情">
          <div className="row" style={{ fontSize: 13, gap: 6 }}>
            <span aria-hidden>✦</span>
            <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ex.title}
            </span>
            {/* 有示例片的标出来，否则用户不知道哪些能看 */}
            {ex.video && <span className="tiny" style={{ opacity: .7 }} title="含示例片">▶</span>}
          </div>
          {ex.note && (
            <div className="tiny" style={{ marginTop: 2, opacity: .75 }}>{ex.note}</div>
          )}
        </div>
      ))}
    </Collapsible>
  );
}
