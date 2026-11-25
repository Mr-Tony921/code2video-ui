"""Production wall-clock timing; separate from video duration and quality review."""
import math
from datetime import datetime


def format_elapsed(value):
    if value is None or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return "未记录"
    seconds = math.floor(value + 0.5)
    hours, rest = divmod(seconds, 3600)
    minutes, seconds = divmod(rest, 60)
    return f"{hours:02d}小时{minutes:02d}分钟{seconds:02d}秒"


def interval(start, end):
    if not start or not end:
        return None
    try:
        value = (datetime.fromisoformat(end.replace("Z", "+00:00"))
                 - datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds()
        return value if value >= 0 else None
    except (ValueError, TypeError, AttributeError):
        return None


def job_timing(job):
    job = job or {}
    result = {"version": "job-wall-clock-v1", "source": "server_job_timestamps"}
    for name, start, end in (("execution", "started_at", "finished_at"),
                             ("queue", "queued_at", "started_at"),
                             ("total", "created_at", "finished_at")):
        value = interval(job.get(start), job.get(end))
        result[name + "_seconds"] = value
        result[name + "_duration"] = format_elapsed(value)
    return result
