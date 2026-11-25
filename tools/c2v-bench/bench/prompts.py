"""Verbatim business prompts, with an auditable exception for split cells.

Source blocks are visible document text, not executable instructions. No prompt
rewriting, whitespace normalization, category prefix or skill appendix is allowed.
"""
import hashlib

POLICY = "business-verbatim-v1"
TEXT_TYPES = {"text", "ordered", "bullet"}


def text_blocks(row):
    return [dict(b, text=b["text"].replace("\u200b", ""))
            for b in row["blocks"] if b["type"] in TEXT_TYPES]


def extract(blocks, split=None):
    text = "\n".join(b["text"] for b in blocks).strip("\n")
    if split:
        if split.get("kind") != "numbered-cell-part" or split.get("removed_prefix") not in ("1、", "2、"):
            raise ValueError("Unsupported business cell split")
        prefix = split["removed_prefix"]
        if not text.startswith(prefix):
            raise ValueError("Business split prefix does not match source")
        text = text[len(prefix):]
    if not text:
        raise ValueError("Empty business prompt")
    return text


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def validate_prompt(case, required=False):
    contract = case.get("prompt_contract")
    if not contract:
        if required:
            raise ValueError("Missing verbatim business prompt contract")
        return  # Frozen legacy suites keep their original adapters.
    if contract.get("policy") != POLICY:
        raise ValueError("Unknown prompt contract")
    expected = extract(contract["source_blocks"], contract.get("split"))
    if case.get("prompt_original") != expected or case.get("prompt_submitted") != expected:
        raise ValueError("Prompt differs from frozen business original; do not rewrite or append instructions")
    if sha(expected) != contract.get("sha256"):
        raise ValueError("Business prompt SHA256 mismatch")
    if case.get("submission_clarification"):
        raise ValueError("Verbatim business prompt must not include clarification")
    return expected
