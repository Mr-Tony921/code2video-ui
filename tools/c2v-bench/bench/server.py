#!/usr/bin/env python3
"""Loopback-only C2V benchmark workbench; all generation stays in dev Web's CC harness."""
import argparse, concurrent.futures, csv, http.cookies, io, json, mimetypes, secrets, subprocess, threading, urllib.parse, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from core import Store, TERMINAL, digest, digest_file, evaluation, now, summary
from remote import Remote, RemoteError
from local_media import cached_original, download_original, probe_original


class App:
    def __init__(self, root, base, store=None, suite_version="0.1.0"):
        self.root = Path(root).resolve()
        self.base = base.rstrip("/")
        self.store = store or Store(self.root / "runtime/runs")
        import re

        if not re.fullmatch(r"0\.\d+\.\d+", suite_version):
            raise ValueError("suite-version must be 0.x.x")
        version_root = self.root / "dataset" / ("v" + suite_version)
        self.suite = json.loads((version_root / "suite.json").read_text())
        self.baselines = json.loads((version_root / "baselines.json").read_text())
        self.assets = {a["id"]: a for a in self.suite["assets"]}
        self.clients = {}
        self.csrf = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.busy = set()
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=4)
        self.stop = threading.Event()

    def path(self, relative):
        p = (self.root / relative).resolve()
        if self.root not in p.parents:
            raise PermissionError("Asset outside dataset root")
        return p

    def owner(self, user):
        return self.base + "|" + str(user["id"])

    def input_assets(self, r):
        return {a["id"]: a for a in r.get("input_assets_snapshot", [])} or self.assets

    def check_inputs(self, r):
        for aid in r["case"]["input_assets"]:
            a = self.input_assets(r)[aid]
            p = self.path(a["path"])
            if not p.is_file() or digest(p.read_bytes()) != a["sha256"]:
                raise ValueError("输入素材缺失或 hash 不匹配：" + a["name"])

    def task(self, rid, client, fn):
        self.store.get(rid, client["owner"])
        with self.lock:
            if rid in self.busy:
                return
            self.busy.add(rid)

        def work():
            try:
                fn(rid, client)
            except Exception as e:
                # Keep pending state (especially uncertain creation/upload); never blindly resubmit.
                self.store.update(rid, client["owner"], last_error=str(e)[:500])
                self.store.event(
                    rid,
                    client["owner"],
                    "operation_error",
                    operation=fn.__name__,
                    error=str(e)[:500],
                )
            finally:
                with self.lock:
                    self.busy.discard(rid)

        self.pool.submit(work)

    def submit(self, rid, c):
        owner = c["owner"]
        remote = c["remote"]
        r = self.store.get(rid, owner)
        if r.get("job_id"):
            return
        self.check_inputs(r)
        if r["state"] == "CREATING_SESSION":
            raise ValueError(
                "创建会话回执不确定，请在 dev 历史确认 session ID 后绑定；不会自动创建第二个会话。"
            )
        if not r["session_id"]:
            models = remote.json("GET", "/api/experimental/models")["models"]
            m = next(
                (
                    m
                    for m in models
                    if m["profile_id"] == r["model_requested"]["profile_id"]
                ),
                None,
            )
            if m != r["model_requested"]:
                raise ValueError("模型配置已变化，请新建计划冻结当前配置。")
            self.store.update(rid, owner, state="CREATING_SESSION", last_error=None)
            result = remote.json(
                "POST",
                "/api/sessions",
                {
                    "mode": "experimental",
                    "model_id": m["profile_id"],
                    "builtin_skills": "coding_to_video",
                },
            )
            sid = result["session"]["id"]
            r = self.store.update(
                rid, owner, session_id=sid, state="UPLOADING", session_receipt=result
            )
            self.store.event(rid, owner, "session_created", session_id=sid)
        sid = r["session_id"]
        for aid in r["case"]["input_assets"]:
            r = self.store.get(rid, owner)
            if any(u["asset_id"] == aid for u in r["uploads"]):
                continue
            a = self.input_assets(r)[aid]
            note = "C2V input sha256:" + a["sha256"]
            # An interrupted upload is reconciled by its stable content note before retry.
            manifest = remote.json("GET", f"/api/sessions/{sid}/references")
            matching = [x for x in manifest.get("items", []) if x.get("note") == note]
            if len(matching) > 1:
                raise ValueError("发现重复输入附件，请在 dev 会话确认后再提交。")
            if matching:
                receipt = {"item": matching[0], "reconciled": True}
            elif r.get("upload_pending") == aid:
                raise ValueError(
                    "上传回执不确定且未查到素材。请人工确认，不能自动重复上传。"
                )
            else:
                self.store.update(rid, owner, state="UPLOADING", upload_pending=aid)
                receipt = remote.upload(sid, self.path(a["path"]), note)
            r = self.store.get(rid, owner)
            self.store.update(
                rid,
                owner,
                uploads=r["uploads"]
                + [{"asset_id": aid, "sha256": a["sha256"], "receipt": receipt}],
                upload_pending=None,
            )
        self.store.update(rid, owner, state="SUBMITTING", last_error=None)
        remote.json(
            "POST", f"/api/sessions/{sid}/presence", {"tab_id": "c2v-bench-" + rid}
        )
        response = remote.json(
            "POST",
            f"/api/sessions/{sid}/jobs",
            {
                "prompt": r["case"]["prompt_submitted"],
                "enhance": False,
                "is_revision": False,
                "experimental_skills": r["skill_requested"],
            },
            headers={"Idempotency-Key": r["idempotency_key"]},
        )
        job = response["job"]
        self.store.update(
            rid,
            owner,
            job_id=job["id"],
            job=job,
            state=job["status"],
            submitted_at=now(),
        )
        self.store.event(
            rid,
            owner,
            "job_accepted",
            job_id=job["id"],
            idempotent_replay=response.get("idempotent_replay", False),
        )

    def refresh(self, rid, c):
        r = self.store.get(rid, c["owner"])
        if not r.get("job_id"):
            return
        if (r.get("job") or {}).get("status") not in TERMINAL:
            c["remote"].json(
                "POST",
                f'/api/sessions/{r["session_id"]}/presence',
                {"tab_id": "c2v-bench-" + rid},
            )
        j = c["remote"].json("GET", "/api/jobs/" + r["job_id"])["job"]
        if j["session_id"] != r["session_id"]:
            raise ValueError("Job/session 不一致")
        if j["status"] != (r.get("job") or {}).get("status"):
            self.store.event(rid, c["owner"], "job_status", status=j["status"])
        self.store.update(
            rid,
            c["owner"],
            job=j,
            state=j["status"],
            last_checked_at=now(),
            last_error=None,
        )

    def bind(self, rid, c, sid):
        r = self.store.get(rid, c["owner"])
        if r["state"] != "CREATING_SESSION" or r.get("session_id"):
            raise ValueError("只有创建回执不确定的计划可绑定")
        if not sid.startswith("sess_"):
            raise ValueError("Invalid session")
        uuid.UUID(sid[5:])
        res = c["remote"].json("GET", "/api/sessions/" + sid)
        s = res["session"]
        if (
            s.get("mode") != "experimental"
            or res.get("jobs")
            or (s.get("model_selection") or {}).get("revision")
            != r["model_requested"].get("revision")
        ):
            raise ValueError("会话不是匹配模型的空实验会话")
        self.store.update(
            rid, c["owner"], session_id=sid, state="UPLOADING", last_error=None
        )
        self.store.event(rid, c["owner"], "manual_session_bind", session_id=sid)

    def probe(self, rid, c):
        dest = download_original(self.root, self.store, rid, c["owner"], c["remote"])
        p = probe_original(dest)
        self.store.update(rid, c["owner"], probe=p, last_error=None)
        self.store.event(rid, c["owner"], "original_probed", decode_ok=p["decode_ok"])

    def record(self, run):
        return {**run, "evaluation": evaluation(run),
                "local_original_available": cached_original(self.root, run) is not None}

    def poll(self):
        while not self.stop.wait(30):
            with self.lock:
                clients = list(self.clients.values())
            owners = set()
            for c in clients:
                if c["owner"] in owners:
                    continue
                owners.add(c["owner"])
                for r in self.store.list(c["owner"]):
                    if (
                        r.get("job_id")
                        and (r.get("job") or {}).get("status") not in TERMINAL
                    ):
                        self.task(r["id"], c, self.refresh)

    def remote_reference(self, key):
        m = self.root / "source/remote-references/manifest.json"
        if not m.exists():
            raise FileNotFoundError("外链未缓存")
        item = json.loads(m.read_text()).get(key, {})
        if item.get("fetch_status") != "downloaded":
            raise FileNotFoundError("外链未缓存")
        return self.path(item["path"])


