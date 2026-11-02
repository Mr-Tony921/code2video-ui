'use client';
/**
 * 主工作区。
 *
 * 恢复流程（任务书 §8.3）：查登录 → 本地候选 ID → 服务端 active-context 兜底
 * → 校验归属 → 拉快照 → 恢复 UI → 订阅事件。
 * 永不相信浏览器关闭前缓存的状态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { JobCard } from '@/components/JobCard';
import { Sidebar } from '@/components/Sidebar';
import { ExperimentSkills } from '@/components/ExperimentSkills';
import { withBase } from '@/lib/base-path';
import { Composer } from '@/components/Composer';
import { PromptBubble } from '@/components/PromptBubble';
import { ProcessPanel } from '@/components/ProcessPanel';
import { ReferencePicker } from '@/components/ReferencePicker';
import { ExampleDialog } from '@/components/ExampleDialog';
import { ExampleList } from '@/components/ExampleList';
import { NewSessionDialog, WelcomeDialog } from '@/components/Dialogs';
import { AuthPage } from '@/components/AuthPage';
import { AdminPanel } from '@/components/AdminPanel';
import { HistoryPanel } from '@/components/HistoryPanel';
import { useBoot } from '@/features/useSession';
import { useJobStream, usePresence, useTick } from '@/features/useJobStream';
import { api, ApiError } from '@/lib/api';
import { BASE_PATH } from '@/lib/base-path';
import { clean } from '@/lib/sanitize';
import { broadcast, onBroadcast } from '@/lib/local-state';
import type { ExperimentalModel, ExperimentalSkillsInput, ExamplePrompt, Job, Mode, OutOfScopeNotice, ReferenceManifest } from '@/lib/types';
import { isTerminal } from '@/lib/types';

/** 对外模型名与版本。技术实现细节不外露（见 lib/sanitize.ts）。 */
const MODEL_NAME = 'SenseNova 6.8 Code2Video';
/**
 * ★ 这两个值【不要写死】——由 next.config.mjs 在构建期注入：
 *     APP_VERSION ← 仓库根的 VERSION 文件
 *     ENV_LABEL   ← config/backend.json 的 environment.display
 *   写死的后果：版本号每次发版要手工改（忘了界面就显示旧版本，实测发生过），
 *   而环境角标写死会让这个文件在 dev 与线上永远差一行、每次同步都得人工挑，
 *   挑错一次线上就显示「开发环境」。
 *   现在本文件在两个环境完全一致，可以整文件覆盖同步。
 */
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || '未知';
/** 环境角标：开发环境必须一眼可辨，避免误当线上使用（线上该字段为空 → 不显示） */
const ENV_LABEL = process.env.NEXT_PUBLIC_ENV_LABEL || '';

const MODES: { id: Mode; label: string }[] = [
  { id: 'coding_to_video', label: 'Coding to Video' },
  { id: 'blockout_3d', label: '3D Blockout' },
  { id: 'experimental', label: '实验模式' },
];

