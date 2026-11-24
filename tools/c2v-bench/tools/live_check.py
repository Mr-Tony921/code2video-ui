#!/usr/bin/env python3
"""Ordinary dev API integration check. Never calls POST .../jobs (no inference)."""
import argparse, hashlib, json, sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bench"))
from remote import Remote
from core import atomic


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--data-root", type=Path, required=True)
    p.add_argument("--account-file", type=Path, required=True)
    p.add_argument("--dev-url", default="http://10.210.9.14:20211")
    p.add_argument("--prepare-input-session", action="store_true")
    args = p.parse_args()
    account = json.loads(args.account_file.read_text())
    remote = Remote(args.dev_url)
    user = remote.login(account["username"], account["password"])
    del account
    if user.get("role") == "admin" or user["username"] not in ["test", "test-peer"]:
        raise ValueError("Use ordinary test/test-peer only")
    models = remote.json("GET", "/api/experimental/models")["models"]
    skills = remote.json("GET", "/api/experimental/skills")["skills"]
    report_path = args.data_root / "runtime/validation/live-api.json"
    old = json.loads(report_path.read_text()) if report_path.exists() else {}
    report = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "dev_url": args.dev_url,
        "user": user["username"],
        "model_count": len(models),
        "model_profiles": [m["profile_id"] for m in models],
        "anatomy_available": any(s["id"] == "anatomy" for s in skills),
        "generation_submitted": False,
    }
    if args.prepare_input_session:
        suite = json.loads((args.data_root / "dataset/v0.1.0/suite.json").read_text())
        case = suite["cases"][0]
        assets = {a["id"]: a for a in suite["assets"]}
        model = next(m for m in models if m["profile_id"] == "enhancement-default")
        sid = old.get("session_id")
        if sid:
            existing = remote.json("GET", "/api/sessions/" + sid)
            if existing.get("jobs"):
                raise ValueError("Smoke session has jobs; refusing mutation")
        else:
            response = remote.json(
                "POST",
                "/api/sessions",
                {
                    "mode": "experimental",
                    "model_id": model["profile_id"],
                    "builtin_skills": "coding_to_video",
                },
            )
            sid = response["session"]["id"]
            report["session_id"] = sid
            atomic(report_path, report)
        report["session_id"] = sid
        receipts = []
        for aid in case["input_assets"]:
            a = assets[aid]
            path = (args.data_root / a["path"]).resolve()
            assert hashlib.sha256(path.read_bytes()).hexdigest() == a["sha256"]
            note = "C2V input sha256:" + a["sha256"]
            manifest = remote.json("GET", f"/api/sessions/{sid}/references")
            matches = [x for x in manifest.get("items", []) if x.get("note") == note]
            receipt = (
                {"item": matches[0]} if matches else remote.upload(sid, path, note)
            )
            receipts.append(
                {"asset_id": aid, "sha256": a["sha256"], "item": receipt.get("item")}
            )
        final = remote.json("GET", f"/api/sessions/{sid}/references")
        session = remote.json("GET", "/api/sessions/" + sid)
        report.update(
            uploaded_input_count=len(receipts),
            remote_reference_count=len(final.get("items", [])),
            references_frozen=final.get("frozen"),
            job_count=len(session.get("jobs", [])),
            uploads=receipts,
        )
        assert report["remote_reference_count"] == 3 and report["job_count"] == 0
    atomic(report_path, report)
    print(
        json.dumps(
            {k: v for k, v in report.items() if k != "uploads"}, ensure_ascii=False
        )
    )


if __name__ == "__main__":
    main()
