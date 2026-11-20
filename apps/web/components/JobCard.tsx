'use client';
/**
 * 任务卡片。各状态的展示规则见 docs/PRODUCT_UX.md §5.1。
 *
 * 两条铁律：
 *  · progress_percent 为 null 时用不确定动画，【绝不】显示百分比
 *  · 点击停止后显示「正在请求停止…」，【绝不】假装已取消
 */
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { withBase } from '@/lib/base-path';
import { clean } from '@/lib/sanitize';
import { copyText } from '@/lib/clipboard';
import {
  PHASE_LABEL, STATUS_COLOR, STATUS_LABEL, formatBytes, formatDuration, healthNote,
} from '@/lib/format';
import type { Job } from '@/lib/types';
import { isTerminal } from '@/lib/types';

const ICON: Record<string, string> = {
  ENHANCING: '✦', OUT_OF_SCOPE: 'ⓘ',
  QUEUED: '⏳', ASSIGNED: '⟳', RUNNING: '⟳',
  CANCEL_REQUESTED: '⏸', CANCELLING: '⏹', CANCELLED: '⛔',
  COMPLETED: '✓', FAILED: '✕', UNKNOWN: '?', RECOVERING: '?',
};

export function JobCard({ job, onChanged, onEditPrompt }: {
  job: Job;
  onChanged?: () => void;
  /** 停止后把原 prompt 回填到输入框，供修改重投（误发时不必新建对话） */
  onEditPrompt?: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showPlan, setShowPlan] = useState(false);
  const [previewSize, setPreviewSize] = useState<{ url: string; width: number; height: number } | null>(null);
  const loadedPreview = previewSize?.url === job.result_asset?.playback_url ? previewSize : null;
  const health = healthNote(job);
  const running = !isTerminal(job.status);
  const canCancel = running && !job.cancellation.requested_at;

  async function cancel() {
    setBusy(true);
    setNotice(null);
    try {
      await api.cancelJob(job.id);
      onChanged?.();
    } catch (e) {
      // 完成瞬间点停止：服务端裁决完成优先，这里不显示为错误
      if (e instanceof ApiError && e.code === 'JOB_ALREADY_TERMINAL') {
        setNotice('任务已在取消生效前完成');
        onChanged?.();
      } else {
        setNotice(e instanceof ApiError ? e.message : '取消请求失败');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card job" style={{ borderLeftColor: STATUS_COLOR[job.status] }}>
      <div className="title">
        <span aria-hidden>{ICON[job.status] ?? '•'}</span>
        <span>{STATUS_LABEL[job.status]}</span>
        {job.elapsed.running_ms != null && (
          <span className="muted">· 已运行 {formatDuration(job.elapsed.running_ms)}</span>
        )}
        {job.status === 'QUEUED' && job.elapsed.queued_ms != null && (
          <span className="muted">· 已等待 {formatDuration(job.elapsed.queued_ms)}</span>
        )}
      </div>

      {job.mode === 'blockout_3d' && job.whitebox_result?.scene_success && <div style={{ marginTop: 10 }}>
        <p className="tiny">{job.whitebox_result.model} · 工程生成 {formatDuration(job.whitebox_result.timings.engineering_seconds * 1000)} · 视频渲染 {formatDuration(job.whitebox_result.timings.video_seconds * 1000)} · {job.whitebox_result.shot_count} 镜</p>
        {job.whitebox_result.download_url && <a className="btn" href={withBase(job.whitebox_result.download_url)} download>下载代码与工程</a>}
      </div>}

      {/* 排队可见性：告诉用户前面还有几个、一共几个 */}
      {job.status === 'QUEUED' && job.queue && (
        <div className="note info" style={{ marginTop: 10 }}>
          <strong>排队中</strong>
          {job.queue.position != null ? (
            <> —— 第 <strong>{job.queue.position}</strong> 位，共 {job.queue.total} 个任务在排队
              {job.queue.ahead > 0 && <>（前面还有 {job.queue.ahead} 个）</>}
            </>
          ) : <> —— 共 {job.queue.total} 个任务在排队</>}
          <div className="tiny" style={{ marginTop: 4, opacity: .8 }}>
            有空闲算力时会自动开始，期间请保持页面开启。
          </div>
        </div>
      )}

      {/* 增强中：用户不需要看 dense prompt，只要知道在进行（V2 需求 3） */}
      {job.status === 'ENHANCING' && (
        <>
          <div className="indet" style={{ marginTop: 10 }} aria-label="正在理解需求" />
          <div className="note info" style={{ marginTop: 8 }}>
            正在理解你的创作需求并准备制作方案，完成后会自动开始生成。
          </div>
        </>
      )}

      {/* 非视频请求（V2） */}
      {job.status === 'OUT_OF_SCOPE' && job.notice && (
        <div className="note warn" style={{ marginTop: 10 }}>
          <strong>{job.notice.title}</strong>
          <div style={{ marginTop: 5 }}>{job.notice.message}</div>
          {job.notice.suggestions.length > 0 && (
            <div className="row wrap" style={{ marginTop: 8 }}>
              {job.notice.suggestions.map((sg) => <span key={sg} className="badge">{sg}</span>)}
            </div>
          )}
        </div>
      )}

      {/* 进度：后端给了百分比才画进度条，否则用不确定动画 */}
      {job.status === 'RUNNING' && (
        <div style={{ marginTop: 10 }}>
          {job.progress_percent != null ? (
            <>
              <div className="bar"><i style={{ width: `${job.progress_percent}%` }} /></div>
              <div className="tiny" style={{ marginTop: 4 }}>{job.progress_percent}%</div>
            </>
          ) : (
            <div className="indet" aria-label="正在生成，进度未知" />
          )}
        </div>
      )}

      {/* 只在执行中显示阶段；prompt 已经以气泡形式显示在上方，不再重复一遍 */}
      {running && job.phase && (
        <div className="meta">
          <span className="tiny">
            阶段：{PHASE_LABEL[job.phase] ?? job.phase}
            {job.elapsed.current_phase_ms != null && ` · 本阶段已 ${formatDuration(job.elapsed.current_phase_ms)}`}
          </span>
        </div>
      )}

      {running && health && (
        <div className={`note ${health.tone}`} style={{ marginTop: 10 }}>{health.text}</div>
      )}

      {/* 心跳策略：presence 阈值已调到与任务上限同级（12h），等于不再因关页而自动停止。
          所以这里【不能】再写"关闭超 N 分钟会停止" —— 那是假的，且曾让用户白丢 188 分钟。
          阈值在 config/backend.json 的 presence.timeout_seconds，不要在文案里重复写死数字。 */}
      {running && job.status !== 'ENHANCING' && (
        <div className="tiny" style={{ marginTop: 8, color: 'var(--mute)' }}>
          生成在后端进行，关闭网页不会中断；重新打开本页即可继续查看进度。
        </div>
      )}

      {/* 任务过重：给可操作的建议，而不是只抛错误码 */}
      {job.status === 'FAILED' && job.failure?.code === 'E_TASK_TOO_COMPLEX' && (
        <div className="note warn" style={{ marginTop: 8 }}>
          <strong>内容过于复杂，未能完成</strong>
          <div style={{ marginTop: 5 }}>{clean(job.failure.message)}</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
            <li>把时长缩短（例如先做 5~10 秒）</li>
            <li>减少镜头数量，或去掉过多的细节要求</li>
            <li>拆成几段分别生成，再自行拼接</li>
          </ul>
        </div>
      )}

      {job.status === 'FAILED' && job.failure?.code && job.failure.code !== 'E_TASK_TOO_COMPLEX' && (
        <div className="note bad" style={{ marginTop: 8 }}>
          原因：{clean(job.failure.message)}
          <div className="mono" style={{ marginTop: 3 }}>错误码：{clean(job.failure.code)}</div>
        </div>
      )}

      {job.status === 'FAILED' && !job.failure?.code && <div className="note bad" style={{ marginTop: 8 }}>任务未完成，错误详情暂未返回。可稍后重新查看。</div>}

      {job.status === 'CANCELLED' && (
        <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
          {job.cancellation.effective
            ? '后端已确认停止' + (job.cancellation.resources_released_at ? '，资源已释放' : '')
            : '取消状态未完全确认'}
        </div>
      )}

      {/* 产物：播放 + 下载 */}
      {job.status === 'COMPLETED' && job.result_asset?.playable && (
        <div style={{ marginTop: 12 }}>
          {/*
            ★ 不要加 loop。
            成片常常只有 1~2 秒，而 loop 每次回绕都是一次 seek：
            readyState 掉到 1 再回 4，浏览器会连发 seeking→waiting→seeked，
            画面跟着顿一下。短片子就是「每一两秒断一次」——
            用户实测反馈「第一次播放中间断了很多次」，还以为是内网问题。
            A/B 实测（1 秒的片子、8 秒观察窗）：
              loop 开 → waiting 9 次、seek 8 次
              loop 关 → waiting 1 次（只有起播那一次）、seek 0 次
            而且整段播放期间 /playback 请求 0 条（全在缓存里），
            所以它跟网络无关，纯粹是 loop 带来的解码器重置。
            要反复看有 controls 可以重播。
          */}
          <video controls controlsList="nodownload" autoPlay muted playsInline preload="metadata"
                 onLoadedMetadata={(e) => setPreviewSize({ url: job.result_asset!.playback_url, width: e.currentTarget.videoWidth, height: e.currentTarget.videoHeight })}
                 src={withBase(job.result_asset.playback_url)} />
          <div className="row wrap tiny" style={{ marginTop: 8 }}>
            {loadedPreview && <span>预览 {loadedPreview.width}×{loadedPreview.height}</span>}
            {job.result_asset.width && job.result_asset.height && (
              <span>· 原片 {job.result_asset.width}×{job.result_asset.height}</span>
            )}
            {job.result_asset.duration_ms && <span>· {(job.result_asset.duration_ms / 1000).toFixed(1)} 秒</span>}
            <span>· 原片 {formatBytes(job.result_asset.size_bytes)}</span>
            <span>· 耗时 {formatDuration(job.elapsed.running_ms)}</span>
          </div>
          <div className="note tiny" style={{ marginTop: 6 }}>
            {loadedPreview && loadedPreview.height > 480
              ? '预览转换暂未就绪，当前播放原片。'
              : '网页默认使用最高 480P 预览，较小视频不放大；原片保留，可用下方按钮独立下载。'}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            {/*
              ★ 这个按钮下的是【原片】（/download 永远给原片）。
              视频播放器自带的下载按钮下的是 currentSrc，也就是压缩后的预览片 ——
              两条路各自对应一种需求，不要混。
            */}
            <a className="btn primary" href={withBase(job.result_asset.download_url)} download>
              ⬇ 下载原片{job.result_asset.preview?.mode === 'reencode'
                ? `（${formatBytes(job.result_asset.size_bytes)}）` : ''}
            </a>
            <a className="btn" href={withBase(job.result_asset.playback_url)} target="_blank" rel="noreferrer">
              新窗口打开
            </a>
          </div>
          {job.result_asset.preview?.mode === 'reencode' && (
            <div className="note tiny" style={{ marginTop: 6 }}>
              ⏳ 下载原片受网络策略限制，速度较慢，请耐心等待；期间不要关闭页面。
            </div>
          )}
        </div>
      )}

      {job.status === 'COMPLETED' && job.result_asset && !job.result_asset.playable && (
        <div className="note warn" style={{ marginTop: 10 }}>
          产物状态为 {job.result_asset.state}，暂不可播放。
        </div>
      )}

      {/* 完成但没有产物：必须明说，不能静默留白 */}
      {job.status === 'COMPLETED' && job.response && (
        <div className="note" style={{ marginTop: 10 }}>
          {job.response.kind === 'clarification' ? '请补充需求后继续对话。' : '已答复，可继续对话或提出修改。'}
        </div>
      )}
      {job.status === 'COMPLETED' && !job.result_asset && !job.response && (
        <div className="note bad" style={{ marginTop: 10 }}>
          任务已结束，但未取到视频产物。可重新提交，或联系管理员查看该任务日志。
        </div>
      )}

      {/* 增强后的制作方案：默认折叠，专业用户可展开参考/复制 */}
      {job.enhanced_prompt && job.enhanced_prompt !== job.original_prompt && (
        <div style={{ marginTop: 10 }}>
          <button className="linkbtn tiny" onClick={() => setShowPlan((v) => !v)}>
            {showPlan ? '▾ 收起制作方案' : '▸ 查看制作方案'}
            <span style={{ opacity: .7, marginLeft: 6 }}>
              （{job.enhanced_prompt.length} 字符，由你的描述自动扩写）
            </span>
          </button>
          {showPlan && (
            <div className="card compact" style={{ marginTop: 6 }}>
              <div className="row wrap" style={{ marginBottom: 6 }}>
                <button className="linkbtn tiny" onClick={async () => {
                  const ok = await copyText(job.enhanced_prompt ?? '');
                  setNotice(ok ? '制作方案已复制' : '复制失败，请手动选中');
                }}>复制方案</button>
                {onEditPrompt && (
                  <button className="linkbtn tiny" onClick={() => onEditPrompt(job.enhanced_prompt ?? '')}>
                    用方案重新创作
                  </button>
                )}
              </div>
              <div style={{
                maxHeight: 300, overflowY: 'auto', whiteSpace: 'pre-wrap',
                fontSize: 12.5, lineHeight: 1.6, overscrollBehavior: 'contain',
              }}>{clean(job.enhanced_prompt)}</div>
            </div>
          )}
        </div>
      )}

      {notice && <div className="note info" style={{ marginTop: 8 }}>{notice}</div>}

      <div className="row wrap" style={{ marginTop: 12 }}>
        {canCancel && (
          <button className="btn danger" onClick={cancel} disabled={busy}>
            {busy ? '正在请求…' : '■ 停止生成'}
          </button>
        )}
        {/* 误发救济：停止后直接改写重投，不用新建对话 */}
        {canCancel && onEditPrompt && job.prompt_summary && (
          <button className="btn" disabled={busy}
                  onClick={async () => { await cancel(); onEditPrompt(job.prompt_summary); }}>
            ✎ 停止并修改
          </button>
        )}
        {isTerminal(job.status) && onEditPrompt && job.prompt_summary && (
          <button className="btn" onClick={() => onEditPrompt(job.prompt_summary)}>
            ✎ 用这段重新创作
          </button>
        )}
        {running && job.cancellation.requested_at && (
          <span className="muted" style={{ fontSize: 13 }}>
            {job.status === 'CANCELLING' ? '后端已确认收到停止指令，正在回收资源…' : '已通知后端，等待确认…'}
          </span>
        )}
      </div>
    </div>
  );
}