class Handler(BaseHTTPRequestHandler):
    server_version = "C2VBench/0.1.2"

    def log_message(self, *args):
        pass  # Request URLs, credentials and cookies do not enter logs.

    @property
    def app(self):
        return self.server.app

    def json(self, obj, status=200, headers=None):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def client(self):
        jar = http.cookies.SimpleCookie(self.headers.get("Cookie", ""))
        token = jar.get("bench_session")
        c = self.app.clients.get(token.value if token else "")
        if not c:
            raise PermissionError("请先登录 dev 普通账号")
        return c

    def safety(self, write=False):
        host = self.headers.get("Host", "")
        expected = {
            "127.0.0.1:" + str(self.server.server_port),
            "localhost:" + str(self.server.server_port),
        }
        if host not in expected:
            raise PermissionError("仅允许本机访问")
        if write:
            if self.headers.get("X-Bench-Token") != self.app.csrf:
                raise PermissionError("CSRF token 无效")
            if self.headers.get("Origin") and self.headers["Origin"] not in {
                "http://" + h for h in expected
            }:
                raise PermissionError("Origin 无效")

    def do_GET(self):
        self.route(False)

    def do_POST(self):
        self.route(True)

    def route(self, write):
        try:
            self.safety(write)
            u = urllib.parse.urlsplit(self.path)
            p = u.path
            q = urllib.parse.parse_qs(u.query)
            if write:
                n = int(self.headers.get("Content-Length", "0"))
                if n > 128 * 1024:
                    raise ValueError("Request too large")
                b = json.loads(self.rfile.read(n) or b"{}")
                return self.post(p, b)
            if p == "/api/bootstrap":
                try:
                    user = self.client()["user"]
                except PermissionError:
                    user = None
                return self.json(
                    {
                        "csrf": self.app.csrf,
                        "suite": self.app.suite,
                        "baselines": self.app.baselines,
                        "user": user,
                        "dev_url": self.app.base,
                    }
                )
            if p == "/api/catalog":
                return self.json(
                    {
                        "models": self.client()["remote"].json(
                            "GET", "/api/experimental/models"
                        )["models"],
                        "skills": self.client()["remote"].json(
                            "GET", "/api/experimental/skills"
                        )["skills"],
                    }
                )
            if p in ["/api/runs", "/api/export"]:
                c = self.client()
                runs = self.app.store.list(c["owner"])
                data = {
                    "runs": [self.app.record(r) for r in runs],
                    "summary": summary(runs),
                    "exported_at": now(),
                }
                return self.json(
                    data,
                    headers=(
                        {
                            "Content-Disposition": 'attachment; filename="c2v-benchmark-results.json"'
                        }
                        if p == "/api/export"
                        else None
                    ),
                )
            if p == "/api/export.csv":
                runs = self.app.store.list(self.client()["owner"])
                buf = io.StringIO()
                cols = [
                    "run_id",
                    "cohort",
                    "case_id",
                    "model",
                    "model_revision",
                    "skill_policy",
                    "state",
                    "has_video",
                    "render_verified",
                    "hard_pass",
                    "quality",
                    "queue_seconds",
                    "execution_seconds",
                    "total_seconds",
                ]
                w = csv.DictWriter(buf, fieldnames=cols)
                w.writeheader()
                for r in runs:
                    e = evaluation(r)
                    m = (r.get("job") or {}).get("model_selection") or r[
                        "model_requested"
                    ]
                    row = {k: e.get(k) for k in cols}
                    row.update(
                        run_id=r["id"],
                        cohort=r["cohort"],
                        case_id=r["case"]["id"],
                        model=m.get("model"),
                        model_revision=m.get("revision"),
                        skill_policy=r["case"]["skill_policy"],
                        state=r["state"],
                    )
                    w.writerow(
                        {
                            k: (
                                "'" + v if isinstance(v, str) and v[:1] in "=+-@" else v
                            )
                            for k, v in row.items()
                        }
                    )
                return self.raw(
                    ("\ufeff" + buf.getvalue()).encode(),
                    "text/csv; charset=utf-8",
                    "c2v-benchmark-results.csv",
                )
            if p.startswith("/media/"):
                aid = p[7:]
                a = self.app.assets.get(aid)
                if not a:
                    raise FileNotFoundError()
                return self.file(self.app.path(a["path"]))
            if p == "/reference":
                return self.file(self.app.remote_reference(q.get("url", [""])[0]))
            if p.startswith("/showcase/"):
                sid = p.split("/")[-1]
                s = next(s for s in self.app.baselines["showcases"] if s["id"] == sid)
                root = self.server.showcase_root
                if not root:
                    raise FileNotFoundError("当前机器未挂载历史 showcase")
                return self.file(root / ("experimental-" + s["id"] + ".mp4"))
            if p.startswith("/api/run/"):
                parts = p.split("/")
                rid = parts[3]
                kind = parts[4]
                c = self.client()
                r = self.app.store.get(rid, c["owner"])
                if kind not in ["media", "download", "archive"] or not r.get("job_id"):
                    raise ValueError("无可用产物")
                local = cached_original(self.app.root, r)
                if local and kind in ["media", "download"]:
                    return self.file(local, download_name=(local.parent.parent.name + "__" + r["case"]["id"] + "__" + rid[4:12] + ".mp4") if kind == "download" else None)
                path = (
                    f'/api/sessions/{r["session_id"]}/archive'
                    if kind == "archive"
                    else f'/api/assets/{r["job_id"]}/'
                    + ("playback" if kind == "media" else "download")
                )
                headers = (
                    {"Range": self.headers["Range"]}
                    if self.headers.get("Range")
                    else {}
                )
                with c["remote"].open(
                    "GET", path, headers=headers, timeout=120
                ) as response:
                    self.send_response(response.status)
                    for k in [
                        "Content-Type",
                        "Content-Length",
                        "Content-Range",
                        "Accept-Ranges",
                        "Content-Disposition",
                    ]:
                        if response.headers.get(k):
                            self.send_header(k, response.headers[k])
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    while chunk := response.read(128 * 1024):
                        self.wfile.write(chunk)
                return
            if p in ["/", "/app.js", "/style.css"]:
                return self.file(
                    Path(__file__).parent
                    / "web"
                    / ("index.html" if p == "/" else p[1:])
                )
            raise FileNotFoundError()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            status = (
                403
                if isinstance(e, PermissionError)
                else (
                    404
                    if isinstance(e, (FileNotFoundError, StopIteration))
                    else e.status if isinstance(e, RemoteError) else 400
                )
            )
            self.json({"error": str(e) or "未找到资源"}, status)

    def post(self, p, b):
        if p == "/api/login":
            remote = Remote(self.app.base)
            user = remote.login(b.get("username", ""), b.get("password", ""))
            if user.get("role") == "admin":
                raise PermissionError("请使用普通测试账号")
            if not user.get("can_use_experimental"):
                raise PermissionError("账号未开通实验模式")
            token = secrets.token_urlsafe(32)
            c = {"user": user, "owner": self.app.owner(user), "remote": remote}
            with self.app.lock:
                old = http.cookies.SimpleCookie(self.headers.get("Cookie", "")).get(
                    "bench_session"
                )
                if old:
                    self.app.clients.pop(old.value, None)
                self.app.clients[token] = c
            return self.json(
                {"user": user},
                headers={
                    "Set-Cookie": f"bench_session={token}; HttpOnly; SameSite=Strict; Path=/"
                },
            )
        c = self.client()
        if p == "/api/logout":
            jar = http.cookies.SimpleCookie(self.headers.get("Cookie", ""))
            with self.app.lock:
                self.app.clients.pop(jar["bench_session"].value, None)
            return self.json(
                {"ok": True},
                headers={
                    "Set-Cookie": "bench_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
                },
            )
        if p == "/api/plan":
            models = c["remote"].json("GET", "/api/experimental/models")["models"]
            m = next(x for x in models if x["profile_id"] == b["model_id"])
            r = self.app.store.plan(
                self.app.suite,
                b["case_id"],
                m,
                c["owner"],
                self.app.base,
                b.get("cohort"),
            )
            self.app.check_inputs(r)
            return self.json(r, 201)
        if p.startswith("/api/run/"):
            _, _, _, rid, action = p.split("/")
            r = self.app.store.get(rid, c["owner"])
            if action in ["submit", "refresh", "probe"]:
                self.app.task(rid, c, getattr(self.app, action))
                return self.json({"accepted": True}, 202)
            if action == "bind":
                self.app.bind(rid, c, b["session_id"])
                return self.json({"ok": True})
            if action == "review":
                if (
                    not r.get("job_id")
                    or (r.get("job") or {}).get("status") not in TERMINAL
                ):
                    raise ValueError("等待任务结束后评价")
                if b.get("quality") not in [
                    "pass",
                    "partial",
                    "fail",
                    "unreviewed",
                ] or b.get("hard_instructions") not in ["pass", "fail", "unreviewed"]:
                    raise ValueError("Invalid verdict")
                note = str(b.get("note", "")).strip()
                evidence = str(b.get("evidence", "")).strip()
                if (
                    b["quality"] != "unreviewed"
                    or b["hard_instructions"] != "unreviewed"
                ):
                    if not note or not evidence:
                        raise ValueError("请记录判断依据及具体时间点/证据")
                review = {k: b[k] for k in ["quality", "hard_instructions"]}
                review.update(
                    note=note[:10000],
                    evidence=evidence[:10000],
                    reviewer=c["user"]["username"],
                    at=now(),
                )
                with self.app.store.lock:
                    r = self.app.store.get(rid, c["owner"])
                    self.app.store.update(
                        rid, c["owner"], reviews=r["reviews"] + [review]
                    )
                return self.json(review)
        raise FileNotFoundError()

    def raw(self, data, mime, name=None):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        if name:
            self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.end_headers()
        self.wfile.write(data)

    def file(self, p, download_name=None):
        size = p.stat().st_size
        start = 0
        end = size - 1
        status = 200
        if self.headers.get("Range"):
            import re

            m = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers["Range"])
            if not m or not (m[1] or m[2]):
                raise ValueError("Invalid Range")
            if m[1]:
                start = int(m[1])
                end = min(int(m[2]), end) if m[2] else end
            else:
                start = max(0, size - int(m[2]))
            if start > end or start >= size:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header(
            "Content-Type",
            mimetypes.guess_type(str(p))[0] or "application/octet-stream",
        )
        if download_name:
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + urllib.parse.quote(download_name, safe=""))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-cache")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with p.open("rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining:
                chunk = f.read(min(128 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--data-root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    parser.add_argument("--dev-url", default="http://10.210.9.14:20211")
    parser.add_argument("--port", type=int, default=18942)
    parser.add_argument("--showcase-root", type=Path)
    parser.add_argument("--suite-version", default="0.1.2")
    args = parser.parse_args()
    parsed = urllib.parse.urlsplit(args.dev_url)
    if (
        parsed.scheme not in ["http", "https"]
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.path not in ["", "/"]
    ):
        parser.error("dev-url 必须为固定 HTTP(S) 服务地址")
    app = App(args.data_root, args.dev_url, suite_version=args.suite_version)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.app = app
    server.showcase_root = args.showcase_root
    threading.Thread(target=app.poll, daemon=True).start()
    print(f"C2V benchmark: http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.stop.set()
        server.server_close()
        app.pool.shutdown(wait=False)


if __name__ == "__main__":
    main()
