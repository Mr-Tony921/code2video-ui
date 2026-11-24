"""Ordinary authenticated Web API only. Never access internal queue/store APIs."""

import http.cookiejar, json, mimetypes, threading, urllib.error, urllib.request, uuid
from pathlib import Path


class RemoteError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Remote:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar), NoRedirect()
        )
        self.lock = threading.RLock()

    def open(self, method, path, data=None, headers=None, timeout=90):
        if not path.startswith("/api/") or ".." in path or path.startswith("//"):
            raise ValueError("Only ordinary API paths")
        req = urllib.request.Request(
            self.base + path, data=data, headers=headers or {}, method=method
        )
        try:
            with self.lock:
                return self.opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            try:
                msg = (
                    json.loads(e.read(10000)).get("error", {}).get("message")
                    or f"HTTP {e.code}"
                )
            except Exception:
                msg = f"HTTP {e.code}"
            raise RemoteError(e.code, msg) from None

    def json(self, method, path, data=None, headers=None):
        h = {"Content-Type": "application/json", **(headers or {})}
        with self.open(
            method, path, None if data is None else json.dumps(data).encode(), h
        ) as r:
            return json.load(r)

    def login(self, username, password):
        self.json(
            "POST", "/api/auth/login", {"username": username, "password": password}
        )
        return self.json("GET", "/api/auth/me")["user"]

    def upload(self, sid, path, note):
        boundary = "bench-" + uuid.uuid4().hex
        name = Path(path).name.replace('"', "_")
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        data = (
            (
                f'--{boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\n{note}\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\nContent-Type: {mime}\r\n\r\n'
            ).encode()
            + Path(path).read_bytes()
            + f"\r\n--{boundary}--\r\n".encode()
        )
        with self.open(
            "POST",
            f"/api/sessions/{sid}/references",
            data,
            {"Content-Type": f"multipart/form-data; boundary={boundary}"},
        ) as r:
            return json.load(r)
