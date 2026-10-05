// 照片存储层：负责落盘、按年月归档、去重索引、缩略图缓存
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.gif', '.webp', '.dng', '.raw', '.cr2', '.nef', '.arw', '.tiff', '.tif', '.bmp', '.mp4', '.mov', '.m4v', '.3gp']);

export class PhotoStore {
  /**
   * @param {object} opts
   * @param {string} opts.dest       照片根目录
   * @param {string} opts.indexFile  去重索引文件
   * @param {string} opts.cacheDir  缩略图缓存目录
   */
  constructor({ dest, indexFile, cacheDir }) {
    this.dest = dest;
    this.indexFile = indexFile;
    this.cacheDir = cacheDir;
    /** @type {Map<string, {hash:string,name:string,size:number,mtime:number,rel:string,takenAt:number,receivedAt:number}>} */
    this.index = new Map();
    this.dirty = false;
    this._writeTimer = null;
    this._saving = false;
    this._saveAgain = false;
  }

  init() {
    fs.mkdirSync(this.dest, { recursive: true });
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.mkdirSync(path.join(this.cacheDir, 'parts'), { recursive: true });
    fs.mkdirSync(path.dirname(this.indexFile), { recursive: true });
    this.load();
    // 周期性落盘。MacBook 合盖不会杀进程，只是不响应，
    // 只靠退出信号保存的话索引可能一直丢在内存里。
    this._flusher = setInterval(() => {
      if (this.dirty) this.save().catch(() => {});
    }, 20000);
    this._flusher.unref?.();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.indexFile, 'utf8');
      const data = JSON.parse(raw);
      if (data && data.items && typeof data.items === 'object') {
        for (const [hash, v] of Object.entries(data.items)) this.index.set(hash, v);
      }
    } catch {
      // 首次运行 / 索引损坏：从空开始，靠目录扫描兜底
    }
    // 与磁盘实际文件对账：索引里有但文件没了的要剔除
    this.reconcile();
  }

  reconcile() {
    let removed = 0;
    for (const [hash, v] of this.index) {
      if (!v || !v.rel) {
        this.index.delete(hash);
        removed++;
        continue;
      }
      if (!fs.existsSync(path.join(this.dest, v.rel))) {
        this.index.delete(hash);
        removed++;
      }
    }
    if (removed) this.markDirty();
  }

  markDirty() {
    this.dirty = true;
    // 不靠 setTimeout / queueMicrotask：MacBook 睡眠唤醒后这些调度不可靠，
    // 索引丢了会导致下次同步重复落盘。直接同步写。
    if (this._writeScheduled) return;
    this._writeScheduled = true;
    setImmediate(() => {
      this._writeScheduled = false;
      try { this.saveSync(); } catch (e) { console.error('[store] 索引保存失败:', e.message); }
    });
  }

  /** 同步落盘。索引很小（几千条约几百 KB），同步写完全可接受，
   *  换来的是「写完一定在磁盘上」的确定性，不受调度器状态影响。 */
  saveSync() {
    if (this._saving) { this._saveAgain = true; return; }
    this._saving = true;
    try {
      const items = {};
      for (const [hash, v] of this.index) items[hash] = v;
      const payload = JSON.stringify({ version: 2, updatedAt: Date.now(), items });
      const tmp = this.indexFile + '.tmp';
      // 原子写：先写临时文件再 rename，避免进程被杀导致索引半截损坏。
      // 但 rename 并非总是允许（沙箱策略、跨设备、部分网络文件系统会拒绝覆盖），
      // 失败时退回直写——索引是去重的唯一依据，写不进去等于同步功能失效，
      // 宁可牺牲原子性也不能丢。
      try {
        fs.writeFileSync(tmp, payload, 'utf8');
        fs.renameSync(tmp, this.indexFile);
      } catch (renameErr) {
        this.atomicWriteFailed = true;
        fs.writeFileSync(this.indexFile, payload, 'utf8');   // 降级：直写
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      }
      this.dirty = false;
      this.lastSaveError = null;
    } catch (e) {
      this.lastSaveError = e.message;
      console.error('[store] 索引保存失败:', e.message);
    } finally {
      this._saving = false;
    }
  }

  async save() {
    if (this._saving) { this._saveAgain = true; return; }
    this._saving = true;
    try {
      const items = {};
      for (const [hash, v] of this.index) items[hash] = v;
      const payload = JSON.stringify({ version: 2, updatedAt: Date.now(), items });
      const tmp = this.indexFile + '.tmp';
      try {
        await fs.promises.writeFile(tmp, payload, 'utf8');
        await fs.promises.rename(tmp, this.indexFile);
      } catch (renameErr) {
        this.atomicWriteFailed = true;
        await fs.promises.writeFile(this.indexFile, payload, 'utf8');
        try { if (fs.existsSync(tmp)) await fs.promises.unlink(tmp); } catch {}
      }
      this.dirty = false;
      this.lastSaveError = null;
    } catch (e) {
      this.lastSaveError = e.message;
      console.error('[store] 索引保存失败(异步):', e.message);
    } finally {
      this._saving = false;
      if (this._saveAgain) { this._saveAgain = false; await this.save(); }
    }
  }

  has(hash) {
    if (!hash) return false;
    const v = this.index.get(hash);
    if (!v) return false;
    // 二次校验文件确实还在，防止用户手动删了照片但索引没清
    return fs.existsSync(path.join(this.dest, v.rel));
  }

  isImage(name) {
    return IMAGE_EXT.has(path.extname(name || '').toLowerCase());
  }

  /**
   * 从 JPEG APP1 段里抠拍摄时间。抠不到就返回 null，交给文件 mtime 兜底。
   * 只解析前 128KB，绝大多数手机 JPEG 的 EXIF 都在文件头。
   */
  static readExifTakenAt(buf) {
    if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    const TWO = (p) => (buf[p] | (buf[p + 1] << 8));          // little-endian
    const FOUR = (p) => (buf[p] | (buf[p+1] << 8) | (buf[p+2] << 16)) + buf[p+3] * 0x1000000;
    try {
      // 1) 找到 APP1 段并确认 "Exif\0\0"
      let tiff = -1;
      for (let off = 2; off + 4 < buf.length && off < 131072;) {
        if (buf[off] !== 0xff) break;
        const marker = buf[off + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
        if (marker === 0xda || marker === 0xd9) break;
        const segLen = (buf[off + 2] << 8) | buf[off + 3];   // big-endian，含长度字段本身
        if (segLen < 2) break;
        if (marker === 0xe1 && off + 10 <= buf.length
            && buf[off+4]===0x45 && buf[off+5]===0x78 && buf[off+6]===0x69 && buf[off+7]===0x66
            && buf[off+8]===0x00 && buf[off+9]===0x00) {
          tiff = off + 10;                                    // 跳过 FFE1 + 长度2 + "Exif\0\0"6
          break;
        }
        off += 2 + segLen;
      }
      if (tiff < 0 || tiff + 8 > buf.length) return null;

      // 2) TIFF 头：字节序 + 魔数 42 + 首个 IFD 偏移（相对 tiff）
      const bo = buf[tiff], bo2 = buf[tiff + 1];
      const le = (bo === 0x49 && bo2 === 0x49);
      const be = (bo === 0x4d && bo2 === 0x4d);
      if (!le && !be) return null;
      const u16 = (p) => (le ? TWO(p) : (buf[p] << 8) | buf[p+1]);
      const u32 = (p) => {
        const v = le
          ? (buf[p] | (buf[p+1]<<8) | (buf[p+2]<<16) | (buf[p+3]<<24))
          : (buf[p]*(1<<24)) + (buf[p+1]<<16) + (buf[p+2]<<8) + buf[p+3];
        return v >>> 0;                                        // 避免 32 位溢出成负数
      };
      if (u16(tiff + 2) !== 42) return null;
      const tiffEnd = tiff + u32(tiff + 4);

      // 3) 遍历 IFD0 → ExifIFD，找 DateTimeOriginal(0x9003) / DateTimeDigitized(0x9004)
      const found = [];
      const seen = new Set();
      const walk = (start, depth) => {
        if (depth > 3 || seen.has(start) || start < 0 || start + 2 > buf.length) return;
        seen.add(start);
        const n = u16(start);
        if (n > 512) return;                                    // 明显损坏
        for (let i = 0; i < n; i++) {
          const e = start + 2 + i * 12;
          if (e + 12 > buf.length) return;
          const tag = u16(e), type = u16(e + 2);
          if (tag === 0x9003 || tag === 0x9004) {
            const count = u32(e + 4);
            // ASCII(2) 且 count>4 时值放在偏移处；否则内联在 e+8
            let p = e + 8;
            if (type === 2 && count > 4) p = tiff + u32(e + 8);
            if (p < 0 || p + 19 > buf.length) continue;
            const s = buf.toString('latin1', p, p + 19);
            const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
            if (m) found.push({ tag, ts: Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]) });
          } else if (tag === 0x8769) {
            walk(tiff + u32(e + 8), depth + 1);                 // Exif IFD 指针
          }
          if (e + 12 > tiffEnd && depth > 0) return;
        }
      };
      walk(tiffEnd, 0);
      if (!found.length) return null;
      // DateTimeOriginal 优先于 DateTimeDigitized
      found.sort((a, b) => a.tag - b.tag);
      return found[0].ts;
    } catch {
      return null;
    }
  }

  /**
   * 落盘一张照片/视频。返回 {status:'saved'|'duplicate', rel, takenAt}
   */
  async save({ buffer, name, hash, mtime = 0, takenAtHint = null }) {
    if (!buffer || !buffer.length) throw new Error('空文件');

    if (this.has(hash)) {
      const v = this.index.get(hash);
      return { status: 'duplicate', rel: v.rel, takenAt: v.takenAt, hash };
    }

    const safeName = this._safeName(name);
    let takenAt = takenAtHint;
    if (!takenAt) {
      const head = buffer.subarray(0, Math.min(buffer.length, 131072));
      takenAt = PhotoStore.readExifTakenAt(head);
    }
    if (!takenAt) {
      // 退而求其次：文件名里的 8 位日期 (如 IMG_20240315_143022)
      const m = String(safeName).match(/(20\d{2})[01]\d[0-3]\d/);
      takenAt = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
    }
    if (!takenAt) takenAt = mtime ? mtime * 1000 : Date.now();

    const d = new Date(takenAt);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const dir = path.join(this.dest, ym);
    fs.mkdirSync(dir, { recursive: true });

    let rel = path.join(ym, safeName);
    let n = 1;
    while (fs.existsSync(path.join(this.dest, rel))) {
      const ext = path.extname(safeName);
      const base = path.basename(safeName, ext);
      rel = path.join(ym, `${base}-${n}${ext}`);
      n++;
    }

    // 先写 .part 再 rename，防止传输中断留下半个文件被当成完整照片
    const abs = path.join(this.dest, rel);
    const tmp = abs + '.part';
    await fs.promises.writeFile(tmp, buffer);
    await fs.promises.rename(tmp, abs);

    this.index.set(hash, {
      hash, name: safeName, size: buffer.length, mtime,
      rel, takenAt, receivedAt: Date.now(),
    });
    this.markDirty();
    return { status: 'saved', rel, takenAt, hash };
  }

  _safeName(name) {
    // 先砍掉路径分隔符，再把残留的点序列压平。
    // 否则 "../../etc/passwd.jpg" 会变成 ".._.._etc_passwd.jpg"，名字里留着 ..
    let n = String(name || 'unnamed').split(/[/\\]/).pop() || 'unnamed';
    n = n.replace(/[\u0000-\u001f\u007f]/g, '');
    n = n.replace(/[<>:"|?*]/g, '_');
    n = n.replace(/\.{2,}/g, '_');
    n = n.replace(/^\.+/, '_');
    n = n.slice(0, 180);
    if (!path.extname(n)) n += '.jpg';
    return n || 'unnamed.jpg';
  }

  /** 缩略图：优先用 macOS 自带 sips，失败退化为原图 */
  async thumbnail(hash, size = 320) {
    const v = this.index.get(hash);
    if (!v) return null;
    const cache = path.join(this.cacheDir, `${hash}.jpg`);
    if (fs.existsSync(cache)) return cache;
    const src = path.join(this.dest, v.rel);
    if (!fs.existsSync(src)) return null;
    const tmp = cache + '.tmp' + Date.now();
    try {
      await execFileAsync('/usr/bin/sips', [
        '-Z', String(size), src, '--out', tmp, '-s', 'format', 'jpeg', '-s', 'formatOptions', '70',
      ], { timeout: 20000 });
      if (fs.existsSync(tmp)) {
        fs.renameSync(tmp, cache);
        return cache;
      }
    } catch {
      // HEIC/DNG/raw 等 sips 处理不了的，直接给原图
    }
    try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch {}
    return src;
  }

  stats() {
    let count = 0, bytes = 0;
    let newest = 0;
    for (const v of this.index.values()) {
      count++;
      bytes += v.size || 0;
      if (v.takenAt > newest) newest = v.takenAt;
    }
    return { count, bytes, newest };
  }

  recent(limit = 60) {
    return [...this.index.values()]
      .sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0))
      .slice(0, limit)
      .map((v) => ({ hash: v.hash, name: v.name, rel: v.rel, takenAt: v.takenAt, size: v.size }));
  }

  /** 磁盘实际占用（不依赖索引，索引可能刚启动） */
  diskUsage() {
    let bytes = 0, files = 0;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (!e.name.endsWith('.part')) {
          try { bytes += fs.statSync(p).size; files++; } catch {}
        }
      }
    };
    walk(this.dest);
    return { bytes, files };
  }
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
