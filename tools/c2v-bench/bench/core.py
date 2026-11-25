"""Versioned benchmark records, independent of the generation harness."""

import copy, fcntl, hashlib, json, os, statistics, threading, time, uuid
from datetime import datetime, timezone
from pathlib import Path

from gate import evaluate_gate
from prompts import POLICY, validate_prompt

TERMINAL = {"COMPLETED", "FAILED", "CANCELLED", "OUT_OF_SCOPE"}


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def digest_file(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    with temp.open("w") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    temp.replace(path)


def seconds(a, b):
    if not a or not b:
        return None
    try:
        return max(
            0,
            (
                datetime.fromisoformat(b.replace("Z", "+00:00"))
                - datetime.fromisoformat(a.replace("Z", "+00:00"))
            ).total_seconds(),
        )
    except (ValueError, TypeError):
        return None


def lock_file(file, timeout=30):
    # Some shared filesystems return EAGAIN even for blocking flock; retry explicitly.
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise TimeoutError("Benchmark record is busy; retry later")
            time.sleep(0.02)


class ProcessRLock:
    """Serialize CLI download/export and server review writes without losing review history."""
    def __init__(self, path):
        self.path = path
        self.thread_lock = threading.RLock()
        self.local = threading.local()

    def __enter__(self):
        self.thread_lock.acquire()
        depth = getattr(self.local, "depth", 0)
        try:
            if depth == 0:
                self.local.file = self.path.open("a")
                lock_file(self.local.file)
            self.local.depth = depth + 1
            return self
        except Exception:
            if depth == 0 and getattr(self.local, "file", None):
                self.local.file.close()
            self.thread_lock.release()
            raise

    def __exit__(self, *args):
        self.local.depth -= 1
        if self.local.depth == 0:
            fcntl.flock(self.local.file, fcntl.LOCK_UN)
            self.local.file.close()
        self.thread_lock.release()


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = ProcessRLock(self.root / ".store.lock")

    def path(self, rid):
        if not isinstance(rid, str) or not rid.startswith("run_"):
            raise ValueError("Invalid run id")
        uuid.UUID(rid[4:])
        return self.root / (rid + ".json")

    def get(self, rid, owner=None):
        with self.lock:
            r = json.loads(self.path(rid).read_text())
        if owner is not None and r["owner"] != owner:
            raise PermissionError("记录不属于当前账号")
        return r

    def put(self, r):
        with self.lock:
            atomic(self.path(r["id"]), r)

    def update(self, rid, owner, **fields):
        with self.lock:
            r = self.get(rid, owner)
            r.update(fields, updated_at=now())
            self.put(r)
            return r

    def list(self, owner):
        with self.lock:
            return sorted(
                [
                    r
                    for p in self.root.glob("run_*.json")
                    if (r := json.loads(p.read_text()))["owner"] == owner
                ],
                key=lambda r: r["created_at"],
                reverse=True,
            )

    def plan(self, suite, case_id, model, owner, base, cohort):
        c = next(c for c in suite["cases"] if c["id"] == case_id)
        validate_prompt(c, required=suite.get("prompt_policy") == POLICY)
        gate = evaluate_gate(c.get("gate_intake"))
        configured = suite["policies"][c["skill_policy"]].get("configured", [])
        if any(skill.get("id") == "anatomy" for skill in configured) and gate["status"] != "suitable":
            raise ValueError("Anatomy gate 未通过：" + "；".join(gate["reasons"]))
        if c["status"] != "ready":
            raise ValueError(c["block_reason"])
        if not isinstance(cohort, str) or not cohort.strip() or len(cohort) > 100:
            raise ValueError("请填写批次名（1–100 字符）")
        r = {
            "id": "run_" + str(uuid.uuid4()),
            "owner": owner,
            "dev_url": base,
            "cohort": cohort.strip(),
            "created_at": now(),
            "state": "PLANNED",
            "suite_id": suite["id"],
            "suite_version": suite["version"],
            "prompt_policy": suite.get("prompt_policy"),
            "suite_sha256": digest(
                json.dumps(suite, ensure_ascii=False, sort_keys=True).encode()
            ),
            "case": copy.deepcopy(c),
            "input_assets_snapshot": [
                copy.deepcopy(a)
                for a in suite["assets"]
                if a["id"] in c["input_assets"]
            ],
            "model_requested": copy.deepcopy(model),
            "skill_requested": copy.deepcopy(suite["policies"][c["skill_policy"]]),
            "platform_baseline": suite["code_baseline"],
            "idempotency_key": "c2v-bench-" + str(uuid.uuid4()),
            "session_id": None,
            "job_id": None,
            "uploads": [],
            "reviews": [],
            "probe": None,
            "job": None,
            "events": [{"at": now(), "type": "planned"}],
        }
        self.put(r)
        return r

    def event(self, rid, owner, kind, **data):
        with self.lock:
            r = self.get(rid, owner)
            r["events"].append({"at": now(), "type": kind, **data})
            self.put(r)


def evaluation(run):
    j = run.get("job") or {}
    p = run.get("probe")
    q = (run.get("reviews") or [None])[-1]
    a = j.get("result_asset") or {}
    req = run["case"]["requirements"]
    duration_ok = None
    aspect_ok = None
    if p and p.get("decode_ok"):
        if req.get("duration_seconds") is not None:
            duration_ok = abs(p["duration_seconds"] - req["duration_seconds"]) <= max(
                0.1, 1 / max(p.get("fps") or 1, 1)
            )
        elif req.get("duration_range_seconds"):
            low, high = req["duration_range_seconds"]
            duration_ok = low <= p["duration_seconds"] <= high
        if req.get("aspect_ratio"):
            w, h = map(int, req["aspect_ratio"].split(":"))
            aspect_ok = abs(p["width"] / p["height"] - w / h) < 0.01
    render = p.get("decode_ok") if p else None
    # Hard requirements include visual/copy instructions; do not infer them from metadata.
    hard = None
    if (
        (j.get("status") in TERMINAL and not a.get("playable"))
        or render is False
        or duration_ok is False
        or aspect_ok is False
        or (q and q["hard_instructions"] == "fail")
    ):
        hard = False
    elif (
        render
        and (not req.get("duration_seconds") or duration_ok)
        and (not req.get("aspect_ratio") or aspect_ok)
        and q
        and q["hard_instructions"] == "pass"
    ):
        hard = True
    return {
        "terminal": j.get("status") in TERMINAL,
        "has_video": bool(a.get("playable")),
        "render_verified": render,
        "duration_ok": duration_ok,
        "aspect_ok": aspect_ok,
        "hard_pass": hard,
        "quality": q["quality"] if q else "unreviewed",
        "queue_seconds": seconds(j.get("queued_at"), j.get("started_at")),
        "execution_seconds": seconds(j.get("started_at"), j.get("finished_at")),
        "total_seconds": seconds(j.get("created_at"), j.get("finished_at")),
        "inference_seconds": None,
    }


def summary(runs):
    groups = {}
    for r in runs:
        m = (r.get("job") or {}).get("model_selection") or r["model_requested"]
        rev = ((r.get("job") or {}).get("experimental_skills") or {}).get(
            "revision"
        ) or "pending"
        key = (
            r["cohort"],
            r["suite_version"],
            m.get("model"),
            m.get("revision"),
            r["case"]["skill_policy"],
            rev,
        )
        g = groups.setdefault(
            key,
            {
                "cohort": key[0],
                "suite_version": key[1],
                "model": key[2],
                "model_revision": key[3],
                "policy": key[4],
                "skill_revision": key[5],
                "planned": 0,
                "submitted": 0,
                "terminal": 0,
                "has_video": 0,
                "render_verified": 0,
                "render_failed": 0,
                "hard_pass": 0,
                "hard_fail": 0,
                "reviewed": 0,
                "quality_pass": 0,
                "times": [],
            },
        )
        e = evaluation(r)
        g["planned"] += 1
        g["submitted"] += bool(r.get("job_id"))
        g["terminal"] += e["terminal"]
        g["has_video"] += e["has_video"]
        for field, condition in [
            ("render_verified", e["render_verified"] is True),
            ("render_failed", e["render_verified"] is False),
            ("hard_pass", e["hard_pass"] is True),
            ("hard_fail", e["hard_pass"] is False),
            ("reviewed", e["quality"] != "unreviewed"),
            ("quality_pass", e["quality"] == "pass"),
        ]:
            g[field] += condition
        if e["execution_seconds"] is not None:
            g["times"].append(e["execution_seconds"])
    for g in groups.values():
        t = g.pop("times")
        g["median_execution_seconds"] = statistics.median(t) if t else None
        g["max_execution_seconds"] = max(t) if t else None
    return list(groups.values())
