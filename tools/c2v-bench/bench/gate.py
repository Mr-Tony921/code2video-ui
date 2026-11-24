"""Anatomy applicability gate, not a model-quality verdict.

The intake describes the task's purpose, backed by source evidence. It must be
curated before submission; a title containing 'principle' or '3D' is insufficient.
This module contains no benchmark case IDs, product names, or model calls.
"""
GATE_VERSION = "anatomy-fit-0.1.0"
VIDEO_ADAPTER = (
    "制作方式：使用 Anatomy 组织物体内部结构和工作关系，并结合 C2V 制作完整视频。"
    "将交互式拆解或演示状态编排到确定的时间轴，支持按时间定位和离线导出。"
    "保留原文的主题、产品、指定文案与维度要求；若原文要求三维展示，不以二维 SVG 替代。"
)


def evaluate_gate(intake):
    result = {
        "version": GATE_VERSION,
        "status": "needs_review",
        "label": "待确认",
        "reasons": [],
        "adaptations": [],
        "recommended_policy": "c2v-core-v1",
    }
    if not isinstance(intake, dict) or not intake.get("source_evidence"):
        result["reasons"] = ["缺少有原文依据的需求分类；不依靠关键词自动启用 Anatomy。"]
        return result
    target = intake.get("explanation_target")
    if target in {"exterior_product", "scene_or_system", "typography", "2d_story", "template"}:
        result.update(status="unsuitable", label="不适用")
        result["reasons"] = [
            "当前重点不是单个实体的内部部件、空间结构及工作关系；使用 C2V 对应技能即可。"
        ]
        return result
    if target not in {"physical_internal_structure", "physical_mechanism"}:
        result["reasons"] = ["需求目标尚未明确，应先区分内部结构与场景/系统流程。"]
        return result
    if intake.get("subject_defined") is not True:
        result["reasons"] = ["需要明确拆解的实体及解释范围，不能自行补造产品或模板。"]
        return result
    if intake.get("needs_parts_relationships") is not True:
        result["reasons"] = ["尚不能确认内部部件关系是主要表达目标。"]
        return result
    if intake.get("missing_required_inputs"):
        result["reasons"] = ["必要输入尚未齐备：" + "；".join(intake["missing_required_inputs"])]
        return result
    if intake.get("engineering_precision_required") is not False:
        result["reasons"] = ["先确认是否需要工程级几何、精确 CAD 或仿真；Anatomy 不保证这类精度。"]
        return result
    if intake.get("requires_3d") not in (True, False):
        result["reasons"] = ["需要确认二维等轴测讲解是否可接受，还是明确要求三维展示。"]
        return result
    result.update(status="suitable", label="适用（需视频适配）", recommended_policy="c2v-anatomy-v1")
    result["reasons"] = ["目标明确，需要用内部部件及空间/工作关系解释一个具体实体。"]
    result["adaptations"] = [
        "Anatomy 负责结构表达，C2V 负责时间线、确定性 seek 与完整 MP4。",
        "按需取用结构能力；其 Figure/Hero 等原始预算不是本案通过时长承诺。",
        "挂载不等于调用，后续从实际轨迹确认 Skill 使用情况。",
    ]
    if intake["requires_3d"]:
        result["adaptations"].append("原文明确三维：必须保留三维全貌/特写；仅二维 SVG 不算完整达标。")
    return result


def adapt_prompt(category, original, gate):
    prompt = f"视频类型：{category}\n\n{original}"
    if gate["status"] == "suitable":
        return prompt + "\n\n" + VIDEO_ADAPTER, "category-prefix+anatomy-video-v1"
    return prompt, "category-prefix-v1"
