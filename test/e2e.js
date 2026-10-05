// 端到端自测：分块上传 / 断点续传 / 哈希去重 / EXIF 拍摄时间
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = process.env.PS_BASE || 'http://127.0.0.1:8848';
const TEST_DIR = path.join(os.tmpdir(), 'phonesync-test');
fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

/** 造一个带 EXIF DateTimeOriginal 的最小 JPEG。
 *
 *  TIFF 布局（所有偏移相对 TIFF 块起点）：
 *    头 8 字节：'II' + 42(u16) + IFD0偏移(u32=8)
 *    IFD  = count(2) + 条目(12)×n + nextIFD(4) = 18 字节（n=1）
 *    条目 = tag(2) type(2) count(4) value(4)
 *  注意：条目从 IFD 数组的索引 2 开始，所以「值」字段在索引 2+8 = 10，不是 8。
 *  这点写错的话解析会读到 0 然后静默返回 null——踩过一次，别再改错。
 */
function makeJpeg(exifDate) {
  const T = 8;              // TIFF 头
  const IFD0 = 18;          // count(2)+条目(12)+next(4)
  const EXIF = 18;          // 同上
  const STR = 20;           // "YYYY:MM:DD HH:MM:SS" + NUL
  const dateOff = T + IFD0 + EXIF;   // 字符串在 TIFF 内的偏移 = 44
  const exifIfdOff = T + IFD0;       // ExifIFD 在 TIFF 内的偏移 = 26

  const tiff = Buffer.alloc(T);
  tiff.write('II', 0, 'latin1');     // 小端
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(T, 4);           // IFD0 紧跟头

  // IFD0：1 个条目 = ExifIFDPointer (0x8769, LONG)
  const ifd0 = Buffer.alloc(IFD0);
  ifd0.writeUInt16LE(1, 0);           // 条目数
  ifd0.writeUInt16LE(0x8769, 2);      // tag
  ifd0.writeUInt16LE(4, 4);           // type = LONG
  ifd0.writeUInt32LE(1, 6);           // count
  ifd0.writeUInt32LE(exifIfdOff, 10); // value（索引 10 = 条目起点+8）
  ifd0.writeUInt32LE(0, 14);          // next IFD

  // ExifIFD：1 个条目 = DateTimeOriginal (0x9003, ASCII 20)
  const exifIfd = Buffer.alloc(EXIF + STR);
  exifIfd.writeUInt16LE(1, 0);
  exifIfd.writeUInt16LE(0x9003, 2);
  exifIfd.writeUInt16LE(2, 4);        // type = ASCII
  exifIfd.writeUInt32LE(20, 6);       // count（含结尾 NUL）
  exifIfd.writeUInt32LE(dateOff, 10); // value
  exifIfd.writeUInt32LE(0, 14);
  exifIfd.write(exifDate, EXIF, 'latin1');

  const tiffBlock = Buffer.concat([tiff, ifd0, exifIfd]);
  const app1Payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiffBlock]);
  // APP1：FFE1 + 段长（含长度字段本身） + payload
  const app1Header = Buffer.alloc(4);
  app1Header.writeUInt16BE(0xffe1, 0);
  app1Header.writeUInt16BE(app1Payload.length + 2, 2);

  const fake = Buffer.alloc(2048);
  for (let i = 0; i < fake.length; i++) fake[i] = (i * 37) & 0xff;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1Header, app1Payload, fake, Buffer.from([0xff, 0xd9])]);
}

