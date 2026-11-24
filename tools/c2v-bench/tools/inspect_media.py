#!/usr/bin/env python3
import concurrent.futures, hashlib, json, subprocess, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
suite = json.loads((ROOT / "dataset/v0.1.0/suite.json").read_text())
out = ROOT / "runtime/media"
out.mkdir(parents=True, exist_ok=True)


def fetch(url):
    p = (
        ROOT
        / "source/remote-references"
        / (hashlib.sha256(url.encode()).hexdigest()[:16] + ".mp4")
    )
    try:
        if not p.exists():
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=35) as r, p.with_suffix(
                ".part"
            ).open("wb") as f:
                size = 0
                while chunk := r.read(1024 * 1024):
                    size += len(chunk)
                    if size > 250 * 1024 * 1024:
                        raise ValueError("Reference exceeds 250MiB")
                    f.write(chunk)
            p.with_suffix(".part").replace(p)
        return url, {
            "path": str(p.relative_to(ROOT)),
            "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
            "bytes": p.stat().st_size,
            "fetch_status": "downloaded",
        }
    except Exception as e:
        p.with_suffix(".part").unlink(missing_ok=True)
        return url, {"fetch_status": "unavailable", "error": str(e)[:200]}


urls = list(
    dict.fromkeys(
        o["url"] for c in suite["cases"] for o in c["reference_outputs"] if o.get("url")
    )
)
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
    remote = dict(ex.map(fetch, urls))
(ROOT / "source/remote-references/manifest.json").write_text(
    json.dumps(remote, ensure_ascii=False, indent=2) + "\n"
)
assets = {a["id"]: a for a in suite["assets"]}
from PIL import Image, ImageDraw, ImageFont

font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 17)
results = []
tiles = []
for c in suite["cases"]:
    o = next(iter(c["reference_outputs"]), {})
    item = (
        assets.get(o.get("asset_id"), {})
        if o.get("asset_id")
        else remote.get(o.get("url"), {})
    )
    if not item.get("path"):
        continue
    p = ROOT / item["path"]
    try:
        probe = json.loads(
            subprocess.check_output(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_streams",
                    "-show_format",
                    "-of",
                    "json",
                    str(p),
                ]
            )
        )
        vs = next(s for s in probe["streams"] if s["codec_type"] == "video")
        duration = float(probe["format"]["duration"])
        results.append(
            {
                "case_id": c["id"],
                "reference": o,
                "duration_seconds": duration,
                "width": vs["width"],
                "height": vs["height"],
                "audio": any(s["codec_type"] == "audio" for s in probe["streams"]),
                "sha256": item["sha256"],
            }
        )
        strip = Image.new("RGB", (960, 205), "#101724")
        d = ImageDraw.Draw(strip)
        d.text(
            (8, 4),
            f"{c['id']} | {duration:.1f}s | {vs['width']}x{vs['height']}",
            font=font,
            fill="white",
        )
        for k, frac in enumerate([0.15, 0.5, 0.8]):
            dest = out / f'{c["id"]}-{k}.jpg'
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-ss",
                    str(duration * frac),
                    "-i",
                    str(p),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=310:170:force_original_aspect_ratio=decrease",
                    "-y",
                    str(dest),
                ],
                check=True,
            )
            im = Image.open(dest)
            strip.paste(im, (k * 320 + (320 - im.width) // 2, 30))
            dest.unlink()
        tiles.append(strip)
    except Exception as e:
        results.append({"case_id": c["id"], "error": str(e)[:200]})
for n in range(0, len(tiles), 6):
    im = Image.new("RGB", (960, 205 * len(tiles[n : n + 6])), "#101724")
    for j, t in enumerate(tiles[n : n + 6]):
        im.paste(t, (0, j * 205))
    im.save(out / f"reference-sheet-{n//6+1}.jpg", quality=87)
(out / "reference-metadata.json").write_text(
    json.dumps(results, ensure_ascii=False, indent=2) + "\n"
)
print(
    json.dumps(
        {"remote": remote, "inspected_references": len(results)}, ensure_ascii=False
    )
)
