/**
 * claude --output-format stream-json 的事件解析。
 *
 * 这是过程窗口（V2 需求 4）与 cc 回复显示（V2 需求 7）的数据源。
 * 事件结构已在后端实测确认。
 *
 * 关键：thinking_tokens 每秒数条，必须丢弃，否则洗屏。
 */

/** 把一条 stream-json 记录转成 0~N 条对外事件。 */
export function parseStreamLine(line, { truncateBytes = 2000 } = {}) {
  let rec;
  try { rec = JSON.parse(line); } catch { return []; }
  const out = [];

  switch (rec.type) {
    case 'system':
      if (rec.subtype === 'thinking_tokens') return [];          // ★ 噪音，丢弃
      if (rec.subtype === 'init') {
        out.push({
          kind: 'init',
          cc_session_id: rec.session_id,
          cwd: rec.cwd,
          model: rec.model,
          skills: rec.skills ?? [],
          tools: rec.tools ?? [],
          claude_version: rec.claude_code_version,
        });
      } else if (rec.subtype) {
        out.push({ kind: 'system', subtype: rec.subtype });
      }
      break;

    case 'assistant': {
      for (const c of rec.message?.content ?? []) {
        if (c.type === 'tool_use') {
          out.push({
            kind: 'tool_use',
            tool: c.name,
            tool_id: c.id,
            input: summarizeToolInput(c.name, c.input, truncateBytes),
          });
        } else if (c.type === 'text' && c.text?.trim()) {
          // ★ 既进过程框，也要在对话区显示（V2 需求 7）
          out.push({ kind: 'assistant_text', text: c.text });
        } else if (c.type === 'thinking' && c.thinking?.trim()) {
          out.push({ kind: 'thinking', text: truncate(c.thinking, truncateBytes) });
        }
      }
      break;
    }

    case 'user': {
      for (const c of rec.message?.content ?? []) {
        if (c.type !== 'tool_result') continue;
        const body = typeof c.content === 'string'
          ? c.content
          : Array.isArray(c.content)
            ? c.content.map((x) => x?.text ?? '').join('\n')
            : JSON.stringify(c.content ?? '');
        out.push({
          kind: 'tool_result',
          tool_id: c.tool_use_id,
          is_error: c.is_error === true || /^(error|Error)[: ]/.test(body),
          text: truncate(body, truncateBytes),
        });
      }
      break;
    }

    case 'result':
      out.push({
        kind: 'result',
        subtype: rec.subtype,
        is_error: rec.is_error === true,
        duration_ms: rec.duration_ms,
        num_turns: rec.num_turns,
        total_cost_usd: rec.total_cost_usd,
        result_text: rec.result ? truncate(String(rec.result), truncateBytes) : null,
      });
      break;

    default:
      break;
  }
  return out;
}

function truncate(s, n) {
  if (typeof s !== 'string') s = String(s ?? '');
  return s.length <= n ? s : `${s.slice(0, n)}\n…（已截断 ${s.length - n} 字符）`;
}

/**
 * 工具入参摘要。
 * 完整 input 可能很大（Write 的 content、Edit 的 diff），过程框只需看懂"在做什么"。
 */
function summarizeToolInput(tool, input, n) {
  if (!input || typeof input !== 'object') return {};
  const pick = (...keys) => {
    const o = {};
    for (const k of keys) if (input[k] !== undefined) o[k] = input[k];
    return o;
  };
  switch (tool) {
    case 'Bash':
      return { command: truncate(input.command, 400), description: input.description };
    case 'Write':
      return { file_path: input.file_path, bytes: String(input.content ?? '').length };
    case 'Edit':
      return { file_path: input.file_path, replace_all: input.replace_all };
    case 'Read':
      return pick('file_path', 'offset', 'limit');
    case 'Skill':
      return pick('skill', 'args');
    case 'Glob':
    case 'Grep':
      return pick('pattern', 'path', 'glob');
    case 'Task':
      return { subagent_type: input.subagent_type, description: input.description };
    default: {
      const s = JSON.stringify(input);
      return s.length <= n ? input : { _summary: truncate(s, n) };
    }
  }
}

/** 从事件流推断生产阶段。比看 stdout 文本可靠。 */
export function phaseFromEvent(ev) {
  if (ev.kind === 'tool_use') {
    const cmd = String(ev.input?.command ?? '');
    if (/ffmpeg|render\.mjs|capture\.mjs/.test(cmd)) return 'RENDERING';
    if (/ffprobe|check_video|contact_sheet|review\.py/.test(cmd)) return 'FINALIZING';
    if (ev.tool === 'Write' && /SPEC\.md$/.test(String(ev.input?.file_path ?? ''))) return 'PREPARING';
    if (ev.tool === 'Write' || ev.tool === 'Edit') return 'GENERATING';
  }
  return null;
}