async function upload(buf, name, { breakOnce = false, mtime = 0 } = {}) {
  const init = await fetch(`${BASE}/api/upload/init`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, total: buf.length, mtime }),
  });
  const { uploadId } = await init.json();
  const CH = 64 * 1024;
  let start = 0;
  let broke = false;
  while (start < buf.length) {
    const end = Math.min(start + CH, buf.length);
    // 带重试：真实 WiFi 下丢包很常见，一次失败就断掉太脆
    let sent = false;
    for (let attempt = 0; attempt < 3 && !sent; attempt++) {
      try {
        const r = await fetch(`${BASE}/api/upload/chunk?uploadId=${uploadId}&start=${start}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
          body: buf.subarray(start, end),
        });
        if (!r.ok) throw new Error(`chunk ${r.status}`);
        start = (await r.json()).received;
        sent = true;
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    if (breakOnce && !broke && start >= CH) { broke = true; break; } // 模拟中断
  }
  return { uploadId, start, broke };
}

async function main() {
  console.log('\n  PhoneSync 自测 →', BASE, '\n');

  // 0. 服务可达
  const st = await fetch(`${BASE}/api/status`).then(r => r.json());
  ok('服务可达', st.ok === true);
  ok('局域网地址已识别', Array.isArray(st.lanIPs) && st.lanIPs.length > 0, JSON.stringify(st.lanIPs));
  ok('WiFi 状态可读', !!st.wifi && typeof st.wifi.connected === 'boolean',
     st.wifi ? `connected=${st.wifi.connected} label=${st.wifi.label}` : 'null');

  // 0b. 静态资源必须可访问。API 全绿但页面 404 是最阴的故障——
  //     手机上看到白屏，API 测试却全过，所以必须单独盯。
  const assets = ['/', '/app.css', '/app.js', '/sw.js', '/manifest.webmanifest', '/icon-180.png'];
  for (const a of assets) {
    const r = await fetch(`${BASE}${a}`);
    const len = Number(r.headers.get('content-length') || 0);
    ok(`静态资源可访问 ${a}`, r.ok && len > 0, `status=${r.status} len=${len}`);
  }
  const html = await fetch(`${BASE}/`).then(r => r.text());
  ok('首页包含关键元素',
    html.includes('选择照片') && html.includes('/app.js') && html.includes('manifest'),
    html.slice(0, 120));

  // 1. 常规分块上传
  const jpeg1 = makeJpeg('2024:03:15 14:30:22');
  const r1 = await upload(jpeg1, 'IMG_0001.jpg');
  const f1 = await fetch(`${BASE}/api/upload/finish?uploadId=${r1.uploadId}`, { method: 'POST' }).then(r => r.json());
  ok('首次上传成功', f1.status === 'saved', JSON.stringify(f1));
  ok('按 EXIF 归档到 2024-03', f1.rel && f1.rel.startsWith('2024-03/'), f1.rel);
  const expTs = Date.UTC(2024, 2, 15, 14, 30, 22);
  ok('EXIF 拍摄时间正确', f1.takenAt === expTs, `${f1.takenAt} != ${expTs}`);

  // 2. 重复上传同一内容 → 去重
  const jpeg1b = makeJpeg('2024:03:15 14:30:22');
  const r1b = await upload(jpeg1b, 'IMG_0001_copy.jpg');
  const f1b = await fetch(`${BASE}/api/upload/finish?uploadId=${r1b.uploadId}`, { method: 'POST' }).then(r => r.json());
  ok('相同内容被识别为重复', f1b.status === 'duplicate', JSON.stringify(f1b));

  // 3. 断点续传：故意中断后用同一个 uploadId 接着传
  const big = makeJpeg('2023:07:04 09:00:00');
  const extra = Buffer.alloc(300 * 1024);
  for (let i = 0; i < extra.length; i++) extra[i] = (i * 91 + 7) & 0xff;
  const bigBuf = Buffer.concat([big, extra]);
  const rb = await upload(bigBuf, 'VID_0002.mp4', { breakOnce: true });
  ok('中断后已收到部分数据', rb.start > 0 && rb.start < bigBuf.length, `start=${rb.start}/${bigBuf.length}`);
  // 续传：从 offset 继续，重复发一次已收区间验证幂等
  let start = rb.start;
  const CH = 64 * 1024;
  while (start < bigBuf.length) {
    const end = Math.min(start + CH, bigBuf.length);
    let okc = false;
    for (let a = 0; a < 3 && !okc; a++) {
      try {
        const r = await fetch(`${BASE}/api/upload/chunk?uploadId=${rb.uploadId}&start=${start}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
          body: bigBuf.subarray(start, end),
        });
        if (!r.ok) throw new Error(`chunk ${r.status}`);
        start = (await r.json()).received;
        okc = true;
      } catch (e) {
        if (a === 2) throw e;
        await new Promise(r => setTimeout(r, 200 * (a + 1)));
      }
    }
  }
  // 幂等检查：重发最后一个分块，已收字节数不应被冲掉
  const lastChunkStart = Math.max(0, bigBuf.length - CH);
  const idem = await fetch(`${BASE}/api/upload/chunk?uploadId=${rb.uploadId}&start=${lastChunkStart}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
    body: bigBuf.subarray(lastChunkStart),
  }).then(r => r.json());
  ok('重发分块幂等（进度不回退）', idem.received === bigBuf.length, JSON.stringify(idem));

  const fb = await fetch(`${BASE}/api/upload/finish?uploadId=${rb.uploadId}`, { method: 'POST' }).then(r => r.json());
  ok('续传后落盘成功', fb.status === 'saved', JSON.stringify(fb));
  const sha = crypto.createHash('sha256').update(bigBuf).digest('hex');
  ok('续传内容字节完全一致', fb.hash === sha, `${fb.hash?.slice(0, 12)} != ${sha.slice(0, 12)}`);
  if (fb.status === 'saved') {
    const onDisk = fs.readFileSync(path.join(st.destDir, fb.rel));
    ok('落盘文件与源字节一致', onDisk.equals(bigBuf));
  }

  // 4. 批量去重查询
  const known = await fetch(`${BASE}/api/batch-query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ hash: sha }, { hash: 'deadbeef' }] }),
  }).then(r => r.json());
  ok('批量查询命中已存在', known.known[sha] === true);
  ok('批量查询未命中新项', known.known['deadbeef'] === false);

  // 5. 缩略图可生成
  const th = await fetch(`${BASE}/api/thumb?hash=${sha}`);
  ok('缩略图可访问', th.ok && Number(th.headers.get('content-length')) > 0, `status=${th.status}`);

  // 6. 无 EXIF 文件走 mtime 兜底
  const noExif = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(4096, 0x11), Buffer.from([0xff, 0xd9])]);
  const rn = await upload(noExif, 'SCREENSHOT_test.png', { mtime: 1699051200 });
  const fn = await fetch(`${BASE}/api/upload/finish?uploadId=${rn.uploadId}`, { method: 'POST' }).then(r => r.json());
  ok('无 EXIF 文件用 mtime 兜底', fn.status === 'saved' && Math.abs(fn.takenAt - 1699051200000) < 1000, JSON.stringify(fn));

  // 7. 危险文件名不越权
  const evil = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const re = await upload(evil, '../../../../etc/paswd.jpg');
  const fe = await fetch(`${BASE}/api/upload/finish?uploadId=${re.uploadId}`, { method: 'POST' }).then(r => r.json());
  ok('路径穿越被净化', !fe.rel.includes('..') && !fe.rel.includes('/etc/'), fe.rel);
  if (fe.rel) {
    const resolved = path.resolve(st.destDir, fe.rel);
    ok('净化后仍在目标目录内', resolved.startsWith(path.resolve(st.destDir) + path.sep), resolved);
  }

  // 8. 索引落盘（写入后应立即可见，不依赖定时器）
  const idx = path.join(os.homedir(), '.phonesync', 'index.json');
  let idxOk = false;
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(idx) && fs.statSync(idx).size > 0) {
      const parsed = JSON.parse(fs.readFileSync(idx, 'utf8'));
      if (parsed && parsed.items && Object.keys(parsed.items).length >= 4) { idxOk = true; break; }
    }
    await new Promise(r => setTimeout(r, 300));
  }
  ok('索引文件已写入且内容完整', idxOk, fs.existsSync(idx) ? `size=${fs.statSync(idx).size}` : '文件不存在');

  const st2 = await fetch(`${BASE}/api/status`).then(r => r.json());
  ok('统计已累加', st2.indexed >= 4, `indexed=${st2.indexed}`);
  ok('本次会话计数正确', st2.uploadedThisSession >= 4, `uploaded=${st2.uploadedThisSession}`);
  ok('索引无写入错误', st2.indexHealthy === true, st2.indexError || 'ok');
  // 某些环境（沙箱策略、网络文件系统）不允许 rename 覆盖，降级为直写也算成功，
  // 但必须保证索引内容完整——索引丢失等于去重失效。
  if (st2.atomicWriteFailed) {
    ok('降级直写后索引仍完整',
      fs.existsSync(idx) && Object.keys(JSON.parse(fs.readFileSync(idx, 'utf8')).items).length >= 4,
      'rename 被拒但索引未正确降级');
  }

  // 9. 索引记录含必要字段
  if (idxOk) {
    const persisted = JSON.parse(fs.readFileSync(idx, 'utf8'));
    ok('索引记录含必要字段',
      Object.values(persisted.items).every(v => v.hash && v.rel && typeof v.takenAt === 'number'),
      JSON.stringify(Object.values(persisted.items)[0] || {}));
  }

  console.log(`\n  ${pass} 通过 / ${fail} 失败\n`);
  // 清理：把测试期间写入的文件删掉，避免污染你的照片库
  console.log('  清理测试文件…');
  for (const v of [f1, fb, fn, fe]) {
    if (v && v.rel) { try { fs.unlinkSync(path.join(st.destDir, v.rel)); } catch {} }
  }
  // 索引里对应的 hash 也得剔除，否则下次跑会被误判成"已存在"
  try {
    const idxPath = path.join(os.homedir(), '.phonesync', 'index.json');
    const parsed = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    for (const h of [f1.hash, fb.hash, fn.hash, fe.hash]) if (h) delete parsed.items[h];
    fs.writeFileSync(idxPath, JSON.stringify(parsed));
  } catch {}
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  console.log('  已清理。\n');
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('\n  自测异常：', e, '\n'); process.exit(1); });
