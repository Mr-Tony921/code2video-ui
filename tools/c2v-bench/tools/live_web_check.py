#!/usr/bin/env python3
"""Check the complete local Web adapter against dev, without submitting inference jobs."""
import argparse, http.cookiejar, json, sys, threading, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bench"))
from core import Store, atomic, now
from server import App, Handler, ThreadingHTTPServer


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--data-root", required=True, type=Path)
    p.add_argument("--account-file", required=True, type=Path)
    p.add_argument("--dev-url", default="http://10.210.9.14:20211")
    args = p.parse_args()
    account = json.loads(args.account_file.read_text())
    assert account["username"] in ["test", "test-peer"]
    folder = args.data_root / "runtime/validation/web-adapter"
    app = App(args.data_root, args.dev_url, Store(folder / "runs"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.app = app
    server.showcase_root = None
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )

    def request(path, data=None, csrf=None):
        headers = {"Content-Type": "application/json"}
        if csrf:
            headers["X-Bench-Token"] = csrf
        req = urllib.request.Request(
            base + path,
            data=None if data is None else json.dumps(data).encode(),
            headers=headers,
        )
        with opener.open(req, timeout=120) as r:
            return json.load(r)

    try:
        csrf = request("/api/bootstrap")["csrf"]
        u = request("/api/login", account, csrf)
        del account
        cat = request("/api/catalog")
        profile = cat["models"][0]["profile_id"]
        run = request(
            "/api/plan",
            {
                "case_id": "01-mindflow",
                "model_id": profile,
                "cohort": "api-only-validation-no-generation",
            },
            csrf,
        )
        assert len(request("/api/runs")["runs"]) >= 1 and run["session_id"] is None
        blocked = False
        try:
            request(
                "/api/plan",
                {
                    "case_id": "03-hush-buds",
                    "model_id": profile,
                    "cohort": "api-only-validation-no-generation",
                },
                csrf,
            )
        except urllib.error.HTTPError as e:
            blocked = e.code == 400
        assert blocked
        exported = request("/api/export")
        assert all(r["job_id"] is None for r in exported["runs"])
        request("/api/logout", {}, csrf)
        try:
            request("/api/runs")
            raise AssertionError("Logout did not revoke access")
        except urllib.error.HTTPError as e:
            assert e.code == 403
        report = {
            "checked_at": now(),
            "ordinary_user": u["user"]["username"],
            "model_count": len(cat["models"]),
            "plan_created": run["id"],
            "missing_input_blocked": blocked,
            "export_ok": True,
            "logout_revoked_access": True,
            "generation_submitted": False,
        }
        atomic(folder / "result.json", report)
        print(json.dumps(report, ensure_ascii=False))
    finally:
        server.shutdown()
        server.server_close()
        app.stop.set()
        app.pool.shutdown(wait=True)


if __name__ == "__main__":
    main()
