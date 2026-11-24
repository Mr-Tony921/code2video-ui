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
    args = p.parse_args()
    root = args.data_root.resolve()
    path = root / "dataset/v0.1.0/suite.json"
    suite = json.loads(path.read_text())
    assets = {a["id"]: a for a in suite["assets"]}
    ids = [c["id"] for c in suite["cases"]]
    assert len(ids) == len(set(ids)) == 19
    assert sum(c["status"] == "ready" for c in suite["cases"]) == 15
    for c in suite["cases"]:
        assert c["skill_policy"] in suite["policies"]
        gate = evaluate_gate(c["gate_intake"])
        assert gate == c["skill_gate"]
        assert c["prompt_submitted"] == adapt_prompt(c["category"], c["prompt_original"], gate)[0]
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
                "cases": 19,
                "ready": 15,
                "blocked": 4,
                "suite_file_sha256": sha(path),
                "media_hash_checks": checked,
            }
        )
    )


if __name__ == "__main__":
    main()
