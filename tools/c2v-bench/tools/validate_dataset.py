#!/usr/bin/env python3
"""Verify versioned definitions; --media also checks every available source hash."""
import argparse, hashlib, json, sys
from pathlib import Path


def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bench"))
from gate import evaluate_gate, adapt_prompt

def main():
    p = argparse.ArgumentParser()
    p.add_argument(
        "--data-root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    p.add_argument("--media", action="store_true")
    p.add_argument("--suite-version", default="0.1.2")
    args = p.parse_args()
    root = args.data_root.resolve()
    import re
    assert re.fullmatch(r"0\.\d+\.\d+", args.suite_version), "Invalid suite version"
    path = root / "dataset" / ("v" + args.suite_version) / "suite.json"
    suite = json.loads(path.read_text())
    assets = {a["id"]: a for a in suite["assets"]}
    ids = [c["id"] for c in suite["cases"]]
    assert ids and len(ids) == len(set(ids))
    ready = sum(c["status"] == "ready" for c in suite["cases"])
    if suite.get("revision_summary"):
        assert len(ids) == suite["revision_summary"]["total_cases"]
        assert ready == suite["revision_summary"]["ready"]
    for c in suite["cases"]:
        assert c["skill_policy"] in suite["policies"]
        gate = evaluate_gate(c["gate_intake"])
        assert gate == c["skill_gate"]
        assert c["prompt_submitted"] == adapt_prompt(c["category"], c["prompt_original"], gate, c.get("submission_clarification"))[0]
        assert c["status"] == "ready" or c["block_reason"]
        for aid in c["input_assets"]:
            assert aid in assets and "input" in assets[aid]["roles"]
        for out in c["reference_outputs"]:
            assert out["model"] is None and out["model_status"] == "unknown"
            if "asset_id" in out:
                assert (
                    out["asset_id"] in assets
                    and out["asset_id"] not in c["input_assets"]
                )
    checked = 0
    if args.media:
        source_manifest = json.loads((root / "source/manifest.json").read_text())
        assert source_manifest["archive_sha256"] == suite["source"]["archive_sha256"]
        entries = [
            (root / "source/business-20261124" / a["path"], a["sha256"])
            for a in source_manifest["files"]
        ]
        entries += [(root / a["path"], a["sha256"]) for a in assets.values()]
        remote = root / "source/remote-references/manifest.json"
        if remote.exists():
            entries += [
                (root / a["path"], a["sha256"])
                for a in json.loads(remote.read_text()).values()
                if a.get("fetch_status") == "downloaded"
            ]
        for file, expected in entries:
            assert root in file.resolve().parents
            assert sha(file) == expected, str(file)
            checked += 1
    print(
        json.dumps(
            {
                "version": suite["version"],
                "cases": len(ids),
                "ready": ready,
                "blocked": len(ids) - ready,
                "suite_file_sha256": sha(path),
                "media_hash_checks": checked,
            }
        )
    )


if __name__ == "__main__":
    main()
