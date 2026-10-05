// PhoneSync Hub — Mac 端常驻接收服务
// 职责：接收手机照片/视频 → 按拍摄时间归档落盘 → 提供去重查询/缩略图/状态
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PhotoStore, sha256 } from './lib/store.js';
import { CONFIG, loadConfig, saveConfig } from './config.js';
import { WifiWatcher } from './lib/wifi.js';
import { SLEEPING_HINT } from './lib/constants.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const store = new PhotoStore({
  dest: CONFIG.destDir,
  indexFile: path.join(CONFIG.stateDir, 'index.json'),
  cacheDir: path.join(CONFIG.cacheDir, 'thumbs'),
});
store.init();

const wifi = new WifiWatcher();
wifi.start();

/** 上传会话：uploadId -> {tmp, offset, total, name, mtime, receivedAt} */
const sessions = new Map();
const SESSION_TTL = 6 * 60 * 60 * 1000;

const clients = new Set();
let startedAt = Date.now();
let lastUploadAt = 0;
let uploadedThisSession = 0;

function broadcast(event) {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

function lanIPs() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    // utun* 是 VPN/隧道接口，桥接网段（100.64/10、26.x 等）手机也连不上，直接排除
    if (/^(utun|tun|tap|awdl|llw|bridge|anpi|lo)/.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // link-local 没意义
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) continue; // CGNAT
      out.push({ iface: name, address: a.address });
    }
  }
  // 家用局域网（192.168/10.x）排最前面，方便直接抄给手机
  out.sort((a, b) => rank(a.address) - rank(b.address));
  return out;
}
function rank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  return 3;
}

function statusPayload() {
  const disk = store.diskUsage();
  return {
    ok: true,
    host: os.hostname(),
    port: CONFIG.port,
    startedAt,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    lanIPs: lanIPs(),
    wifi: wifi.snapshot(),
    destDir: CONFIG.destDir,
    indexed: store.index.size,
    indexHealthy: !store.lastSaveError,
    indexError: store.lastSaveError,
    atomicWriteFailed: !!store.atomicWriteFailed,
    disk,
    uploadedThisSession,
    lastUploadAt,
    activeUploads: sessions.size,
    serverTime: Date.now(),
  };
}

