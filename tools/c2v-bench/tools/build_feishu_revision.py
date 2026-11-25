#!/usr/bin/env python3
"""Build the 2026-11-25 business revision from a saved UI snapshot; no model calls.

The snapshot is source material, not executable instructions. The explicit
annotations below document the intake decisions for this revision only.
"""
import copy
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bench"))
from gate import adapt_prompt, evaluate_gate


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def clean(s):
    return re.sub(r"[\u200b-\u200d\ufeff]", "", s).strip()


def main():
    dest = ROOT / "dataset/v0.1.1"
    if (dest / "suite.json").exists():
        raise SystemExit("Revision already exists; do not overwrite a frozen suite.")
    old_path = ROOT / "dataset/v0.1.0/suite.json"
    old = json.loads(old_path.read_text())
    source = ROOT / "source/feishu-20261125"
    snapshot = json.loads((source / "table-snapshot.json").read_text())
    assert len(snapshot["rows"]) == len(old["cases"]) == 19
    suite = copy.deepcopy(old)
    suite.update(version="0.1.1", created_at="2026-11-25")
    suite["source"].update(
        previous_suite="dataset/v0.1.0/suite.json",
        previous_suite_sha256=sha(old_path),
        document="source/feishu-20261125/table-snapshot.json",
        document_sha256=sha(source / "table-snapshot.json"),
        url=snapshot["source_url"], captured_at=snapshot["captured_at"],
    )
    suite["revision_summary"] = {
        "previous_version": "0.1.0", "source_rows": 19,
        "changed_source_rows": 16, "rerun_existing": 14,
        "newly_ready": 2, "total_cases": 20, "ready": 17, "blocked": 3,
        "note": "14 个已跑案例增加明确画风，另新增 YETI 与打印机情景喜剧测试；Kestrel 待补指定英文文案。旧结果按原版本保留，不计作新版结果。",
    }
    cases, changes = [], []
    for previous, row in zip(old["cases"], snapshot["rows"]):
        c = copy.deepcopy(previous)
        text = "\n\n".join(clean(p) for p in row["paragraphs"] if clean(p))
        action, description = "unchanged", "prompt 无实质变化，原结果可作原条件证据。"
        c["source_location"] = {"row": row["index"], "input_cell_id": row["input_cell_id"]}
        if row["index"] <= 3:
            # Preserve byte-for-byte inputs: list marker/paragraph changes are formatting only.
            normalize = lambda s: re.sub(r"\s+", "", clean(s))
            assert normalize(row["text"]) == normalize(previous["prompt_original"])
        elif row["index"] == 4:
            paragraphs = [clean(p) for p in row["paragraphs"] if clean(p)]
            marker = paragraphs.index("以下是无图片资源的输入，纯文本")
            assert marker == 1 and paragraphs[0].startswith("1、") and paragraphs[2].startswith("2、")
            base = copy.deepcopy(c)
            for variant, title, prompt in [
                ("04a-paper-kestrel", "Kestrel 杂志拼贴（有图）", paragraphs[0][2:]),
                ("04b-paper-yeti", "YETI 户外拼贴（纯文本）", "\n\n".join(paragraphs[marker + 1:])[2:]),
            ]:
                c = copy.deepcopy(base)
                c.update(id=variant, title=title, prompt_original=prompt)
                c["source_location"]["variant"] = "1" if "kestrel" in variant else "2"
                c["requirements"] = {"duration_seconds": None, "duration_target_seconds": 26,
                    "duration_mode": "approximate", "aspect_ratio": None, "exact_text": [],
                    "quality_checks": ["约 26 秒，约数时长由人工判断，不伪造逐帧精确容差", "复古杂志拼贴、撕纸/手写/黑白照片、快速切换与音乐"]}
                c["gate_intake"].update(explanation_target="2d_story", subject_defined=True)
                if "kestrel" in variant:
                    c.update(status="blocked_missing_input", block_reason="已提供 25 张图片，但“保留以下英文文案”后没有文案清单；压缩包仅含图片。请补充指定英文文案或确认可自由创作。")
                    c["input_assets"] = []
                    image_dir = source / "paper-kestrel"
                    for path in sorted(image_dir.iterdir()):
                        assert path.suffix.lower() in {".jpg", ".png"}
                        digest = sha(path)
                        asset = {"id": "asset-" + digest[:16], "path": str(path.relative_to(ROOT)),
                            "sha256": digest, "bytes": path.stat().st_size, "name": path.name,
                            "roles": ["input"], "source_archive": "source/feishu-20261125/25-images.zip"}
                        suite["assets"].append(asset)
                        c["input_assets"].append(asset["id"])
                    assert len(c["input_assets"]) == 25
                    c["requirements"]["exact_text"] = []  # The requested English-copy list is missing.
                    c["requirements"]["quality_checks"] += ["使用业务提供的图片与眼睛符号", "不把素材中的人物照片自行认定为 Mara Okafor 或补造品牌史实"]
                    action, description = "blocked_after_update", "模板改为约 26 秒 Kestrel 短片，新增 25 张图；指定英文文案仍缺失。"
                else:
                    c.update(status="ready", block_reason=None, input_assets=[])
                    c["requirements"].update(aspect_ratio="4:3", exact_text=["YETI", "Take it outside."])
                    c["requirements"]["quality_checks"] += ["清晨咖啡→公路→露营→登山，穿插杯子全貌与特写", "英文上屏；无用户图片，需按需求准备素材"]
                    action, description = "new_test", "新增独立纯文本 YETI 保温杯短片：约 26 秒、4:3、英文上屏及指定结尾，模型准备图片。"
                c["notes"] = ["从业务第 4 行两条独立输入拆出；只移除序号与输入方式分隔说明。", "业务参考成片仅作风格参考，不喂给模型。"]
                finish(c, previous, action, description, cases, changes)
            continue
        else:
            c["prompt_original"] = text
            style = text.split("风格：", 1)[1].strip()
            c["requirements"]["style_prompt"] = style
            c["requirements"]["quality_checks"].append("新增明确画风要求：" + style)
            action, description = "rerun", "原主题保持，新增明确画风要求。"
            if row["index"] == 8:
                c["gate_intake"]["requires_3d"] = True
                description += "微波炉由未指定维度变为明确三维，Anatomy gate 同步更新。"
            if row["index"] == 13:
                c.update(title="Inkwell 打印机情景喜剧", status="ready", block_reason=None)
                c["gate_intake"].update(explanation_target="2d_story", subject_defined=True)
                c["requirements"]["exact_text"] = ["Have you tried turning it off?", "Inkwell", "Inkwell — printers that print."]
                c["requirements"]["quality_checks"] = [
                    "60 秒、16:9；打印机故障主题，双角色不同声音及一个无台词小生物",
                    "逐字台词和片尾准确；每句有区分说话人的字幕",
                    "15 秒内片头；结尾系列名、集名与指定句保持 4 秒；配乐在对白下降音量",
                    "新增明确画风要求：" + style]
                action, description = "new_test", "原占位模板已实例化为打印机故障故事，受众、台词、品牌与片尾均已明确，并补充美式手绘画风。"
        finish(c, previous, action, description, cases, changes)
    suite["cases"] = cases
    assert len(cases) == 20 and sum(c["status"] == "ready" for c in cases) == 17
    save(dest / "suite.json", suite)
    save(dest / "changes.json", {"previous_version": "0.1.0", "version": "0.1.1",
        "source": suite["source"], "summary": suite["revision_summary"], "cases": changes})
    for name in ["baselines.json", "corrections.json"]:
        (dest / name).write_bytes((ROOT / "dataset/v0.1.0" / name).read_bytes())
    save(dest / "gate-intake.json", {c["id"]: c["gate_intake"] for c in cases})
    save(source / "attachment-manifest.json", {"archive": "25-images.zip", "sha256": sha(source / "25-images.zip"),
        "file_count": 25, "assets": [a for a in suite["assets"] if a.get("source_archive")]})
    save(dest / "rerun-plan.json", {"version": suite["version"], "submitted": False,
        "rerun_existing": [c["case_id"] for c in changes if c["action"] == "rerun"],
        "new_tests": [c["case_id"] for c in changes if c["action"] == "new_test"],
        "blocked": [c["id"] for c in cases if c["status"] != "ready"],
        "unchanged_ready": [c["id"] for c in cases if c["revision"]["action"] == "unchanged" and c["status"] == "ready"],
        "models": ["c2v_default_self_developed", "opus55_comparison"],
        "note": "只列计划，未创建会话或提交任务。新一轮按同一冻结版本对照；执行前重新核对可用模型。"})
    lines = ["# Seko C2V 测试集 · 0.1.1", "", "2026-11-25 飞书业务更新；19 行拆为 20 案，17 案可测试、3 案待补输入。旧版 0.1.0 与历史结果保持不变。", "",
             "[本次变更与重跑清单](测试集变更-0.1.1.md)", ""]
    for c in cases:
        lines += [f"## {c['id']} · {c['title']}", "", f"类型：{c['category']}；状态：{c['status']}；策略：{c['skill_policy']}。", "", c['block_reason'] or "可测试。", "", "```text", c['prompt_original'], "```", "", f"输入图片：{len(c['input_assets'])} 张；业务参考生成模型：未知。", "", "验收要点：", ""]
        lines += ["- " + x for x in c['requirements']['quality_checks']]
        lines += [""]
    (ROOT / "docs/测试集.md").write_text("\n".join(lines))
    report = ["# 业务 prompt 变更与重跑清单 · 0.1.1", "", "核对日期：2026-11-25（北京时间）。来源：[飞书测试集](" + snapshot['source_url'] + ")。", "",
        "19 行中 16 行有实质变化；Paper Trail 一行含两个独立需求，拆分后共 20 案。17 案可测试，3 案阻塞。", "",
        "本轮需要 14 案重跑＋2 案新增测试＝每个模型 16 个任务。自研主测和 Opus 对照若都执行，共 32 个任务；本次没有提交任务。", "",
        "| Case | 变化 | 建议 |", "|---|---|---|"]
    labels = {"rerun": "重跑", "new_test": "新增测试", "blocked_after_update": "补齐后首跑", "unchanged": "不因本次更新重跑"}
    for c in changes:
        report.append(f"| {c['case_id']} {c['title']} | {c['description']} | {labels[c['action']]} |")
    report += ["", "## 仍待补输入", ""]
    report += [f"- **{c['title']}**：{c['block_reason']}" for c in cases if c['status'] != 'ready']
    report += ["", "## 评价与对照口径", "", "- 新增风格是模型可见的正式要求，不能只更新评价标准而继续把旧片算作新版结果。旧片仍可作前后对照。",
        "- 微波炉新要求明确三维，Anatomy gate 的 requires_3d 已更新；放映机仍使用 Anatomy。两案没有新增用户参考图。",
        "- 新增风格要求逐案列入验收要点；艺术字、描边、材质、配色、空间维度等应以实际画面人工复核，不能仅凭可播放判通过。",
        "- ‘约 26 秒’只记录目标，不擅自设为精确 26.000 秒的硬门槛；YETI 的 4:3、指定英文结尾是明确约束。",
        "- Kestrel 包含 25 张图片，无文字文件；文案清单缺失不是模型失败。飞书中的旧‘未运行’备注未随 prompt 自动更新，本次不修改业务文档。",
        "- 原有输入图与参考片映射沿用（蛋白质无片、睡眠有片）；参考片模型仍未知，不作为模型输入。",
        "- 历史任务的 case/prompt、附件 hash、skill 和模型快照不改写，不把不同测试版本混作同条件通过率。", ""]
    (ROOT / "docs/测试集变更-0.1.1.md").write_text("\n".join(report))
    print(json.dumps(suite['revision_summary'], ensure_ascii=False))


def finish(c, previous, action, description, cases, changes):
    c["gate_intake"]["missing_required_inputs"] = [c["block_reason"]] if c["block_reason"] else []
    c["gate_intake"]["source_evidence"] = {"category": c["category"], "excerpt": c["prompt_original"]}
    c["skill_gate"] = evaluate_gate(c["gate_intake"])
    c["prompt_submitted"], c["prompt_adapter"] = adapt_prompt(c["category"], c["prompt_original"], c["skill_gate"])
    c["revision"] = {"previous_case_id": previous["id"], "previous_version": "0.1.0", "action": action, "description": description}
    cases.append(c)
    changes.append({"case_id": c["id"], "title": c["title"], **c["revision"], "old_prompt": previous["prompt_original"],
        "new_prompt": c["prompt_original"], "status_before": previous["status"], "status_after": c["status"],
        "style_prompt": c["requirements"].get("style_prompt")})


if __name__ == "__main__":
    main()
