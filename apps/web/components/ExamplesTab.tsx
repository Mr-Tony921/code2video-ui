'use client';
/**
 * 管理员维护示例 prompt。
 *
 * 示例的定位是"已经调好、可直接投产的完整方案"，所以写的时候就该是增强后的内容；
 * 用户点击使用时前端会自动关闭增强。
 *
 * ★ 1.4.1：每条示例可选地挂一段**示例片**。上传走
 * POST /api/admin/examples/:id/video，服务端会 ffprobe + 整片解码校验，
 * 不完整/非 h264/非 mp4 一律拒掉并给出原因（见 gateway server.mjs 那个路由的注释）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { formatBytes, formatDuration } from '@/lib/format';
import { clean } from '@/lib/sanitize';
import type { ExamplePrompt, Mode } from '@/lib/types';

const MODE_LABEL: Record<string, string> = {
  coding_to_video: 'Coding→Video', blockout_3d: '3D Blockout', experimental: '实验模式',
};

export function ExamplesTab() {
  const [items, setItems] = useState<ExamplePrompt[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<Mode>('coding_to_video');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  /** 新增时可一并选一个示例片（可选）。见下面 createOne 的两步说明。 */
  const [newVideo, setNewVideo] = useState<File | null>(null);
  const [newPct, setNewPct] = useState<number | null>(null);
  const newFileRef = useRef<HTMLInputElement>(null);
  /** 建好了但视频没传上去 —— 要单独提示，不能混在 err 里一笔带过 */
  const [partial, setPartial] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try { setItems((await api.adminExamples()).examples); }
    catch (e) { setErr(e instanceof ApiError ? e.message : '加载失败'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null);
    try { await fn(); await load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : '操作失败'); }
    finally { setBusy(false); }
  }

  function clearNewVideo() {
    setNewVideo(null);
    // 清 input 的 value：不清的话重选同一个文件不会触发 onChange
    if (newFileRef.current) newFileRef.current.value = '';
  }

  /**
   * 新增示例（可带示例片）。
   *
   * ★ 必然是两步：上传接口是 `POST /api/admin/examples/:id/video`，
   *   需要一个已存在的示例 id，所以只能先建示例、再传视频。
   *   于是存在「示例建好了、视频没传上」这种半成功状态 ——
   *   **必须单独讲清楚**，不能笼统报「操作失败」：
   *   示例其实已经建好了，用户若按失败重试就会建出第二条重复示例。
   *   这种情况下清空表单（示例确实建好了）+ 单独一条黄色提示，
   *   引导去下面表格里对那一条「上传」。
   */
  async function createOne() {
    setBusy(true); setErr(null); setPartial(null);
    try {
      const { example } = await api.adminCreateExample({
        title, prompt, mode, note: note || undefined,
      });
      const f = newVideo;
      setTitle(''); setPrompt(''); setNote('');       // 示例已建好，表单可以清了
      if (f) {
        setNewPct(0);
        try {
          await api.adminUploadExampleVideo(example.id, f, setNewPct);
        } catch (e) {
          setPartial(`示例「${example.title}」已创建，但示例片没传上去：`
            + `${e instanceof ApiError ? e.message : '上传失败'}。`
            + '不用重新添加 —— 在下面表格里对这条点「上传」即可。');
        } finally {
          setNewPct(null);
        }
      }
      clearNewVideo();
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '添加失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card">
        <strong style={{ fontSize: 14 }}>新增示例</strong>
        <div className="row wrap" style={{ marginTop: 10, gap: 10 }}>
          <input className="tinput" placeholder="标题（用户看到的名字）" style={{ flex: 1, minWidth: 180 }}
                 value={title} onChange={(e) => setTitle(e.target.value)} />
          <select className="tinput" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="coding_to_video">Coding→Video</option>
            <option value="blockout_3d">3D Blockout</option>
          </select>
          <input className="tinput" placeholder="备注（可选，用户可见）" style={{ flex: 1, minWidth: 140 }}
                 value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <textarea className="input" style={{ marginTop: 8, minHeight: 110 }}
                  placeholder="示例内容 —— 请填【已经增强过的完整制作方案】，用户点击后会直接投产，不再二次扩写"
                  value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        {/* 示例片（可选）：用户要求「管理员创建时可以直接传新视频」 */}
        <div className="row wrap" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
          <span className="tiny" style={{ opacity: .75 }}>示例片（可选）</span>
          <button className="btn" style={{ padding: '3px 10px', fontSize: 12 }}
                  disabled={busy} onClick={() => newFileRef.current?.click()}>
            {newVideo ? '重新选择' : '选择 mp4 文件'}
          </button>
          {newVideo && (
            <>
              {/* 用 formatBytes 而不是固定 MB：几十 KB 的小片会显示成「0.0MB」，
                  看不出到底选中了什么（实测选到 0 字节文件时也显示 0.0MB，
                  差点把测试夹具丢失误判成上传坏了） */}
              <span className="tiny mono" style={{ opacity: .85 }}>
                {newVideo.name}（{formatBytes(newVideo.size)}）
              </span>
              <button className="linkbtn tiny" disabled={busy} onClick={clearNewVideo}>移除</button>
            </>
          )}
          <input ref={newFileRef} type="file" accept="video/mp4,.mp4" style={{ display: 'none' }}
                 onChange={(e) => setNewVideo(e.target.files?.[0] ?? null)} />
        </div>
        {newPct !== null && (
          <div className="tiny" style={{ marginTop: 6 }}>
            上传示例片 {newPct}%
            <div style={{ height: 4, marginTop: 3, borderRadius: 2,
                          background: 'var(--line)', overflow: 'hidden' }}>
              <div style={{ width: `${newPct}%`, height: '100%',
                            background: 'var(--blue)', transition: 'width .2s' }} />
            </div>
            {newPct === 100 && (
              <div style={{ opacity: .75, marginTop: 2 }}>正在校验（整片解码）…</div>
            )}
          </div>
        )}

        <div className="row" style={{ marginTop: 8 }}>
          <span className="tiny" style={{ opacity: .75 }}>{prompt.length} 字符</span>
          <span className="spacer" />
          <button className="btn primary" disabled={busy || !title.trim() || !prompt.trim()}
                  onClick={() => void createOne()}>
            {newPct !== null ? '上传中…' : busy ? '处理中…' : newVideo ? '添加并上传示例片' : '添加'}
          </button>
        </div>
      </div>

      {err && <div className="note bad">{err}</div>}
      {partial && (
        <div className="note warn">
          {partial}
          <button className="btn" style={{ marginLeft: 10, padding: '2px 8px', fontSize: 12 }}
                  onClick={() => setPartial(null)}>知道了</button>
        </div>
      )}

      <table className="atable">
        <thead><tr>
          <th>标题</th><th>模式</th><th>长度</th><th>使用次数</th><th>状态</th>
          <th>示例片</th><th>备注</th><th>操作</th>
        </tr></thead>
        <tbody>
          {items.length === 0 && <tr><td colSpan={8} className="tiny">暂无示例。添加后所有用户都能在左栏看到。</td></tr>}
          {items.map((ex) => (
            <tr key={ex.id}>
              <td>{ex.title}</td>
              <td className="tiny">{MODE_LABEL[ex.mode] ?? ex.mode}</td>
              <td className="tiny">{ex.prompt.length}</td>
              <td>{ex.use_count ? <strong>{ex.use_count}</strong> : '—'}</td>
              <td>
                <span className={`ptag ${ex.enabled === false ? 'err' : 'ok'}`}>
                  {ex.enabled === false ? '已隐藏' : '显示中'}
                </span>
              </td>
              <td><VideoCell ex={ex} onChanged={load} /></td>
              <td className="tiny">{ex.note ?? '—'}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="linkbtn tiny" onClick={() => setOpen(open === ex.id ? null : ex.id)}>
                  {open === ex.id ? '收起' : '查看'}
                </button>
                <button className="linkbtn tiny" style={{ marginLeft: 8 }} disabled={busy}
                        onClick={() => run(async () => {
                          await api.adminUpdateExample(ex.id, { enabled: ex.enabled === false });
                        })}>{ex.enabled === false ? '显示' : '隐藏'}</button>
                <button className="linkbtn tiny" style={{ marginLeft: 8 }} disabled={busy}
                        onClick={() => run(async () => { await api.adminDeleteExample(ex.id); })}>删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {open && (
        <div className="card compact" style={{ marginTop: 8 }}>
          <div className="tiny" style={{ marginBottom: 4, opacity: .75 }}>示例内容</div>
          <div style={{ maxHeight: 300, overflowY: 'auto', whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.6 }}>
            {clean(items.find((x) => x.id === open)?.prompt ?? '')}
          </div>
        </div>
      )}

      <p className="tiny" style={{ marginTop: 10 }}>
        用户在左栏点击示例后会<strong>弹出详情框</strong>（展示 prompt 与示例片），
        点「新建对话并导入」才会建新对话并填入 prompt，同时
        <strong>自动关闭「智能扩写」</strong> —— 示例本身就是扩写后的方案，再过一遍会偏离原意。
        弹框里已说明「模型有随机性，不会还原出完全相同的视频」。
      </p>
      <p className="tiny" style={{ marginTop: 4, opacity: .75 }}>
        示例片要求：<strong>.mp4 / h264</strong>，最大 200MB。上传后服务端会整片解码一遍，
        截断或损坏的文件会被拒绝（不会出现「传上去了但播一半卡住」）。
      </p>
      <p className="tiny" style={{ marginTop: 4, opacity: .75 }}>
        校验通过后还会做一次<strong>预览化处理</strong>：示例片在弹框里最大只显示 360px 高，
        所以码率高于 <strong>1800kbps</strong> 的会自动降码率并缩到 720p 内
        （实测一个 1080p / 5.5Mbps 的示例片需要稳定 5~6Mbps 才不卡，
        处理后 0.8Mbps 即可流畅）；码率本来就达标的只把 moov 搬到文件头，<strong>画质无损</strong>。
        处理结果会显示在上面的「示例片」列里。
      </p>
    </>
  );
}

/**
 * 单条示例的「示例片」单元格：显示当前视频信息 + 上传/替换/删除。
 *
 * 上传用 api.adminUploadExampleVideo（XHR），因为 fetch 拿不到上传进度 ——
 * 200MB 的片子没有进度条，管理员会以为卡死然后反复点，于是重复上传。
 * 上传期间按钮全禁用，并且**不复用外层的 busy** ：外层 busy 会在上传的
 * 几十秒里锁死整张表（连别条示例的隐藏/删除都点不了）。
 */
function VideoCell({ ex, onChanged }: { ex: ExamplePrompt; onChanged: () => Promise<void> }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const v = ex.video ?? null;
  const uploading = pct !== null;

  async function pick(f: File | null | undefined) {
    if (!f) return;
    setErr(null);
    setPct(0);
    try {
      await api.adminUploadExampleVideo(ex.id, f, setPct);
      await onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '上传失败');
    } finally {
      setPct(null);
      // 清空 input：否则选同一个文件第二次不触发 onChange（value 没变）
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div style={{ minWidth: 150 }}>
      {v ? (
        <div className="tiny" style={{ lineHeight: 1.5 }}>
          <span className="ptag ok">有</span>{' '}
          {formatDuration(v.duration_ms)} · {v.width}×{v.height}
          <div style={{ opacity: .7 }}>{formatBytes(v.size_bytes)}</div>
          {/*
            体积/分辨率可能和管理员传上来的不一样，必须说清为什么 ——
            不说的话会被当成上传出错。
          */}
          {v.optimized === 'reencode' && v.original_size_bytes ? (
            <div style={{ opacity: .7, color: 'var(--blue)' }}
                 title="示例片在弹框里最大只显示 360px 高；原片码率过高会导致播放卡顿，已自动降码率">
              已压缩：{formatBytes(v.original_size_bytes)} → {formatBytes(v.size_bytes)}
            </div>
          ) : v.optimized === 'faststart' ? (
            <div style={{ opacity: .6 }} title="已把 moov 原子搬到文件头，首帧不必等整片下载">
              已优化首帧加载
            </div>
          ) : null}
        </div>
      ) : (
        <span className="tiny" style={{ opacity: .6 }}>—</span>
      )}

      {uploading ? (
        <div className="tiny" style={{ marginTop: 3 }}>
          上传中 {pct}%
          <div style={{
            height: 4, marginTop: 3, borderRadius: 2,
            background: 'var(--line)', overflow: 'hidden',
          }}>
            <div style={{
              width: `${pct}%`, height: '100%',
              background: 'var(--blue)', transition: 'width .2s',
            }} />
          </div>
          {pct === 100 && (
            <div style={{ opacity: .75, marginTop: 2 }}>正在校验（整片解码）…</div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 3, whiteSpace: 'nowrap' }}>
          <button className="linkbtn tiny" onClick={() => fileRef.current?.click()}>
            {v ? '替换' : '上传'}
          </button>
          {v && (
            <button className="linkbtn tiny" style={{ marginLeft: 8 }}
                    onClick={async () => {
                      setErr(null);
                      try { await api.adminDeleteExampleVideo(ex.id); await onChanged(); }
                      catch (e) { setErr(e instanceof ApiError ? e.message : '删除失败'); }
                    }}>删除</button>
          )}
        </div>
      )}

      <input ref={fileRef} type="file" accept="video/mp4,.mp4" style={{ display: 'none' }}
             onChange={(e) => { void pick(e.target.files?.[0]); }} />

      {err && <div className="tiny" style={{ marginTop: 3, color: 'var(--red)' }}>{err}</div>}
    </div>
  );
}
