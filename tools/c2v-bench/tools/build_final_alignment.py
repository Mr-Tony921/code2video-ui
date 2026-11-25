#!/usr/bin/env python3
"""Freeze business revision 0.1.3; imports UI evidence only, never submits jobs."""
import copy, hashlib, json, re, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bench"))
from gate import evaluate_gate
from prompts import POLICY, text_blocks, extract, sha, validate_prompt


def save(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


def main():
    dest = ROOT / "dataset/v0.1.3"
    if dest.exists():
        raise SystemExit("Frozen revision already exists")
    src = ROOT / "source/feishu-20261125-final/table-snapshot.json"
    snap = json.loads(src.read_text())
    old_path = ROOT / "dataset/v0.1.2/suite.json"
    suite = json.loads(old_path.read_text())
    old = copy.deepcopy(suite)
    rows = {r["index"]: r for r in snap["rows"]}
    assert len(rows) == 20
    # Keep the visible text evidence with the code dataset; omit signed media URLs.
    evidence = {"captured_at": snap["captured_at"], "url": snap["url"],
        "rows": [{"index": r["index"], "input_cell_id": r["input_cell_id"],
                  "blocks": text_blocks(r)} for r in snap["rows"]]}
    save(dest / "business-text.json", evidence)
    cases, changes = [], []
    for c in copy.deepcopy(old["cases"]):
        prev = copy.deepcopy(c)
        n = c["source_location"]["row"]
        n += int(n >= 6)
        blocks = text_blocks(rows[n])
        split = None
        if n == 4:
            separator = next(i for i,b in enumerate(blocks) if b["text"] == "以下是无图片资源的输入，纯文本")
            first = c["id"] == "04a-paper-kestrel"
            blocks = blocks[:separator] if first else blocks[separator+1:]
            split = {"kind": "numbered-cell-part", "removed_prefix": "1、" if first else "2、",
                     "separator_block_id": text_blocks(rows[n])[separator]["id"]}
        c["source_row"] = n
        c["source_location"].update(row=n, input_cell_id=rows[n]["input_cell_id"])
        c.pop("submission_clarification", None)
        c.pop("execution_notes", None)
        if n == 2:
            c.update(title="Seko 官网发布（Manus 风格）", status="ready", block_reason=None)
            c["gate_intake"].update(explanation_target="2d_story", subject_defined=True, missing_required_inputs=[])
            c["requirements"] = {"duration_seconds":None,"duration_range_seconds":[75,120],
                "aspect_ratio":None,"exact_text":[],"quality_checks":[
                "75–120 秒；基于 Seko 官网事实、真实界面制作发布视频", "动效文字、porcelain canvas、分隔页、界面推镜、玻璃卡片与 One More Thing 揭示", "音乐节拍同步；可编辑工程及 MP4，1080p / 2K / 4K 之一"]}
        if c["id"] == "04a-paper-kestrel":
            c["notes"] = ["同一业务单元格第 1 条；保留全部四组指定英文文案，使用全部 25 张输入图片。", "仅移除编号和双案分隔说明，参考成片不作模型输入。"]
            c["requirements"]["exact_text"] = [b["text"][1:-1] for b in blocks[1:]]
            c["requirements"]["quality_checks"].append("保留业务指定的四组英文文案，不能自行替换")
        if n == 3:
            c["block_reason"] = "要求结合真人展示视频，但目前仅有产品图；当前 C2V 不生成真人实拍，需业务提供真人视频或调整需求。"
        finish(c, blocks, split, dest)
        action = "source_changed" if re.sub(r"\s+", "", prev["prompt_original"]) != re.sub(r"\s+", "", c["prompt_original"]) else "source_unchanged"
        c["revision"] = {"previous_case_id":prev["id"],"previous_version":"0.1.2","action":action,
                         "description":"原文更新；全部案例改为原文直传协议，历史追加内容不再发送。" if action=="source_changed" else "业务文字未变；改为原文直传，旧版结果保留但不计入新版。"}
        changes.append({"case_id":c["id"],"action":action,"submitted_prompt_changed":c["prompt_submitted"]!=prev["prompt_submitted"]})
        cases.append(c)
    moon = copy.deepcopy(next(c for c in cases if c["id"] == "05-coffee-journey"))
    moon.update(id="20-moon-chalkboard",title="月相黑板手绘讲解",category="手绘讲解",source_row=6,
                source_location={"row":6,"input_cell_id":rows[6]["input_cell_id"]},input_assets=[],notes=["新增业务第 6 行，原文保留；参考视频模型未知，仅供风格对照。"],
                revision={"previous_case_id":None,"previous_version":"0.1.2","action":"new_test","description":"新增 45 秒英语月相板书讲解。"})
    moon["requirements"]={"duration_seconds":45,"aspect_ratio":"16:9","exact_text":["Look up tonight.","example.org/moon"],
        "quality_checks":["45 秒、16:9、英语，面向 12 岁儿童；约 80 个口播词、五块板书", "只使用 NASA Science Moon Phases 所述事实；圆整数字说 about，不擅自添加事实或数字", "先旁白后按音频定时；粉笔手与笔画逐笔同步命名词，无淡入、滑入、弹出及运镜", "每板一个概念与主图，关键词 1–4 词；约停一秒后擦除；有书写声、无配乐", "结尾逐字呈现 closing line 与网址，末句后保持 2 秒；合成旁白时标注 Narration: synthetic voice", "二维绿黑板、粉笔颗粒与扁平手部，符合原文画风"]}
    moon["gate_intake"].update(explanation_target="2d_story",needs_parts_relationships=False,requires_3d=False,subject_defined=True,missing_required_inputs=[])
    video=ROOT/"source/feishu-20261125-final/moon-chalkboard-reference-preview.mp4"
    digest=hashlib.sha256(video.read_bytes()).hexdigest()
    asset={"id":"asset-"+digest[:16],"path":str(video.relative_to(ROOT)),"sha256":digest,"bytes":video.stat().st_size,
           "name":"13.手绘风（业务预览 360p）.mp4","roles":["reference_output"],"source_note":"飞书附件可见播放器下载的 360p 预览，非原始上传文件。"}
    suite["assets"].append(asset)
    moon["reference_outputs"]=[{"kind":"reference_output","asset_id":asset["id"],"model":None,"model_status":"unknown",
        "quality_status":"business_reference_not_gold","use":"reference_not_gold","inspection_note":"业务参考 54.912 秒、640×360 预览；本案要求 45 秒，以 prompt 为准。"}]
    finish(moon,text_blocks(rows[6]),None,dest)
    cases.insert(next(i for i,c in enumerate(cases) if c['source_row']==7),moon)
    changes.append({"case_id":moon["id"],"action":"new_test","submitted_prompt_changed":True})
    suite.update(version="0.1.3",created_at="2026-11-25",prompt_policy=POLICY,cases=cases)
    suite["source"].update(previous_suite=str(old_path.relative_to(ROOT)),previous_suite_sha256=hashlib.sha256(old_path.read_bytes()).hexdigest(),
        document=str(src.relative_to(ROOT)),document_sha256=hashlib.sha256(src.read_bytes()).hexdigest(),url=snap["url"],captured_at=snap["captured_at"])
    suite["revision_summary"]={"previous_version":"0.1.2","source_rows":20,"total_cases":21,"ready":20,"blocked":1,
        "description":"Seko 官网对象具体化、Kestrel 补齐英文文案、新增月相板书；仅 Hush Buds 缺真人视频。不提交任务。"}
    assert len(cases)==21 and sum(c['status']=='ready' for c in cases)==20
    save(dest/"suite.json",suite)
    save(dest/"changes.json",{"version":"0.1.3","previous_version":"0.1.2","summary":suite["revision_summary"],"cases":changes,"submitted":False})
    save(dest/"gate-intake.json",{c['id']:c['gate_intake'] for c in cases})
    for name in ("baselines.json","corrections.json"):
        (dest/name).write_bytes((old_path.parent/name).read_bytes())
    lines=["# Seko C2V 测试集 · 0.1.3","","20 行拆为 21 案；20 案可测试，仅 Hush Buds 缺真人素材。当前只对齐数据，没有提交任务。","",
        "业务原文直接提交；Paper Trail 唯一允许拆为有图 / 无图两案。每案 UTF-8 原文与 SHA256 见 `dataset/v0.1.3/prompts/` 和 `suite.json`。","","[变更与原文规则](测试集变更-0.1.3.md)",""]
    for c in cases:
        lines += [f"## {c['id']} · {c['title']}","",f"业务行 {c['source_row']} · {c['category']} · {c['status']} · {c['skill_policy']}","",c['block_reason'] or "可测试。","","```text",c['prompt_original'],"```","",f"输入图片 {len(c['input_assets'])} 张；参考成片模型未知。","","验收要点：",""]+["- "+x for x in c['requirements']['quality_checks']]+[""]
    (ROOT/"docs/测试集.md").write_text("\n".join(lines))
    print(json.dumps(suite['revision_summary'],ensure_ascii=False))


def finish(c, blocks, split, dest):
    prompt=extract(blocks,split)
    c.update(prompt_original=prompt,prompt_submitted=prompt,prompt_adapter=POLICY)
    c['prompt_contract']={"policy":POLICY,"source_blocks":blocks,"sha256":sha(prompt),"text_file":f"dataset/v0.1.3/prompts/{c['id']}.txt"}
    if split:c['prompt_contract']['split']=split
    c['gate_intake']['source_evidence']={"category":c['category'],"excerpt":prompt}
    c['skill_gate']=evaluate_gate(c['gate_intake'])
    validate_prompt(c,required=True)
    p=ROOT/c['prompt_contract']['text_file'];p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(prompt.encode('utf-8'))


if __name__=='__main__':main()