export default function Workspace() {
  const boot = useBoot();
  const [focusJobId, setFocusJobId] = useState<string | null>(null);
  const [models, setModels] = useState<ExperimentalModel[]>([]);
  const [modelId, setModelId] = useState('');
  const [experimentSkills, setExperimentSkills] = useState<ExperimentalSkillsInput>({ builtin: 'none', text: '' });
  const [newBuiltin, setNewBuiltin] = useState<ExperimentalSkillsInput['builtin']>('none');
  const [pendingMode, setPendingMode] = useState<Mode>('coding_to_video');
  const [showWelcome, setShowWelcome] = useState(false);
  const [showNewSession, setShowNewSession] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [online, setOnline] = useState(true);

  /**
   * 执行过程是否展开。
   *
   * 语义（用户选定）：
   *   · **一律默认收起**，开合**不记忆**（用户明确要求：
   *     「执行过程的展开和收起不要记忆，默认都是收起的」）。
   *     记忆反而有害 —— 用户某次展开过，之后每次打开页面、每次切换任务
   *     都要重新付一次整条轨迹的回放代价，而他当时只是想看一眼。
   *   · 自己【刚提交】的那一轮 → 展开（刚发就想看进度，不该再点一下）
   * 折叠时 useJobStream 不订阅 SSE —— 切换任务不再从 seq=0 重放整条轨迹。
   */
  const [procOpen, setProcOpen] = useState(false);
  const toggleProc = useCallback((v: boolean) => { setProcOpen(v); }, []);

  /** 过程区高度（可拖动），记住用户的选择 */
  const [procH, setProcH] = useState(240);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem('cvw:procH'));
      if (v >= 120) setProcH(v);
    } catch { /* 隐私模式忽略 */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem('cvw:procH', String(procH)); } catch {}
  }, [procH]);

  /** 回填到输入框的文本（停止并修改 / 复用历史 prompt） */
  const [injected, setInjected] = useState<string | null>(null);
  /**
   * 正在弹框展示的示例（null=没开）。
   * 点示例只开弹框，真正的导入由弹框主按钮触发 —— 见 importExample。
   */
  const [exOpen, setExOpen] = useState<ExamplePrompt | null>(null);
  const [exBusy, setExBusy] = useState(false);
  /** 是否做 prompt 增强，默认开。点击示例会自动关闭（示例已是增强结果） */
  const [enhance, setEnhance] = useState(true);
  const [examples, setExamples] = useState<ExamplePrompt[]>([]);
  const [outOfScope, setOutOfScope] = useState<OutOfScopeNotice | null>(null);
  const [refs, setRefs] = useState<ReferenceManifest | null>(null);

  // 热更新中：只读横幅 + 禁用输入，正在跑的任务照常显示进度
  const locked = boot.maintenance?.active === true;
  const activeId = focusJobId ?? boot.activeJob?.id ?? null;
  const {
    job: liveJob, refresh,
    processEvents, wdPrompts, assistantText, ccSessionId, loadingEvents,
  } = useJobStream(activeId, procOpen);

  // 切到别的任务 → 一律折叠。刚提交的那一轮在 submit 里置 true。
  const justSubmitted = useRef<string | null>(null);
  useEffect(() => {
    if (!activeId) return;
    if (justSubmitted.current === activeId) return;      // 自己刚发的，保持展开
    setProcOpen(false);
  }, [activeId]);
  /**
   * 当前展示的任务。
   *
   * 两道保险都要校验 id 属于 activeId —— 切换对话时若把旧任务的数据
   * 顶上来显示，界面会连跳好几次（旧卡片 → 旧快照 → 新数据）。
   * liveJob 由 useJobStream 在切换时清空，这里再挡一次 boot 缓存里的错配。
   */
  const job = (liveJob && liveJob.id === activeId ? liveJob : null)
    ?? boot.jobs.find((j) => j.id === activeId)
    ?? boot.runningJobs.find((j) => j.id === activeId)
    ?? boot.recentJobs.find((j) => j.id === activeId)
    ?? null;
  useTick(!!job && !isTerminal(job.status));   // 每秒重算耗时

  useEffect(() => {
    if (boot.session) setPendingMode(boot.session.mode);
  }, [boot.session]);

  // 心跳：有会话就发。切标签页只降频不中断（服务端阈值 600s）
  // 心跳覆盖：当前会话 + 所有仍有任务在跑的会话。
  // 只保当前会话会让"切到新对话"等同于"放弃旧任务"（线上事故）。
  usePresence(
    [boot.session?.id ?? null, ...boot.runningJobs.map((j) => j.session_id)],
    !!boot.user,
  );

  /**
   * 侧栏「进行中」需要定时刷新：别的对话里跑的任务不会通过当前 SSE 推过来，
   * 不轮询就永远看不到（用户反馈"正在执行的任务不在对话历史里"）。
   *
   * ★ 这里调 refreshRunning，不是 reload。
   *   reload 会打 me + active-context + getSession 三个请求，而 active-context
   *   的全量响应 dev 实测 **652 KB / 124 条，99% 是不会变的已完成历史**。
   *   每 20 秒重发一遍，线上实测把前端出口填到 88.9 KB/s，
   *   而入口只有 43~71 KB/s —— 我们在要 1.3~2 倍于管子能给的量，
   *   超额部分变成排队，视频/首屏/SSE 全堵在后面。
   *   refreshRunning 只取 brief 的 running_jobs（约 1 KB），
   *   并在「running 集合变小」时才补一次全量。
   */
  useEffect(() => {
    if (!boot.user) return;
    const t = setInterval(() => { void boot.refreshRunning(); }, 20_000);
    return () => clearInterval(t);
  }, [boot.user]);   // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 任务【刚刚】落终态时同步一次全局快照：侧栏「进行中/已完成」、附件冻结状态
   * 都依赖它。不做这一步，列表会和实时状态不一致。
   *
   * ★ 必须是「刚刚落终态」，不能是「现在是终态」。
   *   原来只判 isTerminal(job.status) —— 点一个【早已完成】的历史任务时，
   *   它一进视野就满足条件，于是又跑一次完整 reload（me + active-context +
   *   getSession）外加一次 loadRefs。可服务端什么都没变，这次重载纯属多余。
   *   实测点一下已完成任务会打出 8 个 /api 请求（两次 active-context、
   *   两次 getSession、三次 references）—— 这就是用户说的「切 session 非常卡」。
   *   改为记住上一次看到的状态，只在【非终态 → 终态】的跃迁上同步。
   */
  const seenStatus = useRef<Map<string, Job['status']>>(new Map());
  useEffect(() => {
    if (!job) return;
    const prev = seenStatus.current.get(job.id);
    seenStatus.current.set(job.id, job.status);
    if (prev === undefined) return;                       // 第一次见到它：不是跃迁
    if (prev === job.status) return;
    if (!isTerminal(job.status) || isTerminal(prev)) return;
    void boot.reload(true);
    void loadRefs();
  }, [job?.id, job?.status]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 附件清单
  const loadRefs = useCallback(async () => {
    if (!boot.session) { setRefs(null); return; }
    try { setRefs(await api.listReferences(boot.session.id)); } catch { setRefs(null); }
  }, [boot.session]);
  useEffect(() => { void loadRefs(); }, [loadRefs]);

  // 示例 prompt：登录后拉一次即可，不随会话变化
  useEffect(() => {
    if (!boot.user) return;
    api.examples().then((r) => setExamples(r.examples)).catch(() => setExamples([]));
  }, [boot.user]);

  // 首次使用说明
  useEffect(() => {
    if (!boot.user) return;
    try {
      if (!localStorage.getItem('cvw:welcomed')) setShowWelcome(true);
    } catch { /* 隐私模式：不弹也无妨 */ }
  }, [boot.user]);

  // 网络状态提示
  useEffect(() => {
    const on = () => { setOnline(true); void refresh(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, [refresh]);

  // 多标签页同步：纯 UI 优化，服务端仍是权威
  useEffect(() => onBroadcast((msg) => {
    const m = msg as { type?: string; jobId?: string };
    if (m?.type === 'job-changed' && m.jobId === activeId) void refresh();
    if (m?.type === 'session-changed') void boot.reload(true);
  }), [activeId, refresh, boot]);

  const continuation = useMemo(() => {
    // 判据与提交时的 is_revision 完全同源 —— 两边各写一套必然分叉。
    // 后端对 is_revision 的处理是：一律跳过扩写（enhancer.mjs:125，
    // 配置 prompt_enhancement.skip_for_revision=true）。
    const done = boot.jobs
      .filter((j) => j.status === 'COMPLETED')
      .sort((a, b) => String(b.finished_at ?? '').localeCompare(String(a.finished_at ?? '')));
    const base = done[0];
    if (!base) return null;
    return {
      summary: base.prompt_summary || '上一版',
      /**
       * 轮次 = 已结束的轮数 + 1。
       *
       * ★ 原来写的是 `boot.jobs.length + 1`，把【正在跑的这一轮自己】也数了进去：
       *   用户第一次修改时，会话里是 [已完成的首轮, 正在跑的修改轮] = 2 条，
       *   于是显示「第 3 轮」—— 用户实测反馈（足球进球门那个会话 sess_eed1b7a6）。
       *   改用已结束的轮数：提交前 1+1=2，提交后仍是 1+1=2（在跑的那轮就是第 2 轮），
       *   等它跑完才变成 3。
       */
      round: boot.jobs.filter((j) => isTerminal(j.status)).length + 1,
    };
  }, [boot.jobs]);

  useEffect(() => {
    if (!boot.user?.can_use_experimental) { setModels([]); return; }
    api.experimentalModels().then(r => {
      setModels(r.models); setModelId(current => current || r.models[0]?.profile_id || '');
    }).catch(() => setModels([]));
  }, [boot.user?.can_use_experimental]);
  useEffect(() => {
    setExperimentSkills({ builtin: boot.session?.experimental_skills?.builtin ?? 'none',
      text: boot.session?.experimental_skills?.text ?? '' });
  }, [boot.session?.id]);

  const submit = useCallback(async (text: string, idemKey: string) => {
    if (!boot.session) return;
    setOutOfScope(null);
    try {
      // 已有完成的视频 → 本次是续写（后端一律跳过扩写）
      const isRevision = !!continuation;
      const r = await api.submitJob(boot.session.id, text, idemKey, {
        is_revision: isRevision,
        // 续写轮不报扩写意图：后端无论如何都会跳过（enhancer.mjs:125），
        // 这里送 true 只会让 UI 和实际行为对不上（用户实测：勾着但其实没扩写）。
        enhance: boot.session.mode === 'experimental' || isRevision ? false : enhance,
        ...(boot.session.mode === 'experimental' ? { experimental_skills: experimentSkills } : {}),
      });

      // 增强是异步的：Job 以 ENHANCING 建好并秒回，
      // 若判为非视频请求，Job 会转 OUT_OF_SCOPE，由 JobCard 显示提示
      if (!r.job) {
        setOutOfScope(r.notice ?? {
          code: 'OUT_OF_SCOPE',
          title: '本站是视频生成展示平台',
          message: '我们目前只支持 AI 视频生成与视频修改，其他内容暂不支持。',
          suggestions: [],
        });
        return;
      }

      setFocusJobId(r.job.id);
      justSubmitted.current = r.job.id;                  // 刚提交 → 过程框保持展开
      setProcOpen(true);
      if (r.idempotent_replay) setToast('该请求已提交过，正在查看同一个任务');
      broadcast({ type: 'job-changed', jobId: r.job.id });
      await boot.reload(true);                 // 已有 JobCard 在屏上，别整页闪
      await loadRefs();                        // 提交后附件会被冻结
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : '提交失败，请重试');
    }
    // enhance 必须在依赖里：漏了会捕获旧值，用户改了开关却按上一次的设置提交
  }, [boot, loadRefs, enhance, continuation, experimentSkills]);

  /**
   * 切换模式。
   * 旧行为是只改 pendingMode 再提示"新模式将在新建会话时生效" —— 用户看不懂，
   * 也不知道还要手动新建。改为直接开一个该模式的新对话；
   * 有任务在跑时不切（会话与后端进程绑定，切了等于放弃）。
   */
  const switchMode = useCallback(async (m: Mode) => {
    if (m === pendingMode && boot.session?.mode === m) return;
    // 切模式会新建会话 —— 维护期间后端正在挡写，别让用户白点
    if (boot.maintenance?.active) {
      setToast('系统正在更新，请稍候…');
      return;
    }
    if (boot.runningJobs.length > 0) {
      setToast('有任务正在执行，完成或停止后才能切换模式');
      return;
    }
    setPendingMode(m);
    if (m === 'experimental') { setShowNewSession(true); return; }
    if (!boot.session || boot.session.mode !== m) {
      try {
        await boot.createSession(m);
        setFocusJobId(null);
        setEnhance(true);                      // 换模式=新会话，扩写回到默认开启
        broadcast({ type: 'session-changed' });
      } catch (e) {
        setToast(e instanceof ApiError ? e.message : '切换模式失败');
      }
    }
  }, [boot, pendingMode]);

  const doNewSession = useCallback(async () => {
    setShowNewSession(false);
    try {
      await boot.createSession(pendingMode, pendingMode === 'experimental' ? { model_id: modelId, builtin_skills: newBuiltin } : undefined);
      setFocusJobId(null);
      setEnhance(true);                        // 新对话回到默认：扩写开启
      broadcast({ type: 'session-changed' });
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : '新建会话失败');
    }
  }, [boot, pendingMode, modelId, newBuiltin]);

  /**
   * 弹框里点「新建对话并导入」。
   *
   * 顺序很重要：**先建会话，成功了才改输入框与扩写开关**。
   * 反过来写的话建会话失败（维护期、容量不足）会留下一个
   * 「输入框已填好、扩写已关、但还在上一个对话里」的状态 ——
   * 用户直接点发送就提交到了错误的会话，正是 1.4.0 修过的串台那类问题。
   *
   * 用 ex.mode 而不是 pendingMode 建会话：示例列表虽然已按当前模式过滤，
   * 但万一将来改了过滤规则，这里也不会把白模示例塞进 coding 会话。
   */
  const importExample = useCallback(async (ex: ExamplePrompt) => {
    if (boot.maintenance?.active) {
      setToast('系统正在更新，请稍候…');
      return;
    }
    setExBusy(true);
    try {
      const hadRunning = boot.runningJobs.length;
      await boot.createSession(ex.mode);
      setPendingMode(ex.mode);
      setFocusJobId(null);
      setInjected(ex.prompt);
      // 示例本身已是增强后的方案，再增强一遍会偏离原意（用户明确要求取消勾选）
      setEnhance(false);
      broadcast({ type: 'session-changed' });
      setExOpen(null);
      setToast(hadRunning > 0
        ? `已新建对话并导入「${ex.title}」，已关闭扩写；原有 ${hadRunning} 个任务继续在后台执行`
        : `已新建对话并导入「${ex.title}」，已自动关闭扩写`);
      api.useExample(ex.id).catch(() => {});   // 统计，失败不影响用户
    } catch (e) {
      setToast(e instanceof ApiError ? e.message : '新建对话失败，示例未导入');
    } finally {
      setExBusy(false);
    }
  }, [boot]);

  /**
   * 点开某个任务。
   *
   * ★ 串台修复（线上 yaotiankuo 反馈）：如果这个任务属于【别的对话】，
   * 必须把当前对话也切过去。原来只改 focusJobId —— 画面切到了 A，
   * 输入框却仍然提交到 boot.session（还是 B），续跑于是继承了 B 的工作区。
   * 1.4.0 起续跑是 cc --resume，提交错会话等于 resume 错对话，后果更重。
   */
  const pickJob = useCallback(async (j: Job) => {
    const cross = !!j.session_id && j.session_id !== boot.session?.id;
    /**
     * ★ 先把聚焦切过去，再去切会话。
     *
     * 原来是等 switchSession 全部完成后才 setFocusJobId —— 那段时间里
     * 界面已经换成了新会话的数据，聚焦却还停在旧任务上，于是卡片／过程框
     * 先跳到一个错配状态、再跳到正确状态（用户反馈「跳来跳去」）。
     * 先设聚焦则中间态是一致的：显示的就是用户刚点的那个任务。
     * `job` 的解析本来就会校验 id 属于 activeId，所以提前设不会显示错数据。
     */
    const prev = focusJobId;
    setFocusJobId(j.id);
    if (!cross) return;
    try {
      await boot.switchSession(j.session_id!);
    } catch (e) {
      setFocusJobId(prev);                       // 切不过去就退回原聚焦，绝不留在「看A提交进B」
      setToast(e instanceof ApiError ? `无法切换到该对话：${e.message}` : '无法切换到该对话');
    }
  }, [boot, focusJobId]);

  /**
   * 本次提交会「基于哪个对话继续」。
   *
   * 判据与后端一致：当前会话里最近一个【已完成且有可播成片】的任务。
   * 后端的续跑是「同一会话共用工作区 + cc --resume」，继承对象就是这个会话本身，
   * 所以这里显示会话里那一版成片的摘要，不会和实际继承的对象错位。
   * 没有可续的成片就不显示 —— 那是全新创作，不该假装是续跑。
   */

  /**
   * 「制作助手」显示的文本。
   *
   * ★ 快照优先，SSE 只兜底 —— 顺序反了就会跳变。
   *   原来写的是 `assistantText ?? job?.last_assistant_text`，于是展开过程框时
   *   SSE 回放的每一条历史回复都会盖掉快照、让这张卡片挨个闪一遍
   *   （用户反馈：「展开执行过程后对话框还是跳变，好像没完全解耦」）。
   *   快照里的 `last_assistant_text` 由 gateway 的事件泵实时维护
   *   （见 stream-pump 的 patchJob），运行中的任务靠 job 轮询也能刷新，
   *   所以用快照不会变旧，还天然避免了回放抖动。
   *   useJobStream 那边也做了第二道：回放期间不再逐条 setAssistantText。
   */
  const helperText = job?.last_assistant_text ?? assistantText ?? null;

  const canUse = useMemo(() => (m: Mode) => boot.permissions?.modes.includes(m) ?? false, [boot.permissions]);

  /**
   * 当前会话是否真的在跑。
   *
   * 不能只看 boot.runningJobs —— 那是 reload 时的快照。任务通过 SSE 完成后
   * 它仍是旧值，输入框会一直锁死（用户实测：视频已出来却无法输入）。
   * 以实时 job 状态为准：它说完了就是完了。
   */
  const sessionBusy = useMemo(() => {
    const sid = boot.session?.id;
    if (!sid) return false;
    // 实时状态优先：当前聚焦的 job 属于本会话且已终态 ⇒ 不忙
    if (job && job.session_id === sid) {
      if (isTerminal(job.status)) {
        // 但本会话可能还有【另一个】未完成的任务
        return boot.runningJobs.some((j) => j.session_id === sid && j.id !== job.id);
      }
      return true;
    }
    return boot.runningJobs.some((j) => j.session_id === sid);
  }, [boot.session?.id, boot.runningJobs, job]);

  /* ── 加载中 / 未登录 ── */
  if (boot.loading) return <div className="center"><p className="muted">正在恢复会话…</p></div>;
  if (boot.error === 'UNAUTHENTICATED') return <AuthPage onDone={boot.reload} />;
  if (!boot.user) {
    return (
      <div className="center">
        <div className="card" style={{ maxWidth: 420 }}>
          <p className="note bad">{boot.error ?? '无法连接服务'}</p>
          <button className="btn primary full" style={{ marginTop: 10 }} onClick={() => void boot.reload()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  const degraded = boot.binding?.status === 'PROCESS_LOST' || boot.session?.status === 'DEGRADED';

  return (
    <div className="shell">
      <header className="topbar">
        <div className="logo"><span className="dot" />SenseNova Coding Video</div>
        <span className="pill" title={boot.session?.model_selection?.model ?? MODEL_NAME}>{boot.session?.model_selection?.name ?? MODEL_NAME}</span>

        <div className="seg" role="group" aria-label="模式切换">
          {MODES.filter(m => m.id !== 'experimental' || boot.user?.can_use_experimental).map((m) => {
            const allowed = canUse(m.id);
            return (
              <button key={m.id} data-mode={m.id} aria-pressed={pendingMode === m.id}
                      disabled={!allowed}
                      title={allowed ? undefined : '需管理员授予白模预演权限'}
                      onClick={() => void switchMode(m.id)}>
                {m.label}
              </button>
            );
          })}
        </div>

        <span className="spacer" />
        {boot.session && <a className="btn tiny" href={withBase(`/api/sessions/${boot.session.id}/archive`)}>下载完整会话</a>}
        <button className="btn" style={{ padding: '5px 11px', fontSize: 13 }}
                onClick={() => setShowHistory(true)}>创作历史</button>
        {boot.user.role === 'admin' && (
          <button className="btn" style={{ padding: '5px 11px', fontSize: 13 }}
                  onClick={() => setShowAdmin(true)}>管理后台</button>
        )}
        <span className="tiny">
          {boot.user.username}
          {boot.user.role === 'admin' && <span className="badge" style={{ marginLeft: 6 }}>管理员</span>}
          {boot.user.can_use_blockout_3d && <span className="badge violet" style={{ marginLeft: 6 }}>白模</span>}
        </span>
        <button className="linkbtn tiny" onClick={async () => {
          await api.logout().catch(() => {});
          // 子路径部署下不能用 reload 以外的裸跳转；显式回到带前缀的首页
          window.location.href = `${BASE_PATH}/`;
        }}>退出</button>
      </header>

      {/* SSE 降级不再弹横幅：它会盖住正文，且前端已自动轮询兜底，
          用户无需知道传输方式。状态改由过程框标题的小圆点体现。 */}
      {!online && <div className="banner">网络连接中断，正在重连…</div>}
      {degraded && (
        <div className="banner">
          该对话的后端进程已失联，无法提交新任务。请新建对话；已完成的产物仍可访问。
        </div>
      )}
      {locked && (
        <div className="banner updating" role="status">
          ⟳ {boot.maintenance?.message ?? '系统正在更新，请稍候…'}
          <span style={{ opacity: .85, marginLeft: 8 }}>正在运行的任务不受影响</span>
        </div>
      )}

      <div className="body">
        <Sidebar
          session={boot.session} binding={boot.binding}
          runningJobs={boot.runningJobs} recentJobs={boot.recentJobs}
          onNewSession={() => { if (locked) { setToast('系统正在更新，请稍候…'); return; } setShowNewSession(true); }}
          // 显示「当前在看的这个任务」所属的会话 ID，而不是固定的 boot.session.id。
          // 用户切到别的对话后，报障时复制的必须是那个对话的 ID。
          focusedSessionId={job?.session_id ?? boot.session?.id ?? null}
          focusedJobId={activeId}
          onPickJob={(j: Job) => { void pickJob(j); }}
        >
          <ExampleList
            examples={examples}
            mode={boot.session?.mode ?? pendingMode}
            onPick={(ex) => setExOpen(ex)}
          />

          <ReferencePicker
            sessionId={boot.session?.id ?? null}
            manifest={refs}
            disabled={degraded || sessionBusy}
            onChanged={loadRefs}
          />
        </Sidebar>

        <main className={boot.session ? 'main' : 'main no-proc'}
              style={{ ['--proc-h' as string]: `${procH}px` }}>
          <div className="stream">
            {!boot.session && (
              <div className="card">
                <h2 style={{ marginTop: 0, fontSize: 17 }}>开始创作</h2>
                <p className="muted" style={{ marginBottom: 0 }}>
                  点击左侧「新建对话」开始。单次生成可能需要 1~2 小时，期间请保持页面开启。
                </p>
              </div>
            )}

            {job && (
              <>
                {job.prompt_summary && (
                  <PromptBubble summary={job.prompt_summary} full={job.original_prompt} />
                )}
                <JobCard job={job}
                  onChanged={() => { void refresh(); void boot.reload(true); broadcast({ type: 'job-changed', jobId: job.id }); }}
                  onEditPrompt={(t) => { setInjected(t); setToast('已填回输入框，修改后重新发送'); }} />
              </>
            )}

            {/* 非视频请求提示（V2） */}
            {outOfScope && (
              <div className="card" style={{ borderLeft: '3px solid var(--amber)' }}>
                <strong>{outOfScope.title}</strong>
                <p className="muted" style={{ marginTop: 6, marginBottom: 8 }}>{outOfScope.message}</p>
                {outOfScope.suggestions.length > 0 && (
                  <div className="row wrap">
                    {outOfScope.suggestions.map((sg) => (
                      <span key={sg} className="badge">{sg}</span>
                    ))}
                  </div>
                )}
                <button className="btn" style={{ marginTop: 10 }} onClick={() => setOutOfScope(null)}>
                  知道了
                </button>
              </div>
            )}

            {/* cc 的回复显示在对话区（V2 需求 7），不止过程框。
                ★ 优先用 job 快照里的 last_assistant_text —— 它随快照一起到，
                  零额外请求；过程框展开后 SSE 推来的新值再覆盖它。
                  这样切换任务时不必为了一句话重放整条轨迹。 */}
            {helperText && (
              <div className="card" style={{ borderLeft: '3px solid var(--cyan)' }}>
                <div className="tiny" style={{ marginBottom: 5, color: 'var(--mute)' }}>
                  制作助手
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{clean(helperText)}</div>
              </div>
            )}

            {toast && (
              <div className="note info" role="status">
                {clean(toast)}
                <button className="btn" style={{ marginLeft: 10, padding: '2px 8px', fontSize: 12 }}
                        onClick={() => setToast(null)}>关闭</button>
              </div>
            )}
          </div>

          {boot.session?.mode === 'experimental' && <ExperimentSkills value={experimentSkills}
            onChange={setExperimentSkills} disabled={degraded || sessionBusy || locked}
            archiveName={boot.session.experimental_skills?.archive_name}
            canBlockout={!!boot.user.can_use_blockout_3d || boot.user.role === 'admin'} />}
          <Composer
            experimental={boot.session?.mode === 'experimental'}
            sessionId={boot.session?.id ?? null}
            disabled={!boot.session || degraded || sessionBusy || locked}
            disabledReason={
              locked ? '系统正在更新，请稍候…'
                : !boot.session ? '请先新建对话'
                : degraded ? '该对话的后端进程已失联，请新建对话'
                : sessionBusy ? '当前有生成任务正在执行，完成后可继续输入'
                : undefined
            }
            onSubmit={submit}
            injected={injected}
            onInjected={() => setInjected(null)}
            enhance={enhance}
            onEnhanceChange={setEnhance}
            basedOn={continuation}
            enhanceLocked={boot.session?.mode === 'experimental' ? '实验模式直接使用原始 prompt，不做扩写' : continuation ? '续写不做扩写：你的修改说明会直接交给已有的制作上下文' : null}
          />

          {/* 过程窗口在主区【下方】（上中下三段的"下"），独立滚动。
              放右侧整列会挤压聊天区，视频出来都看不见 —— 用户实测反馈。 */}
          {boot.session && (
            <ProcessPanel
              events={processEvents} prompts={wdPrompts}
              phase={job?.phase ?? null} running={!!job && !isTerminal(job.status)}
              ccSessionId={ccSessionId}
              sessionId={boot.session.id}
              onHeight={setProcH}
              open={procOpen}
              onOpenChange={toggleProc}
              loadingEvents={loadingEvents}
            />
          )}
        </main>
      </div>

      {showAdmin && <AdminPanel onClose={() => { setShowAdmin(false); void boot.reload(true); }} />}

      {showHistory && (
        <HistoryPanel
          onClose={() => setShowHistory(false)}
          // 历史面板直接给整个 Job，所以总能拿到 session_id 一并切过去。
          // 原来它只给 jobId，要去本地数组里找 —— 而本面板的数据是
          // /api/me/history（用户【全部】任务，含失败/取消的），
          // 那些数组里没有的就走兜底分支「只改聚焦不切会话」⇒ 串台依旧可达。
          onPick={(j: Job) => { void pickJob(j); }}
          onReuse={(text) => { setInjected(text); setToast('已填回输入框，可修改后发送'); }}
        />
      )}

      <div className="verbadge">
        {ENV_LABEL && <span className="envtag">{ENV_LABEL}</span>}
        {boot.session?.model_selection?.name ?? MODEL_NAME} · v{APP_VERSION}
      </div>

      <WelcomeDialog open={showWelcome} onClose={() => {
        setShowWelcome(false);
        try { localStorage.setItem('cvw:welcomed', '1'); } catch {}
      }} />
      <NewSessionDialog
        open={showNewSession}
        runningJobs={boot.runningJobs}
        onConfirm={doNewSession}
        confirmDisabled={pendingMode === 'experimental' && !modelId}
        onCancel={() => { setShowNewSession(false); if (boot.session) setPendingMode(boot.session.mode); }}
      >
        {pendingMode === 'experimental' && <div style={{ marginBottom: 14 }}>
          <label className="tiny">实验模型<select className="input" value={modelId} onChange={e => setModelId(e.target.value)}>
            {models.map(m => <option key={m.profile_id} value={m.profile_id}>{m.name} · {m.model}</option>)}
          </select></label>
          {!models.length && <p className="note warn">当前没有可用实验模型，请联系配置维护者。</p>}
          <label className="tiny">内置 skill<select className="input" value={newBuiltin}
            onChange={e => setNewBuiltin(e.target.value as ExperimentalSkillsInput['builtin'])}>
            <option value="none">不使用任何内置 skill</option>
            <option value="coding_to_video">Coding to Video</option>
            {(boot.user.can_use_blockout_3d || boot.user.role === 'admin') && <option value="blockout_3d">3D Blockout</option>}
          </select></label>
          <p className="tiny">模型在此对话内固定。自定义 skill 可在生成页粘贴或上传。</p>
        </div>}
      </NewSessionDialog>
      <ExampleDialog
        example={exOpen}
        busy={exBusy}
        disabledReason={locked ? '系统正在更新，请稍候再导入' : null}
        onImport={(ex) => { void importExample(ex); }}
        onClose={() => setExOpen(null)}
      />
    </div>
  );
}