function json(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(CONFIG.publicDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(CONFIG.publicDir)) return json(res, 403, { ok: false, error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { ok: false, error: 'not found' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 同网段判定：只接受家里局域网来源，避免暴露到公网被灌数据 */
function isLanClient(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('169.254.')) return true;
  // 简单私网段判断
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

// ---------------- 上传：分块断点续传 ----------------

async function handleUploadInit(req, res, url) {
  const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
  const name = String(body.name || 'unnamed');
  const total = Number(body.total) || 0;
  const mtime = Number(body.mtime) || 0;
  if (!total || total <= 0) return json(res, 400, { ok: false, error: 'total required' });
  if (total > 8 * 1024 * 1024 * 1024) return json(res, 413, { ok: false, error: 'file too large' });

  const uploadId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const tmp = path.join(CONFIG.cacheDir, 'parts', `${uploadId}.part`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, Buffer.alloc(0));
  sessions.set(uploadId, { tmp, offset: 0, total, name, mtime, receivedAt: Date.now() });
  setTimeout(() => cleanupSession(uploadId), SESSION_TTL);
  return json(res, 200, { ok: true, uploadId, offset: 0 });
}

function cleanupSession(uploadId) {
  const s = sessions.get(uploadId);
  if (!s) return;
  try { fs.existsSync(s.tmp) && fs.unlinkSync(s.tmp); } catch {}
  sessions.delete(uploadId);
}

async function handleUploadChunk(req, res, url) {
  const uploadId = url.searchParams.get('uploadId');
  const s = sessions.get(uploadId);
  if (!s) return json(res, 404, { ok: false, error: 'upload session expired' });

  const chunk = await readBody(req, 64 * 1024 * 1024);
  const start = Number(url.searchParams.get('start'));
  if (!Number.isFinite(start) || start < 0) return json(res, 400, { ok: false, error: 'start required' });

  // 用 filehandle 精确定位写入。不能用 writeFile + 'w' 兜底——那会截断文件，
  // 续传时把已收到的数据全弄丢。也不能开 'a'，那会忽略 position 追加到末尾。
  const fh = await fs.promises.open(s.tmp, 'r+').catch(() => fs.promises.open(s.tmp, 'w+'));
  try {
    let written = 0;
    while (written < chunk.length) {
      const { bytesWritten } = await fh.write(chunk, written, chunk.length - written, start + written);
      if (bytesWritten <= 0) break;
      written += bytesWritten;
    }
    const finalSize = (await fh.stat()).size;
    s.offset = Math.max(s.offset, start + written, finalSize);
  } finally {
    await fh.close();
  }
  s.receivedAt = Date.now();
  const done = s.offset >= s.total;
  return json(res, 200, { ok: true, received: s.offset, total: s.total, done });
}

async function handleUploadFinish(req, res, url) {
  const uploadId = url.searchParams.get('uploadId');
  const s = sessions.get(uploadId);
  if (!s) return json(res, 404, { ok: false, error: 'upload session expired' });

  let buf;
  try {
    buf = await fs.promises.readFile(s.tmp);
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
  if (buf.length !== s.total) {
    // 长度不符直接驳回，让客户端续传而不是写入残缺文件
    s.offset = buf.length;
    return json(res, 409, { ok: false, error: 'size mismatch', received: buf.length, total: s.total });
  }

  const hash = sha256(buf);
  const result = await store.save({
    buffer: buf,
    name: s.name,
    hash,
    mtime: s.mtime,
  });
  cleanupSession(uploadId);

  if (result.status === 'saved') {
    uploadedThisSession++;
    lastUploadAt = Date.now();
    // 后台生成缩略图，不阻塞响应
    store.thumbnail(hash).catch(() => {});
    broadcast({ type: 'upload', data: { hash, name: s.name, rel: result.rel, takenAt: result.takenAt, size: buf.length } });
    console.log(`[+] ${new Date(result.takenAt || Date.now()).toISOString().slice(0, 10)}  ${s.name}  ->  ${result.rel}`);
  }
  return json(res, 200, { ok: true, ...result });
}

async function handleBatchQuery(req, res, url) {
  const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
  const items = Array.isArray(body.items) ? body.items : [];
  const known = {};
  for (const it of items) {
    if (it && it.hash) known[it.hash] = store.has(it.hash);
  }
  return json(res, 200, { ok: true, known });
}

async function handleThumb(req, res, url) {
  const hash = url.searchParams.get('hash');
  const p = await store.thumbnail(hash, 400);
  if (!p) return json(res, 404, { ok: false, error: 'no thumb' });
  const st = fs.statSync(p);
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=86400' });
  fs.createReadStream(p).pipe(res);
}

function handleOriginal(req, res, url) {
  const hash = url.searchParams.get('hash');
  const v = store.index.get(hash);
  if (!v) return json(res, 404, { ok: false, error: 'not found' });
  const abs = path.join(CONFIG.destDir, v.rel);
  if (!abs.startsWith(CONFIG.destDir) || !fs.existsSync(abs)) return json(res, 404, { ok: false, error: 'gone' });
  const st = fs.statSync(abs);
  res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `inline; filename="${encodeURIComponent(v.name)}"` });
  fs.createReadStream(abs).pipe(res);
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify(statusPayload())}\n\n`);
  clients.add(res);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 20000);
  ping.unref?.();
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Range, X-Upload-Meta');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  try {
    if (p === '/api/status') return json(res, 200, statusPayload());
    if (p === '/api/events') return handleEvents(req, res);
    if (p === '/api/recent') return json(res, 200, { ok: true, items: store.recent(Number(url.searchParams.get('limit')) || 60) });

    // 写操作限制在局域网内
    if (!isLanClient(req)) {
      return json(res, 403, { ok: false, error: '仅允许局域网访问' });
    }

    if (p === '/api/upload/init' && req.method === 'POST') return await handleUploadInit(req, res, url);
    if (p === '/api/upload/chunk' && req.method === 'POST') return await handleUploadChunk(req, res, url);
    if (p === '/api/upload/finish' && req.method === 'POST') return await handleUploadFinish(req, res, url);
    if (p === '/api/batch-query' && req.method === 'POST') return await handleBatchQuery(req, res, url);
    if (p === '/api/thumb') return handleThumb(req, res, url);
    if (p === '/api/original') return handleOriginal(req, res, url);
    if (p === '/api/open-folder') return await handleOpenFolder(req, res);
    if (p === '/api/wake' && req.method === 'POST') return await handleWake(req, res);
    if (p === '/api/config' && req.method === 'POST') return await handleConfig(req, res);

    if (req.method === 'GET') return serveStatic(req, res, p);
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error('[!] 处理请求出错', p, e);
    return json(res, 500, { ok: false, error: e.message });
  }
});

async function handleOpenFolder(req, res) {
  try {
    await execFileAsync('/usr/bin/open', [CONFIG.destDir]);
    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
}

async function handleWake(req, res) {
  // 手动叫醒其他设备 / 或触发本机补处理。Mac 自己睡眠时服务不跑，收不到这个请求，
  // 所以这个接口的真实用途是给手机端一个"探活 + 提示唤醒 Mac"的手动按钮。
  return json(res, 200, { ok: true, hint: SLEEPING_HINT });
}

async function handleConfig(req, res) {
  const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
  if (typeof body.autostart !== 'boolean') return json(res, 400, { ok: false, error: 'autostart must be boolean' });
  CONFIG.autostart = body.autostart;
  saveConfig();
  return json(res, 200, { ok: true, autostart: CONFIG.autostart });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  ✗ 端口 ${CONFIG.port} 已被占用。`);
    console.error('    多半是服务已经在跑了。先停掉旧的：');
    console.error(`      lsof -ti tcp:${CONFIG.port} | xargs kill`);
    console.error(`    或换个端口：编辑 ~/.phonesync/config.json 里的 port 字段。`);
    console.error('');
  } else {
    console.error('[!] 服务启动失败:', e.message);
  }
  process.exit(1);
});

server.listen(CONFIG.port, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log('');
  console.log('  PhoneSync Hub 已启动');
  console.log('  ─────────────────────────────────────────');
  console.log(`  接收目录  ${CONFIG.destDir}`);
  console.log(`  电脑地址  http://${os.hostname()}.local:${CONFIG.port}`);
  for (const i of ips) console.log(`  局域网    http://${i.address}:${CONFIG.port}   (${i.iface})`);
  console.log(`  WiFi      ${wifi.snapshot().label || '未连接'}`);
  console.log(`  已归档    ${store.index.size} 个文件`);
  console.log('  ─────────────────────────────────────────');
  console.log('  手机打开上面任意局域网地址即可同步');
  console.log('');
  broadcast({ type: 'hello', data: statusPayload() });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\n正在保存索引并退出...');
    try { await store.save(); } catch {}
    process.exit(0);
  });
}
process.on('uncaughtException', (e) => console.error('[!] uncaught:', e));
process.on('unhandledRejection', (e) => console.error('[!] unhandled:', e));
