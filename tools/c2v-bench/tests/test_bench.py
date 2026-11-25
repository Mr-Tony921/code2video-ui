import base64, copy, hashlib, http.client, io, json, shutil, subprocess, sys, tempfile, threading, unittest, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bench"))
from core import Store, evaluation, summary
from gate import evaluate_gate, adapt_prompt
from server import App, Handler, ThreadingHTTPServer
from local_media import original_path, cached_original, download_original
from core import digest_file

class MediaResponse(io.BytesIO):
    def __init__(self, data, status=200, headers=None):
        super().__init__(data)
        self.status = status
        self.headers = headers or {}


class Fake:
    def __init__(self):
        self.sessions = 0
        self.jobs = 0
        self.uploads = 0
        self.entries = []
        self.body = None
        self.lose_job = False
        self.lose_session = False

    def json(self, method, path, data=None, headers=None):
        if path == "/api/experimental/models":
            return {"models": [MODEL]}
        if path == "/api/sessions":
            self.sessions += 1
            if self.lose_session:
                raise TimeoutError("response lost")
            return {"session": {"id": "sess_" + str(uuid.UUID(int=1))}}
        if path.endswith("/references"):
            return {"items": self.entries}
        if path.endswith("/presence"):
            return {"ok": True}
        if path.endswith("/jobs"):
            if self.body is None:
                self.jobs += 1
                self.body = data
                self.key = headers["Idempotency-Key"]
            assert headers["Idempotency-Key"] == self.key
            if self.lose_job:
                self.lose_job = False
                raise TimeoutError("response lost")
            return {
                "job": {
                    "id": "job_" + str(uuid.UUID(int=2)),
                    "session_id": "sess_" + str(uuid.UUID(int=1)),
                    "status": "QUEUED",
                }
            }
        raise AssertionError(path)

    def upload(self, sid, path, note):
        self.uploads += 1
        item = {"name": path.name, "note": note}
        self.entries.append(item)
        return {"item": item}


MODEL = {"profile_id": "test-model", "model": "test-model", "revision": "r1"}


