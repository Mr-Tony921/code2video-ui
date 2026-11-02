/**
 * 技术栈脱敏（前端最后一道）。
 *
 * 用户不该看到我们用什么模型/CLI 实现。泄露面有三处：
 *   1. 失败原因与错误码（E_CLAUDE_EXIT / "claude 异常退出"）
 *   2. 增强信息里的模型名（claude-opus-5-5）
 *   3. 执行过程框：工具调用的命令行、文件路径、助手文本里会出现 claude/.claude/cc
 *
 * 在前端做：后端日志要保留真名以便排障，不能为了遮蔽而丢掉定位能力。
 *
 * 原则：只替换成中性词，不删整句 —— 否则用户看到空白更困惑。
 */

/** 替换表。顺序有意义：先长后短，避免 "claude-opus-5-5" 被拆成两次替换。 */
const RULES: [RegExp, string][] = [
  // 模型名。版本号与路由后缀要一起吃掉 —— 只替换前半段会留下
  // "增强模型-5/ccmax/sfa" 这种更可疑的残骸（实测过）。
  [/claude[-_\s]?opus[-_\s\d.]*(?:\/[\w.-]+)*/gi, '增强模型'],
  [/claude[-_\s]?(?:sonnet|haiku|fable)[-_\s\d.]*(?:\/[\w.-]+)*/gi, '增强模型'],
  // ⚠️ opus 还是音频编码器的名字（opusenc / libopus / .opus）。
  // 只在它明显是模型名时替换：必须紧跟版本号，且不能是 opusXXX 这类单词的一部分。
  // 否则会把 `which sox ffmpeg opusenc` 这种正常命令改坏（实测误伤过）。
  [/\bopus[-_\s]?\d[\d.\-]*(?:\/[\w.-]+)*/gi, '增强模型'],
  // 环境变量名本身就暴露厂商
  [/\bANTHROPIC_[A-Z_]+/g, 'MODEL_CONFIG'],
  [/\banthropic\b/gi, '模型服务'],
  // CLI / 进程
  [/\bclaude[-\s]?code\b/gi, '制作引擎'],
  [/\.claude\b/g, '.engine'],
  [/\bclaude\.jsonl\b/gi, 'engine.jsonl'],
  [/\bclaude\.stderr\b/gi, 'engine.stderr'],
  [/\bclaude\b/gi, '制作引擎'],
  // 错误码里的 CLAUDE
  [/E_CLAUDE_EXIT/g, 'E_ENGINE_EXIT'],
  [/\bCLAUDE\b/g, 'ENGINE'],
  // 底层模型名
  [/\bQwen[\w.\-]*\b/gi, '生成模型'],
  // cc 会话标识
  [/\bcc[-_\s]?session(?:[-_\s]?id)?\b/gi, '引擎会话'],
  // 误泄露的 key 形态
  [/\bsk-[A-Za-z0-9_-]{6,}/g, '***'],
];

/** 对一段用户可见文本脱敏。非字符串原样返回。 */
export function clean(text: string | null | undefined): string {
  if (!text) return '';
  let s = String(text);
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s;
}

/** 递归脱敏任意结构（过程事件的 input 是任意 JSON）。 */
export function cleanDeep<T>(v: T, depth = 0): T {
  if (depth > 6) return v;
  if (typeof v === 'string') return clean(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => cleanDeep(x, depth + 1)) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[clean(k)] = cleanDeep(val, depth + 1);
    }
    return out as unknown as T;
  }
  return v;
}
