const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
let boot,
  models = [],
  runs = [],
  runsLoaded = false,
  stats = [],
  tab = "cases",
  current,
  plan = null,
  resultVersion = null,
  showcase = 0;
const fmt = (s) =>
  s == null
    ? "未测"
    : s < 60
      ? `${s.toFixed(1)} 秒`
      : `${(s / 60).toFixed(1)} 分`;
const elapsed = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "未记录";
  const s = Math.round(value), pad = n => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}小时${pad(Math.floor(s % 3600 / 60))}分钟${pad(s % 60)}秒`;
};
const verdict = (x) =>
  x === true ? "通过" : x === false ? "未通过" : "待检查";
const qname = {
  pass: "达标",
  partial: "部分达标",
  fail: "不达标",
  unreviewed: "待人工评价",
};
async function api(path, body) {
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Bench-Token": boot.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "请求失败");
  return d;
}
function notice(t = "") {
  $("#notice").textContent = t;
}
function video(src, local = false) {
  return `<video controls playsinline preload="${local ? "metadata" : "none"}" src="${esc(src)}"></video><div class="video-note">默认 2× 浏览 · 核对动作、切换和音画同步时请选 1× <button class="speed" data-speed="1">1×</button> <button class="speed" data-speed="2">2×</button></div>`;
}
function setupVideos() {
  document.querySelectorAll("video").forEach((v) => {
    v.defaultPlaybackRate = 2;
    v.playbackRate = 2;
  });
}
function account() {
  $("#account").innerHTML = boot.user
    ? `<span class="badge neutral">${esc(boot.user.username)}</span><button data-action="logout">退出</button>`
    : '<button data-action="login">登录 dev</button>';
}
function selectCase(id) {
  current = (tab === "review" ? reviewCases() : boot.suite.cases).find((c) => c.id === id) || boot.suite.cases[0];
  plan = null;
  history.replaceState(null, "", `?case=${current.id}&tab=${tab}`);
  render();
}
function asset(aid) {
  return boot.suite.assets.find((a) => a.id === aid);
}
function resultRuns() {
  return runs.filter(r => r.suite_version === (resultVersion || boot.suite.version));
}
function versionSelector() {
  const selected = resultVersion || boot.suite.version;
  const versions = [...new Set([boot.suite.version, ...runs.map(r => r.suite_version)])].sort().reverse();
  return `<label class="meta">结果套件版本 <select id="result-version">${versions.map(v => `<option value="${esc(v)}" ${v===selected ? "selected" : ""}>${esc(v)}${v===boot.suite.version ? "（当前）" : "（历史）"}</option>`).join("")}</select></label><p class="meta">旧片按提交时的冻结 prompt 和验收要求查看，不计入新版结果。</p>`;
}
function durationLabel(c) {
  const r = c.requirements;
  if (r.duration_range_seconds) return `明确时长 ${r.duration_range_seconds.join("–")} 秒`;
  return r.duration_seconds ? `明确时长 ${r.duration_seconds} 秒` : r.duration_target_seconds ? `约 ${r.duration_target_seconds} 秒（人工核对约数）` : "未指定时长，不按参考片长判失败";
}
function reference(c) {
  const r = c.reference_outputs[0];
  if (!r)
    return '<p class="muted">业务未提供参考成片。不用其它案例的内容补作答案。</p>';
  const src = r.asset_id
    ? "/media/" + r.asset_id
    : "/reference?url=" + encodeURIComponent(r.url);
  return (
    video(src, true) +
    `<p class="meta">业务参考 · 模型未知 · 原文注明“不是理想效果”<br>${esc(r.inspection_note || "")}${r.url ? ` · <a target="_blank" rel="noreferrer" href="${esc(r.url)}">原始外链</a>` : ""}</p>`
  );
}
function modelName(r) {
  return (r.job?.model_selection || r.model_requested).model;
}
function modelLabel(r) {
  const name = modelName(r);
  return name === "deepseek-c2v-v1" ? "自研 C2V · deepseek-c2v-v1" : name.startsWith("claude-opus") ? "Opus 5.5 · 对照" : name;
}
function runOrder(a, b) {
  return (modelName(a) === "deepseek-c2v-v1" ? 0 : 1) - (modelName(b) === "deepseek-c2v-v1" ? 0 : 1) || modelName(a).localeCompare(modelName(b)) || a.created_at.localeCompare(b.created_at);
}
const reviewed = (r) => r.evaluation?.quality && r.evaluation.quality !== "unreviewed";
const bytes = (n) => n == null ? "" : n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`;
function runCard(r) {
  const e = r.evaluation || {},
    j = r.job || {},
    m = j.model_selection || r.model_requested;
  return `<section class="panel"><div class="runhead">${esc(modelLabel(r))}</div><p class="meta">测试集 ${esc(r.suite_version)} · ${esc(r.case.skill_policy)} · ${esc(r.state)} · ${r.local_original_available ? "本地原片 · 未转码" : "远程产物"}</p>${j.result_asset?.playable ? video(`/api/run/${r.id}/media`, !!r.local_original_available) : '<p class="empty">' + (r.job_id ? "尚无可播放的最终产物" : "计划已保存，尚未提交") + "</p>"}<div class="meta">成片 ${fmt(r.probe?.duration_seconds ?? (j.result_asset?.duration_ms / 1000 || null))} · ${r.probe?.width || j.result_asset?.width || "?"}×${r.probe?.height || j.result_asset?.height || "?"} · ${bytes(r.local_original?.bytes ?? j.result_asset?.size_bytes)}<br>制作时长 ${elapsed(e.execution_seconds)}<br>排队 ${elapsed(e.queue_seconds)} / 总计 ${elapsed(e.total_seconds)}<br>完整解码：${verdict(e.render_verified)} · 硬要求：${verdict(e.hard_pass)} · 质量：${qname[e.quality] || "待评价"}</div>${r.last_error ? `<p class="warning">${esc(r.last_error)}</p>` : ""}<div class="actions">${!r.job_id ? `<button class="primary" data-run="${r.id}" data-op="submit">提交 / 恢复此计划</button>` : `<button data-run="${r.id}" data-op="refresh">刷新状态</button><a target="_blank" href="${esc(boot.dev_url)}/?session=${esc(r.session_id)}">dev 会话</a>`}${j.result_asset?.playable ? `<button data-run="${r.id}" data-op="probe">${e.render_verified ? "重新解码检查" : "下载原片并完整解码"}</button><a href="/api/run/${r.id}/download">下载原片</a>` : ""}${r.job_id ? `<a href="/api/run/${r.id}/archive">完整轨迹归档</a>` : ""}</div>${r.state === "CREATING_SESSION" && !r.session_id ? `<div class="actions"><input placeholder="人工确认的 sess_…" id="bind-${r.id}"><button data-run="${r.id}" data-op="bind">绑定已创建会话</button></div>` : ""}<details><summary>本地路径、版本与提交证据</summary><pre class="prompt">${esc(JSON.stringify({ suite_version: r.suite_version, prompt_original: r.case.prompt_original, prompt_submitted: r.case.prompt_submitted, requirements: r.case.requirements, local_original: r.local_original, cohort: r.cohort, session_id: r.session_id, job_id: r.job_id, model_requested: r.model_requested, model_actual: j.model_selection, skill_requested: r.skill_requested, skill_actual: j.experimental_skills, suite_sha256: r.suite_sha256, uploads: r.uploads, probe: r.probe, events: r.events }, null, 2))}</pre></details>${["COMPLETED", "FAILED", "CANCELLED", "OUT_OF_SCOPE"].includes(j.status) ? reviewForm(r) : ""}</section>`;
}
function reviewForm(r) {
  const v = r.reviews.at(-1) || {};
  return `<details><summary>人工评价（与模型自审分开）</summary><form class="review" data-run="${r.id}"><label>指令硬要求<select name="hard_instructions">${["unreviewed", "pass", "fail"].map((x) => `<option value="${x}" ${v.hard_instructions === x ? "selected" : ""}>${qname[x]}</option>`).join("")}</select></label><label>整体质量<select name="quality">${Object.keys(
    qname,
  )
    .map(
      (x) =>
        `<option value="${x}" ${(v.quality || "unreviewed") === x ? "selected" : ""}>${qname[x]}</option>`,
    )
    .join(
      "",
    )}</select></label><label>结论与瑕疵<textarea name="note">${esc(v.note || "")}</textarea></label><label>证据：时间点、镜头或截图位置<textarea name="evidence">${esc(v.evidence || "")}</textarea></label><button>保存评价</button><p class="meta">历次评价保留，不覆盖；未检查项目保持“待人工评价”。</p></form></details>`;
}
function gatePanel(c) {
  const g = c.skill_gate;
  if (!g) return "";
  return `<section class="panel"><h3>Anatomy 适配 gate <span class="badge ${g.status === "suitable" ? "" : "neutral"}">${esc(g.label)}</span></h3><p class="meta">${esc(g.version)} · 基于有原文依据的需求分类，不调用模型，也不是质量通过结论。</p><ul>${g.reasons.map(x => `<li>${esc(x)}</li>`).join("")}${g.adaptations.map(x => `<li>${esc(x)}</li>`).join("")}</ul><details><summary>分类依据与原文证据</summary><pre class="prompt">${esc(JSON.stringify(c.gate_intake, null, 2))}</pre></details></section>`;
}
function renderCases() {
  const c = boot.suite.cases.find(c => c.id === current.id) || boot.suite.cases[0];
  current = c;
  const same = runs.filter((r) => r.case.id === c.id && r.suite_version === boot.suite.version).sort(runOrder);
  return `<div class="layout"><aside class="sidebar"><p class="meta">${boot.suite.source_rows || boot.suite.revision_summary?.source_rows || new Set(boot.suite.cases.map(x=>x.source_location?.row).filter(x=>x!=null)).size || boot.suite.cases.length} 行业务输入 · ${boot.suite.cases.length} 个测试案 · ${boot.suite.cases.filter(x=>x.status==="ready").length} 条可测试<br>${boot.suite.cases.filter(x=>x.status!=="ready").length} 条缺输入 · 业务参考模型均未知</p>${boot.suite.cases.map((x) => `<button class="case-btn ${x.id === c.id ? "active" : ""}" data-case="${x.id}">${esc(x.id.slice(0, 2))} ${esc(x.title)}<small>${esc(x.category)} · ${x.status === "ready" ? "可测试" : "待补输入"}</small></button>`).join("")}</aside><div><span class="badge">${esc(c.category)}</span><span class="badge ${c.status === "ready" ? "neutral" : "warn"}">${c.status === "ready" ? "可测试" : "待补输入"}</span><h2 style="margin-top:12px">${esc(c.title)}</h2>${c.revision ? `<p class="${c.revision.action === "unchanged" ? "meta" : "warning"}">本版变化：${esc(c.revision.description)}</p>` : ""}${c.block_reason ? `<p class="warning">${esc(c.block_reason)}</p>` : ""}<div class="two"><section class="panel"><h3>原始输入</h3><pre class="prompt">${esc(c.prompt_original)}</pre><div class="images">${c.input_assets.map((id) => `<figure><a href="/media/${id}" target="_blank"><img src="/media/${id}" alt="输入素材 ${esc(asset(id).name)}"></a><figcaption>${esc(asset(id).name)}</figcaption></figure>`).join("")}</div><p class="meta">${c.input_assets.length} 个输入附件。${c.prompt_contract ? `业务原文直接提交，SHA256：${esc(c.prompt_contract.sha256)}。不追加类型、制作方式或文案。Anatomy 通过独立技能配置选择。` : "历史版本按当时冻结的 prompt 适配规则保留。"}</p>${c.submission_clarification ? `<p class="warning">执行补充：${esc(c.submission_clarification)}</p>` : ""}<details><summary>查看最终提交 prompt</summary><pre class="prompt">${esc(c.prompt_submitted)}</pre></details></section><section class="panel"><h3>业务参考成片</h3>${reference(c)}</section></div>${gatePanel(c)}<section class="panel"><h3>验收要点</h3><p class="meta">${durationLabel(c)} · ${c.requirements.aspect_ratio || "未指定画幅"} · ${esc(c.skill_policy)}</p><ul>${c.requirements.quality_checks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>${c.requirements.exact_text.length ? `<p class="meta">指定文案：${c.requirements.exact_text.map(esc).join(" / ")}</p>` : ""}</section><section class="panel"><h3>新建测试</h3><p class="meta">通过 dev 普通网页 API 上传输入、提交排队。模型和 skill 按计划留档；不修改线上默认值、不自动重跑。模型在目录中可选不代表当前连通。</p><div class="formrow"><label>当前可见模型<select id="model"><option value="">${boot.user ? "请选择模型" : "请先登录读取模型目录"}</option>${models.map((m) => `<option value="${esc(m.profile_id)}">${esc(m.name)}</option>`).join("")}</select></label><label>批次名<input id="cohort" value="c2v-${boot.suite.version}-${new Date().toISOString().slice(0, 10)}"></label></div><button id="plan" ${!boot.user || c.status !== "ready" ? "disabled" : ""}>预览并保存测试计划</button>${plan ? `<div class="warning" style="margin-top:16px">已保存计划：${esc(plan.id)}<br>模型：${esc(plan.model_requested.model)}<br>技能：${esc(plan.case.skill_policy)} · ${plan.case.input_assets.length} 张输入图<br>点击下方提交后才会消耗模型资源。<div class="actions"><button class="primary" data-run="${plan.id}" data-op="submit">确认此配置并提交</button></div></div>` : ""}</section><h3 style="margin-top:28px">本案结果对照 <small>${same.length} 条</small></h3>${same.length ? `<div class="cards">${same.map(runCard).join("")}</div>` : '<p class="empty">本版尚未生成；参考片不计为测试通过。</p>'}</div></div>`;
}
function reviewCases() {
  const found = new Map();
  for (const r of resultRuns().filter(r => r.job_id)) if (!found.has(r.case.id)) found.set(r.case.id, r.case);
  return [...found.values()].sort((a,b) => a.id.localeCompare(b.id));
}
function modelGroups() {
  const groups = new Map();
  for (const r of [...resultRuns()].filter((x) => x.job_id).sort(runOrder)) {
    const key = JSON.stringify([r.cohort, r.suite_sha256, modelName(r), (r.job?.model_selection || r.model_requested).revision]);
    if (!groups.has(key)) groups.set(key, { label: modelLabel(r), cohort: r.cohort, runs: [] });
    groups.get(key).runs.push(r);
  }
  return [...groups.values()];
}
function median(values) {
  const a = values.filter((x) => x != null).sort((a, b) => a - b), n = a.length;
  return n ? (a[Math.floor((n - 1) / 2)] + a[Math.floor(n / 2)]) / 2 : null;
}
function renderResults() {
  if (boot.user && !runsLoaded) return '<h2>结果总览</h2><p class="muted">正在读取本地结果…</p>';
  const groups = modelGroups(), cases = reviewCases();
  return `<h2>结果总览</h2>${versionSelector()}<p class="muted">按任务并排对照，点击案例进入审核。原片保留原分辨率和编码，优先从本地播放；人工评价与技术检查分开。</p>
  <div class="metrics"><div class="metric"><strong>${cases.length}</strong><span>已测试业务案例</span></div><div class="metric"><strong>${resultRuns().filter(r=>r.local_original_available).length} / ${resultRuns().filter(r=>r.job_id).length}</strong><span>原片已下载到本地</span></div><div class="metric"><strong>${resultRuns().filter(r=>r.evaluation?.render_verified === true).length}</strong><span>完整解码通过</span></div><div class="metric"><strong>${resultRuns().filter(reviewed).length}</strong><span>已人工评价</span></div></div>
  <section class="panel scroll"><h3>模型对照</h3><table><thead><tr><th>模型 / 批次</th><th>有成片 / 已提交</th><th>本地原片</th><th>完整解码通过</th><th>已评价 / 质量达标</th><th>制作中位 / 最长</th></tr></thead><tbody>${groups.map(g=>{
    const times=g.runs.map(r=>r.evaluation.execution_seconds).filter(x=>x!=null);
    return `<tr><td><strong>${esc(g.label)}</strong><br><small>${esc(g.cohort)}</small></td><td>${g.runs.filter(r=>r.evaluation.has_video).length} / ${g.runs.length}</td><td>${g.runs.filter(r=>r.local_original_available).length} / ${g.runs.length}</td><td>${g.runs.filter(r=>r.evaluation.render_verified===true).length} / ${g.runs.length}</td><td>${g.runs.filter(reviewed).length} / ${g.runs.filter(r=>r.evaluation.quality==="pass").length}</td><td>${elapsed(median(times))} / ${elapsed(times.length ? Math.max(...times) : null)}</td></tr>`;
  }).join("") || '<tr><td colspan="6">请登录后查看本账号测试结果。</td></tr>'}</tbody></table></section>
  <p class="meta">制作时长＝开始执行到结束，含模型、工具、自检与渲染，排队另计；不是纯推理时间。解码成功只说明文件可读取，不代表内容质量通过。不同技能的明细仍单独保留在下方。</p>
  <section class="panel scroll"><h3>逐案审核 <small>自研结果在前，Opus 对照在后</small></h3><table><thead><tr><th>任务与验收重点</th>${groups.map(g=>`<th>${esc(g.label)}</th>`).join("")}</tr></thead><tbody>${cases.map(c=>`<tr><td><button class="case-link" data-review-case="${c.id}">${esc(c.id.slice(0,2))} ${esc(c.title)} →</button><br><small>${esc(c.category)} · ${esc(c.skill_policy)}<br>${durationLabel(c)} · ${esc(c.requirements.aspect_ratio || "画幅未限定")}</small></td>${groups.map(g=>`<td>${g.runs.filter(r=>r.case.id===c.id).map(r=>`<div class="result-cell"><strong>成片 ${fmt(r.probe?.duration_seconds ?? (r.job?.result_asset?.duration_ms / 1000 || null))}</strong><br>制作时长 ${elapsed(r.evaluation.execution_seconds)}<br><small>${r.local_original_available ? "本地原片" : "未下载"} · 解码${verdict(r.evaluation.render_verified)}<br>硬要求${verdict(r.evaluation.hard_pass)} · ${qname[r.evaluation.quality] || "待评价"}</small><div class="actions"><button data-review-case="${c.id}">观看 / 评价</button><a href="/api/run/${r.id}/download">原片</a></div></div>`).join("") || "无结果"}</td>`).join("")}</tr>`).join("")}</tbody></table></section>
  <details><summary>按批次、模型 revision 和 skill 分开的统计明细</summary><section class="panel scroll"><table><thead><tr><th>批次 / 模型</th><th>技能</th><th>提交 / 结束</th><th>有视频 / 结束</th><th>解码通过 / 已检测</th><th>硬要求通过 / 已判定</th><th>质量达标 / 已评价</th><th>制作中位 / 最长</th></tr></thead><tbody>${stats.filter(s => s.suite_version === (resultVersion || boot.suite.version)).map(s=>`<tr><td>${esc(s.cohort)}<br>${esc(s.model)}<br><small>${esc(s.model_revision)}</small></td><td>${esc(s.policy)}<br><small>${esc(s.skill_revision.slice(0,10))}</small></td><td>${s.submitted} / ${s.terminal}</td><td>${s.has_video} / ${s.terminal}</td><td>${s.render_verified} / ${s.render_verified+s.render_failed}</td><td>${s.hard_pass} / ${s.hard_pass+s.hard_fail}</td><td>${s.quality_pass} / ${s.reviewed}</td><td>${elapsed(s.median_execution_seconds)} / ${elapsed(s.max_execution_seconds)}</td></tr>`).join("")}</tbody></table></section></details>
  <details><summary>全部计划与任务状态（含未提交计划）</summary>${resultRuns().map(r=>`<p class="meta"><button data-case="${r.case.id}">${esc(r.case.title)}</button> ${esc(r.cohort)} · ${esc(r.state)} <button data-run="${r.id}" data-op="${r.job_id ? "refresh" : "submit"}">${r.job_id ? "刷新状态" : "提交 / 恢复"}</button></p>`).join("")}</details>`;
}
function renderReview() {
  const cases=reviewCases();
  if (!cases.length) return `<h2>逐案审核</h2>${versionSelector()}<p class="empty">${!boot.user ? "请登录后查看本账号已提交的案例。" : runsLoaded ? "该版本尚无已提交案例；可切换到历史版本查看旧片。" : "正在读取本地结果…"}</p>`;
  const c=cases.find(x=>x.id===current.id) || cases[0];
  current=c;
  const index=cases.findIndex(x=>x.id===c.id), same=resultRuns().filter(r=>r.case.id===c.id && r.job_id).sort(runOrder);
  return `${versionSelector()}<div class="layout review-layout"><aside class="sidebar"><p class="meta">${cases.length} 案 · ${resultRuns().filter(r=>r.job_id).length} 条结果<br>默认 2× · 评价记录可追溯</p>${cases.map(x=>{const rs=resultRuns().filter(r=>r.case.id===x.id&&r.job_id);return `<button class="case-btn ${x.id===c.id ? "active" : ""}" data-review-case="${x.id}">${esc(x.id.slice(0,2))} ${esc(x.title)}<small>已评价 ${rs.filter(reviewed).length} / ${rs.length} · ${x.skill_policy.includes("anatomy") ? "Anatomy" : "C2V"}</small></button>`;}).join("")}</aside><div><div class="review-title"><div><span class="badge">${esc(c.category)}</span><h2>${esc(c.title)}</h2></div><div class="actions"><button data-review-case="${cases[Math.max(0,index-1)].id}" ${index===0?"disabled":""}>上一案</button><span class="meta">${index+1} / ${cases.length}</span><button data-review-case="${cases[Math.min(cases.length-1,index+1)].id}" ${index===cases.length-1?"disabled":""}>下一案</button><button data-tab="results">总览</button></div></div>
  <section class="panel review-brief"><h3>验收要点</h3><p class="meta">${durationLabel(c)} · ${esc(c.requirements.aspect_ratio || "画幅未限定")} · ${esc(c.skill_policy)}</p><ul>${c.requirements.quality_checks.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>${c.requirements.exact_text.length ? `<p class="meta">指定文案：${c.requirements.exact_text.map(esc).join(" / ")}</p>` : ""}<details><summary>原始需求、输入图片与最终提交 prompt</summary><pre class="prompt">${esc(c.prompt_original)}</pre><div class="images">${c.input_assets.map(id=>`<figure><a href="/media/${id}" target="_blank"><img src="/media/${id}" alt="${esc(asset(id).name)}"></a><figcaption>${esc(asset(id).name)}</figcaption></figure>`).join("")}</div><h3>最终提交 prompt</h3><pre class="prompt">${esc(c.prompt_submitted)}</pre></details></section>
  <div class="cards">${same.map(runCard).join("")}</div>
  <section class="panel reference-panel"><h3>业务参考成片 <small>模型未知，仅作参考</small></h3>${reference(c)}</section><details><summary>Anatomy gate 与测试输入详情</summary>${gatePanel(c)}<button data-case="${c.id}">打开业务测试集</button></details></div></div>`;
}
function renderShowcase() {
  const s = boot.baselines.showcases[showcase];
  return `<h2>历史 Showcase</h2><p class="muted">7 个展示片均有远程 job 记录，实际模型为 Opus 5.5。它们不是本套业务测试的当前版本结果。</p><div class="showcase-list">${boot.baselines.showcases.map((x, i) => `<button class="${i === showcase ? "active" : ""}" data-showcase="${i}">${esc(x.title)}</button>`).join("")}</div><div class="two"><section class="panel"><h3>${esc(s.title)}</h3>${video("/showcase/" + s.id)}<p class="meta">${s.is_revision ? "这是追问修改结果，不能计为首轮通过。" : "历史展示，未按本版验收。"} · ${s.video.width}×${s.video.height} · ${s.video.duration_ms / 1000} 秒</p></section><section class="panel"><h3>可追溯信息</h3><p class="meta">实际模型：${esc(s.model_selection.model)}<br>模型 revision：${esc(s.model_selection.revision)}<br>builtin：${esc(s.experimental_skills.builtin)} · 自定义技能：${esc(s.experimental_skills.skills.join(", ") || "无")}<br>该轮制作时长：${elapsed(s.wall_seconds)}（含工具、渲染，不是纯推理）<br>Job：${esc(s.job_id)}</p><pre class="prompt">${esc(s.prompt)}</pre></section></div><p class="warning">5 个历史片未启用内置 C2V，2 个挂了 Anatomy；其中一个仅留有本轮修改要求。不能与本套统一 C2V 策略直接比较通过率。</p>`;
}
function render() {
  history.replaceState(null, "", `?case=${current.id}&tab=${tab}`);
  $("#suite-version").textContent = `0.1.4 · 测试集 ${boot.suite.version}`;
  account();
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#app").innerHTML =
    tab === "cases"
      ? renderCases()
      : tab === "results"
        ? renderResults()
        : tab === "review" ? renderReview() : renderShowcase();
  setupVideos();
}
async function updateRuns(draw = false) {
  if (!boot.user) return;
  const r = await api("/api/runs");
  const changed =
    JSON.stringify(runs.map((x) => [x.id, x.state, x.last_error, x.probe, x.local_original_available, x.reviews])) !==
    JSON.stringify(r.runs.map((x) => [x.id, x.state, x.last_error, x.probe, x.local_original_available, x.reviews]));
  runs = r.runs;
  runsLoaded = true;
  stats = r.summary;
  if (draw) render();
  else if (changed)
    notice("任务状态有更新，点击“刷新结果”查看；正在播放的视频不会被重置。");
}
async function loadCatalog() {
  if (boot.user) {
    models = (await api("/api/catalog")).models;
    const select = $("#model");
    if (select) select.innerHTML = '<option value="">请选择模型</option>' + models.map(m => `<option value="${esc(m.profile_id)}">${esc(m.name)}</option>`).join("");
  }
}
document.addEventListener("change", (e) => {
  if (e.target.id === "result-version") {
    resultVersion = e.target.value;
    render();
  }
});
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.id === "refresh-view") {
      await updateRuns(true);
      notice("结果已刷新。");
      return;
    }
    if (b.dataset.tab) {
      tab = b.dataset.tab;
      await updateRuns();
      render();
      return;
    }
    if (b.dataset.reviewCase) {
      tab = "review";
      selectCase(b.dataset.reviewCase);
      return;
    }
    if (b.dataset.case) {
      tab = "cases";
      selectCase(b.dataset.case);
      return;
    }
    if (b.dataset.showcase) {
      showcase = Number(b.dataset.showcase);
      render();
      return;
    }
    if (b.dataset.speed) {
      b.parentElement.previousElementSibling.playbackRate = Number(
        b.dataset.speed,
      );
      return;
    }
    if (b.dataset.action === "login") {
      $("#login").showModal();
      return;
    }
    if (b.id === "close-login") {
      $("#login").close();
      return;
    }
    if (b.dataset.action === "logout") {
      await api("/api/logout", {});
      boot.user = null;
      models = [];
      runs = [];
      runsLoaded = false;
      stats = [];
      render();
      return;
    }
    if (b.id === "plan") {
      b.disabled = true;
      plan = await api("/api/plan", {
        case_id: current.id,
        model_id: $("#model").value,
        cohort: $("#cohort").value,
      });
      await updateRuns();
      notice("计划已保存。请核对配置，再点击提交。");
      render();
      return;
    }
    if (b.dataset.run) {
      b.disabled = true;
      const body =
        b.dataset.op === "bind"
          ? { session_id: $("#bind-" + b.dataset.run).value }
          : {};
      await api(`/api/run/${b.dataset.run}/${b.dataset.op}`, body);
      notice(
        b.dataset.op === "submit"
          ? "提交处理已开始；不会因刷新或重复点击创建第二个任务。"
          : "操作已开始，状态将在后台更新。",
      );
      setTimeout(() => updateRuns(true).catch((x) => notice(x.message)), 1200);
    }
  } catch (err) {
    notice(err.message);
    b.disabled = false;
  }
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const body = Object.fromEntries(new FormData(f));
    if (f.id === "login-form") {
      const r = await api("/api/login", body);
      f.reset();
      $("#login").close();
      boot.user = r.user;
      await updateRuns(true);
      notice();
      loadCatalog().catch((err) => notice("结果已就绪；模型目录暂不可用：" + err.message));
    } else if (f.classList.contains("review")) {
      await api(`/api/run/${f.dataset.run}/review`, body);
      await updateRuns(true);
      notice("评价已保存，历史记录保留。");
    }
  } catch (err) {
    notice(err.message);
  }
});
(async () => {
  try {
    boot = await api("/api/bootstrap");
    const q = new URLSearchParams(location.search);
    tab = ["cases", "results", "review", "showcase"].includes(q.get("tab"))
      ? q.get("tab")
      : "cases";
    current =
      boot.suite.cases.find((c) => c.id === q.get("case")) ||
      boot.suite.cases[0];
    render();
    if (boot.user) {
      await updateRuns(true);
      loadCatalog().catch((err) => notice("结果已就绪；模型目录暂不可用：" + err.message));
    }
    setInterval(() => updateRuns(false).catch(() => {}), 15000);
  } catch (err) {
    notice(err.message);
  }
})();
