/**
 * JSONL 增量读取器。
 *
 * 为什么需要：cc 的 stdout 现在【直接写文件】，不再经由 Bridge 的管道
 * （管道会让 Bridge 一退出子进程就被 SIGPIPE 杀掉 —— 实测如此，
 * 这正是热更新做不了的根因）。于是实时事件改为从文件增量拉。
 *
 * 两条硬约束：
 *  · 用轮询 stat，不用 fs.watch —— 工作区在共享存储（quarkfs）上，inotify 不可靠。
 *  · 只推进到最后一个换行。残缺行留到下一轮：没有管道可以重发，丢了就永久丢。
 */
import { open, stat } from 'node:fs/promises';

export class JsonlTailer {
  constructor({ path, fromOffset = 0, intervalMs = 400, onLine, onError }) {
    this.path = path;
    this.offset = fromOffset;
    this.intervalMs = intervalMs;
    this.onLine = onLine;
    this.onError = onError ?? (() => {});
    this.timer = null;
    this.busy = false;
    this.carry = '';          // 上一轮读到的残缺行
  }

  start() {
    this.stop();
    this.timer = setInterval(() => { this.pump().catch(this.onError); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** 读一次到 EOF。退出收尾时要显式 await 一次，确保末尾的 result 行不丢。 */
  async pump() {
    if (this.busy) return 0;
    this.busy = true;
    let lines = 0;
    try {
      let size;
      try { size = (await stat(this.path)).size; } catch { return 0; }
      if (size <= this.offset) return 0;

      const fh = await open(this.path, 'r');
      try {
        while (this.offset < size) {
          const len = Math.min(size - this.offset, 1 << 20);   // 每次最多 1MB
          const buf = Buffer.allocUnsafe(len);
          const { bytesRead } = await fh.read(buf, 0, len, this.offset);
          if (!bytesRead) break;
          this.offset += bytesRead;
          const chunk = this.carry + buf.subarray(0, bytesRead).toString('utf8');
          const nl = chunk.lastIndexOf('\n');
          if (nl < 0) { this.carry = chunk; continue; }   // 整块都还没凑够一行
          this.carry = chunk.slice(nl + 1);               // 残缺尾巴留到下轮
          for (const line of chunk.slice(0, nl).split('\n')) {
            if (!line.trim()) continue;
            try { this.onLine(line); lines += 1; } catch (e) { this.onError(e); }
          }
        }
      } finally { await fh.close(); }
    } finally { this.busy = false; }
    return lines;
  }
}