class BenchTests(unittest.TestCase):
    def setUp(self):
        (ROOT / "runtime").mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=ROOT / "runtime")
        fixture = Path(self.tmp.name)
        self.store = Store(fixture / "runs")
        suite = json.loads((ROOT / "dataset/v0.1.0/suite.json").read_text())
        dest = fixture / "dataset/v0.1.0"
        dest.mkdir(parents=True)
        png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVfcAAAAASUVORK5CYII="
        )
        for i, a in enumerate(suite["assets"]):
            payload = png + str(i).encode()
            a["path"] = "fixtures/" + str(i) + ".png"
            a["sha256"] = hashlib.sha256(payload).hexdigest()
            a["bytes"] = len(payload)
            file = fixture / a["path"]
            file.parent.mkdir(exist_ok=True)
            file.write_bytes(payload)
        (dest / "suite.json").write_text(json.dumps(suite))
        (dest / "baselines.json").write_bytes(
            (ROOT / "dataset/v0.1.0/baselines.json").read_bytes()
        )
        self.app = App(fixture, "http://example.test", self.store)
        self.remote = Fake()
        self.c = {
            "owner": "http://example.test|test",
            "user": {"id": "test", "username": "test"},
            "remote": self.remote,
        }

    def tearDown(self):
        self.app.pool.shutdown(wait=True)
        self.tmp.cleanup()

    def plan(self, case="01-mindflow"):
        return self.store.plan(
            self.app.suite, case, MODEL, self.c["owner"], self.app.base, "unit-test"
        )

    def test_case_catalog(self):
        s = self.app.suite
        self.assertEqual(len(s["cases"]), 19)
        self.assertEqual(sum(c["status"] == "ready" for c in s["cases"]), 15)
        self.assertEqual(
            [c["id"] for c in s["cases"] if c["skill_policy"] == "c2v-anatomy-v1"],
            ["08-microwave", "09-reel-projector"],
        )
        self.assertEqual(sum(len(c["input_assets"]) for c in s["cases"]), 4)
        for c in s["cases"]:
            self.assertEqual(
                c["prompt_submitted"],
                adapt_prompt(c["category"], c["prompt_original"], evaluate_gate(c["gate_intake"]))[0],
            )
            for o in c["reference_outputs"]:
                self.assertIsNone(o["model"])

    def test_reference_cell_correction(self):
        cases={c["id"]:c for c in self.app.suite["cases"]}
        self.assertEqual(cases["06-protein-age"]["reference_outputs"],[])
        self.assertEqual(len(cases["07-sleep-age"]["reference_outputs"]),1)
        self.assertEqual(cases["07-sleep-age"]["reference_outputs"][0]["use"],"reference_not_gold")

    def test_gate_uses_target_and_does_not_guess_unknown_tasks(self):
        intake={"explanation_target":"physical_mechanism", "subject_defined":True, "needs_parts_relationships":True, "requires_3d":False,"engineering_precision_required":False,"missing_required_inputs":[],"source_evidence":{"excerpt":"拆开自行车变速器，解释齿轮啮合关系"}}
        self.assertEqual(evaluate_gate(intake)["status"],"suitable")
        intake["requires_3d"]=True
        self.assertIn("三维",evaluate_gate(intake)["adaptations"][-1])
        intake["explanation_target"]="scene_or_system"
        self.assertEqual(evaluate_gate(intake)["status"],"unsuitable")
        intake["explanation_target"]="physical_mechanism";intake["engineering_precision_required"]=True
        self.assertEqual(evaluate_gate(intake)["status"],"needs_review")
        self.assertEqual(evaluate_gate(None)["status"],"needs_review")
        intake["engineering_precision_required"]=False;intake["missing_required_inputs"]=["指定CAD未提供"]
        self.assertEqual(evaluate_gate(intake)["status"],"needs_review")

    def test_unsuitable_task_cannot_mount_anatomy(self):
        suite=copy.deepcopy(self.app.suite);suite["cases"][0]["skill_policy"]="c2v-anatomy-v1"
        with self.assertRaises(ValueError):self.store.plan(suite,"01-mindflow",MODEL,self.c["owner"],self.app.base,"gate-test")

    def test_blocked_inputs(self):
        for cid in [
            "02-manus-template",
            "03-hush-buds",
            "04-paper-template",
            "13-sitcom-template",
        ]:
            with self.assertRaises(ValueError):
                self.plan(cid)
        self.assertEqual(self.remote.sessions, 0)

    def test_submit_only_inputs_and_idempotent(self):
        r = self.plan()
        self.app.submit(r["id"], self.c)
        self.app.submit(r["id"], self.c)
        self.assertEqual(
            (self.remote.sessions, self.remote.uploads, self.remote.jobs), (1, 3, 1)
        )
        self.assertEqual(self.remote.body["prompt"], r["case"]["prompt_submitted"])
        self.assertFalse(self.remote.body["enhance"])

    def test_job_timeout_reuses_key_and_attachments(self):
        r = self.plan()
        self.remote.lose_job = True
        with self.assertRaises(TimeoutError):
            self.app.submit(r["id"], self.c)
        self.app.submit(r["id"], self.c)
        self.assertEqual(
            (self.remote.sessions, self.remote.uploads, self.remote.jobs), (1, 3, 1)
        )

    def test_uncertain_session_not_recreated(self):
        r = self.plan()
        self.remote.lose_session = True
        with self.assertRaises(TimeoutError):
            self.app.submit(r["id"], self.c)
        with self.assertRaises(ValueError):
            self.app.submit(r["id"], self.c)
        self.assertEqual(self.remote.sessions, 1)

    def test_owner_isolation(self):
        r = self.plan()
        with self.assertRaises(PermissionError):
            self.store.get(r["id"], "other-user")
        self.assertEqual(self.store.list("other-user"), [])

    def test_render_not_equal_quality(self):
        r = self.plan()
        r["job"] = {"status": "COMPLETED", "result_asset": {"playable": True}}
        e = evaluation(r)
        self.assertTrue(e["has_video"])
        self.assertIsNone(e["render_verified"])
        self.assertIsNone(e["hard_pass"])
        self.assertEqual(e["quality"], "unreviewed")
        r["probe"] = {
            "decode_ok": True,
            "duration_seconds": 20,
            "fps": 30,
            "width": 1920,
            "height": 1080,
        }
        self.assertIsNone(evaluation(r)["hard_pass"])
        r["reviews"] = [{"hard_instructions": "pass", "quality": "partial"}]
        self.assertTrue(evaluation(r)["hard_pass"])
        r["probe"]["duration_seconds"] = 15
        self.assertFalse(evaluation(r)["hard_pass"])

    def test_group_versions_and_missing_times(self):
        a = self.plan()
        b = copy.deepcopy(a)
        b["model_requested"]["revision"] = "r2"
        groups = summary([a, b])
        self.assertEqual(len(groups), 2)
        self.assertIsNone(groups[0]["median_execution_seconds"])

    def test_cli_and_server_writes_share_process_lock(self):
        r=self.plan();self.store.update(r['id'],r['owner'],counter=0)
        code="""import sys,time
sys.path.insert(0,sys.argv[1])
from core import Store
s=Store(sys.argv[2])
for _ in range(20):
 with s.lock:
  r=s.get(sys.argv[3]);time.sleep(.001);s.update(r['id'],r['owner'],counter=r['counter']+1)
"""
        ps=[subprocess.Popen([sys.executable,'-c',code,str(ROOT/'bench'),str(self.store.root),r['id']]) for _ in range(2)]
        for proc in ps:self.assertEqual(proc.wait(timeout=60),0)
        self.assertEqual(self.store.get(r['id'])['counter'],40)

    def test_path_traversal(self):
        with self.assertRaises(PermissionError):
            self.app.path("../outside")

    @unittest.skipUnless(
        shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg required"
    )
    def test_probe_complete_and_broken_video(self):
        r = self.plan()
        self.store.update(
            r["id"],
            self.c["owner"],
            job_id="job_" + str(uuid.UUID(int=2)),
            job={"status": "COMPLETED", "result_asset": {"playable": True}},
        )
        fixture = Path(self.tmp.name) / "fixture.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=navy:s=64x64:r=10:d=0.3",
                "-an",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                str(fixture),
            ],
            check=True,
        )
        self.store.update(r["id"], self.c["owner"], job={"status": "COMPLETED", "result_asset": {"playable": True, "size_bytes": fixture.stat().st_size}})
        self.remote.open = lambda *args, **kwargs: MediaResponse(fixture.read_bytes())
        self.app.probe(r["id"], self.c)
        checked = self.store.get(r["id"], self.c["owner"])
        self.assertTrue(checked["probe"]["decode_ok"])
        self.assertFalse(evaluation(checked)["duration_ok"])
        bad = self.plan()
        self.store.update(
            bad["id"],
            self.c["owner"],
            job_id="job_" + str(uuid.UUID(int=3)),
            job={"status": "COMPLETED", "result_asset": {"playable": True}},
        )
        invalid = b"\x00\x00\x00\x18ftypisom" + b"invalid video" * 20
        self.store.update(bad["id"], self.c["owner"], job={"status": "COMPLETED", "result_asset": {"playable": True, "size_bytes": len(invalid)}})
        self.remote.open = lambda *args, **kwargs: MediaResponse(invalid)
        self.app.probe(bad["id"], self.c)
        self.assertFalse(self.store.get(bad["id"])["probe"]["decode_ok"])

    def test_terminal_without_video_fails_hard_delivery(self):
        r = self.plan()
        r["job"] = {"status": "FAILED", "result_asset": None}
        self.assertFalse(evaluation(r)["hard_pass"])
        self.assertIsNone(evaluation(r)["render_verified"])

    def test_http_csrf_range_and_owner(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        server.app = self.app
        server.showcase_root = None
        t = threading.Thread(target=server.serve_forever, daemon=True)
        t.start()
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port)
        try:
            conn.request("GET", "/api/bootstrap")
            res = conn.getresponse()
            self.assertEqual(res.status, 200)
            data = json.loads(res.read())
            self.assertIn("csrf", data)
            conn.request(
                "POST",
                "/api/plan",
                body="{}",
                headers={"Content-Type": "application/json"},
            )
            res = conn.getresponse()
            self.assertEqual(res.status, 403)
            res.read()
            aid = self.app.suite["cases"][0]["input_assets"][0]
            conn.request("GET", "/media/" + aid, headers={"Range": "bytes=0-9"})
            res = conn.getresponse()
            self.assertEqual(res.status, 206)
            self.assertEqual(len(res.read()), 10)
            conn.request("GET", "/api/runs")
            res = conn.getresponse()
            self.assertEqual(res.status, 403)
            res.read()
            conn.request("GET", "/api/bootstrap", headers={"Host": "evil.test"})
            res = conn.getresponse()
            self.assertEqual(res.status, 403)
            res.read()
        finally:
            conn.close()
            server.shutdown()
            server.server_close()

    def local_fixture(self):
        r = self.plan()
        blob = b"0000ftypisom" + b"x" * 200
        r = self.store.update(r["id"], self.c["owner"], job_id="job_" + str(uuid.UUID(int=12)),
            job={"status": "COMPLETED", "result_asset": {"playable": True, "size_bytes": len(blob)}})
        return r, blob

    def test_original_resume_and_reuse_without_remote_call(self):
        r, blob = self.local_fixture()
        dest = original_path(self.app.root, r)
        dest.parent.mkdir(parents=True)
        dest.with_suffix('.part').write_bytes(blob[:20])
        def resume(method, path, headers, timeout):
            self.assertEqual(headers['Range'], 'bytes=20-')
            self.assertEqual(path, '/api/assets/' + r['job_id'] + '/download')
            return MediaResponse(blob[20:], 206, {'Content-Range': 'bytes 20-%d/%d' % (len(blob)-1,len(blob))})
        self.remote.open = resume
        self.assertEqual(download_original(self.app.root,self.store,r['id'],r['owner'],self.remote),dest)
        self.assertEqual(dest.read_bytes(),blob)
        self.remote.open = lambda *a,**kw: self.fail('verified original must not be downloaded again')
        self.assertIsNone(evaluation(self.store.get(r['id']))['render_verified'])
        self.assertEqual(download_original(self.app.root,self.store,r['id'],r['owner'],self.remote),dest)

    def test_ignored_range_restarts_and_truncated_download_is_not_published(self):
        r, blob = self.local_fixture()
        dest=original_path(self.app.root,r)
        dest.parent.mkdir(parents=True)
        dest.with_suffix('.part').write_bytes(blob[:20])
        self.remote.open=lambda *a,**kw: MediaResponse(blob)
        download_original(self.app.root,self.store,r['id'],r['owner'],self.remote)
        self.assertEqual(dest.read_bytes(),blob)
        r2,_=self.local_fixture()
        self.remote.open=lambda *a,**kw: MediaResponse(blob[:40])
        with self.assertRaisesRegex(ValueError,'不完整'):
            download_original(self.app.root,self.store,r2['id'],r2['owner'],self.remote,attempts=1)
        self.assertIsNone(cached_original(self.app.root,self.store.get(r2['id'])))
        self.assertFalse(original_path(self.app.root,r2).exists())

    def test_download_does_not_wait_for_proxy_bytes_beyond_known_original(self):
        r,blob=self.local_fixture()
        class ExactEndResponse(MediaResponse):
            def read(self,n=-1):
                if n < 0 or n > len(blob)-self.tell():
                    raise http.client.IncompleteRead(b"",1)
                return super().read(n)
        self.remote.open=lambda *a,**kw: ExactEndResponse(blob)
        dest=download_original(self.app.root,self.store,r['id'],r['owner'],self.remote,attempts=1)
        self.assertEqual(dest.read_bytes(),blob)

    def test_parallel_ranges_reassemble_original_and_resume_prefix(self):
        r, _ = self.local_fixture()
        blob = b"0000ftypisom" + bytes(range(256)) * 1600
        r = self.store.update(r['id'],r['owner'],job={'status':'COMPLETED','result_asset':{'playable':True,'size_bytes':len(blob)}})
        dest=original_path(self.app.root,r);dest.parent.mkdir(parents=True)
        dest.with_suffix('.part').write_bytes(blob[:251])
        seen=[]
        def ranged(method,path,headers,timeout):
            start,end=map(int,headers['Range'][6:].split('-'));seen.append((start,end))
            return MediaResponse(blob[start:end+1],206,{'Content-Range':'bytes %d-%d/%d'%(start,end,len(blob))})
        self.remote.open=ranged
        download_original(self.app.root,self.store,r['id'],r['owner'],self.remote,range_bytes=65536,range_workers=3)
        self.assertEqual(dest.read_bytes(),blob)
        self.assertEqual(min(a for a,b in seen),251)
        self.assertEqual(max(b for a,b in seen),len(blob)-1)
        self.assertEqual(self.store.get(r['id'])['local_original']['sha256'],hashlib.sha256(blob).hexdigest())

    def test_local_media_range_and_owner_no_remote_dependency(self):
        r, blob = self.local_fixture()
        self.remote.open=lambda *a,**kw: MediaResponse(blob)
        dest=download_original(self.app.root,self.store,r['id'],r['owner'],self.remote)
        self.remote.open=lambda *a,**kw: self.fail('cached playback cannot use remote')
        self.app.clients['mine']=self.c
        self.app.clients['other']={**self.c,'owner':'http://example.test|test-peer'}
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.app=self.app;server.showcase_root=None
        threading.Thread(target=server.serve_forever,daemon=True).start()
        conn=http.client.HTTPConnection('127.0.0.1',server.server_port)
        try:
            for endpoint in ['media','download']:
                conn.request('GET','/api/run/'+r['id']+'/'+endpoint,headers={'Cookie':'bench_session=mine','Range':'bytes=10-30'})
                res=conn.getresponse();self.assertEqual(res.status,206);self.assertEqual(res.read(),blob[10:31])
                if endpoint=='download':
                    self.assertIn('attachment',res.getheader('Content-Disposition'))
                    self.assertIn('test-model__01-mindflow__',res.getheader('Content-Disposition'))
            conn.request('GET','/api/run/'+r['id']+'/media',headers={'Cookie':'bench_session=other'})
            res=conn.getresponse();self.assertEqual(res.status,403);res.read()
            conn.request('GET','/api/run/'+r['id']+'/media')
            res=conn.getresponse();self.assertEqual(res.status,403);res.read()
            self.assertTrue(self.app.record(self.store.get(r['id']))['local_original_available'])
            dest.unlink()
            self.assertFalse(self.app.record(self.store.get(r['id']))['local_original_available'])
        finally:
            conn.close();server.shutdown();server.server_close()


if __name__ == "__main__":
    unittest.main()
