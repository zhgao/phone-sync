/* PhoneSync 手机端 —— 分块断点续传 + 哈希去重 + 目录句柄持久化 */
(() => {
'use strict';

const CHUNK = 4 * 1024 * 1024;
const LS_Q = 'phonesync.queue.v1';
const LS_DIR = 'phonesync.dirhandle.v1';
const LS_DONE = 'phonesync.done.v1';

const $ = (id) => document.getElementById(id);
const el = {
  sub: $('sub'), dot: $('dot'), ft: $('ft'), log: $('log'), logBody: $('logBody'),
  picker: $('picker'), fileInput: $('fileInput'), dirBtn: $('dirBtn'),
  queueCard: $('queueCard'), qCount: $('qCount'), qList: $('qList'),
  syncBtn: $('syncBtn'), stopBtn: $('stopBtn'), clearQ: $('clearQ'),
  sIndexed: $('sIndexed'), sSent: $('sSent'), sSize: $('sSize'),
  banner: $('sleepBanner'), sleepText: $('sleepText'),
};

let queue = load(LS_Q, []);
let done = load(LS_DONE, {});   // hash -> 1，本机已传过
let sentThisRun = 0;
let running = false;
let abort = false;
let online = false;
let dirHandle = null;

/* ---------- 工具 ---------- */
function load(k, dflt) { try { return JSON.parse(localStorage.getItem(k)) ?? dflt; } catch { return dflt; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
function fmtSize(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), 4);
  return (b / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}
function log(s) {
  el.log.hidden = false;
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  el.logBody.textContent = `${el.logBody.textContent}${t}  ${s}\n`.split('\n').slice(-60).join('\n');
  el.logBody.scrollTop = el.logBody.scrollHeight;
}
async function sha256Blob(blob) {
  // 大文件直接全量哈希会卡 UI，但 4MB 一块边读边算是最稳妥的
  const buf = await blob.arrayBuffer();
  if (buf.byteLength <= 32 * 1024 * 1024) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // 大文件：前 1MB + 大小 + 尾部 1MB 的组合指纹，足够去重且快得多
  const head = await blob.slice(0, 1024 * 1024).arrayBuffer();
  const tail = await blob.slice(-1024 * 1024).arrayBuffer();
  const meta = new TextEncoder().encode(`${blob.size}:${blob.name}:${blob.lastModified}`);
  const all = new Uint8Array(head.byteLength + tail.byteLength + meta.byteLength);
  all.set(new Uint8Array(head), 0);
  all.set(new Uint8Array(tail), head.byteLength);
  all.set(meta, head.byteLength + tail.byteLength);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))]
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- 队列 ---------- */
function persist() { save(LS_Q, queue.map(q => ({ ...q, file: undefined, _h: q.hash }))); }

async function addFiles(files) {
  const arr = [...files].filter(f => /^(image|video)\//.test(f.type) || /\.(jpe?g|png|heic|heif|gif|webp|dng|cr2|nef|arw|mp4|mov|m4v|3gp)$/i.test(f.name));
  if (!arr.length) return log('没有可识别的图片/视频');
  log(`加入 ${arr.length} 个文件`);
  for (const f of arr) {
    const item = { file: f, name: f.name, size: f.size, mtime: Math.floor((f.lastModified || Date.now()) / 1000), hash: null, status: 'wait', sent: 0, err: null };
    try {
      item.hash = await sha256Blob(f);
      if (done[item.hash]) { item.status = 'skip'; }
    } catch (e) { item.status = 'err'; item.err = '读取失败'; }
    queue.push(item);
    render();
  }
  render();
  await maybeAutoSync();
}

/* ---------- 渲染 ---------- */
function render() {
  const n = queue.length;
  el.qCount.textContent = n;
  el.queueCard.hidden = n === 0;
  el.syncBtn.textContent = running ? '同步中…' : (n ? `开始同步（${n}）` : '开始同步');
  el.syncBtn.disabled = running;
  el.stopBtn.hidden = !running;
  el.sentEl = null;

  const frag = document.createDocumentFragment();
  for (const q of queue) {
    const row = document.createElement('div');
    row.className = 'qi';

    const isVid = (q.file && q.file.type && q.file.type.startsWith('video/'));
    if (isVid) {
      const d = document.createElement('div');
      d.className = 'qi-th vid'; d.textContent = '🎬';
      row.appendChild(d);
    } else {
      const img = document.createElement('img');
      img.className = 'qi-th'; img.loading = 'lazy'; img.alt = '';
      if (q.file && q.file.type && q.file.type.startsWith('image/')) {
        img.src = URL.createObjectURL(q.file);
        img.onload = img.onerror = () => URL.revokeObjectURL(img.src);
      }
      row.appendChild(img);
    }

    const m = document.createElement('div');
    m.className = 'qi-m';
    const nEl = document.createElement('div'); nEl.className = 'qi-n'; nEl.textContent = q.name;
    const sEl = document.createElement('div'); sEl.className = 'qi-s'; sEl.textContent = fmtSize(q.size);
    m.appendChild(nEl); m.appendChild(sEl);
    if (q.status === 'up' && q.size) {
      const bar = document.createElement('div'); bar.className = 'bar';
      const i = document.createElement('i'); i.style.width = Math.min(100, (q.sent / q.size) * 100).toFixed(1) + '%';
      bar.appendChild(i); m.appendChild(bar);
    }
    row.appendChild(m);

    const x = document.createElement('div');
    const map = {
      wait: ['st-d', '待传'], up: ['st-u', '传输中'], done: ['st-s', '完成'],
      skip: ['st-s', '已存在'], err: ['st-e', '失败'],
    };
    const [cls, txt] = map[q.status] || map.wait;
    x.className = 'qi-x ' + cls;
    x.textContent = txt;
    if (q.err) x.title = q.err;
    row.appendChild(x);
    frag.appendChild(row);
  }
  el.qList.replaceChildren(frag);
}

function setStat() {
  el.sIndexed.textContent = stats ? stats.indexed : '–';
  el.sSent.textContent = String(sentThisRun);
  el.sSize.textContent = stats ? fmtSize(stats.disk.bytes) : '–';
}

let stats = null;
let es = null;
let esRetry = 0;

function connect() {
  if (es) { try { es.close(); } catch {} es = null; }
  es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => {
    online = true; esRetry = 0;
    applyStatus(JSON.parse(e.data));
    markOnline();
  });
  es.addEventListener('upload', (e) => {
    const d = JSON.parse(e.data);
    log(`Mac 收到 ${d.name}`);
  });
  es.onerror = () => {
    online = false; markOffline();
    // Mac 睡眠时 SSE 会断，这里退避重连，唤醒后自动接上
    esRetry = Math.min(esRetry + 1, 6);
    setTimeout(connect, 1000 * Math.pow(1.7, esRetry));
  };
}

function markOnline() {
  el.dot.className = 'dot on';
  el.sub.textContent = `已连接 · ${(stats && stats.wifi && stats.wifi.label) || ''}`.trim();
  el.ft.textContent = stats ? `Mac：${stats.host} · 已存 ${stats.indexed} 项` : '已连接';
  el.banner.hidden = true;
  setStat();
}
function markOffline() {
  el.dot.className = 'dot off';
  el.sub.textContent = '未连接到 Mac';
  el.ft.textContent = 'Mac 未响应——可能已睡眠。唤醒 Mac 后本页会自动重连。';
  el.banner.hidden = false;
  el.sleepText.textContent = 'Mac 没响应。打开 Mac 唤醒它，这里会自动继续，已传的不会重复。';
  if (running) { running = false; render(); log('Mac 断开了，已暂停'); }
}

/* ---------- 上传核心 ---------- */
async function uploadOne(q) {
  if (done[q.hash]) { q.status = 'skip'; return 'skip'; }
  q.status = 'up'; q.sent = 0; q.err = null; render();

  const init = await fetch('/api/upload/init', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: q.name, total: q.size, mtime: q.mtime }),
  });
  if (!init.ok) throw new Error('无法建立上传会话');
  const { uploadId, offset } = await init.json();

  let start = offset || 0;
  q.sent = start; render();
  while (start < q.size) {
    if (abort) throw new Error('已停止');
    const end = Math.min(start + CHUNK, q.size);
    const blob = q.file.slice(start, end);
    const r = await fetch(`/api/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&start=${start}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob,
    });
    if (!r.ok) throw new Error(`分块传输失败 (${r.status})`);
    const j = await r.json();
    start = j.received; q.sent = start; render();
  }

  const fin = await fetch(`/api/upload/finish?uploadId=${encodeURIComponent(uploadId)}`, { method: 'POST' });
  if (!fin.ok) throw new Error('提交失败');
  const r = await fin.json();
  q.status = r.status === 'duplicate' ? 'skip' : 'done';
  done[q.hash] = 1; save(LS_DONE, done);
  sentThisRun++;
  render();
  return r.status;
}

async function run() {
  if (running) return;
  running = true; abort = false; render();
  let ok = 0, skipped = 0, failed = 0;
  for (const q of [...queue]) {
    if (abort) break;
    if (q.status === 'done' || q.status === 'skip') { skipped++; continue; }
    try {
      const r = await uploadOne(q);
      if (r === 'duplicate') skipped++; else ok++;
    } catch (e) {
      if (String(e.message).includes('已停止')) break;
      q.status = 'err'; q.err = e.message; failed++;
      log(`✗ ${q.name}：${e.message}`);
      // 网络类错误通常是 Mac 睡眠了，直接停，别把队列刷满错误
      if (/Failed to fetch|NetworkError|失败 \(5|失败 \(0/.test(e.message)) {
        log('判定为 Mac 不可达，暂停同步');
        break;
      }
    }
    render();
  }
  running = false; render();
  log(`完成：新传 ${ok} · 跳过 ${skipped} · 失败 ${failed}`);
  queue = queue.filter(q => q.status === 'err');
  persist(); render(); setStat();
}

async function maybeAutoSync() {
  if (running) return;
  if (queue.some(q => q.status === 'wait' || q.status === 'err')) {
    if (online) run();
  }
}

/* ---------- File System Access：授权后下次能自动扫 ---------- */
const FSA = !!(window.showDirectoryPicker);

async function initDir() {
  if (!FSA) return;
  try {
    const saved = load(LS_DIR, null);
    if (saved) {
      const h = await window.showDirectoryPicker({ mode: 'read', id: 'photosync' }).catch(() => null);
      if (h) { dirHandle = h; el.dirBtn.hidden = true; log('已恢复相册目录授权'); }
    }
  } catch {}
  el.dirBtn.hidden = !dirHandle;
}

async function pickDir() {
  try {
    const h = await window.showDirectoryPicker({ mode: 'read', id: 'photosync' });
    dirHandle = h;
    el.dirBtn.hidden = true;
    log('相册目录已授权');
    await scanDir();
  } catch (e) {
    if (e.name !== 'AbortError') log('目录授权失败：' + e.message);
  }
}

const IMG_RE = /\.(jpe?g|png|heic|heif|gif|webp|dng|cr2|nef|arw)$/i;
const VID_RE = /\.(mp4|mov|m4v|3gp|avi|mkv)$/i;

async function scanDir() {
  if (!dirHandle) return;
  let found = [];
  try {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind !== 'file') continue;
      if (!IMG_RE.test(name) && !VID_RE.test(name)) continue;
      if (/^(IMG|VID|DCIM|SCREENSHOT|PANO|BURST|\.)/i.test(name) || IMG_RE.test(name) || VID_RE.test(name)) {
        try {
          const f = await handle.getFile();
          found.push(f);
        } catch {}
      }
      if (found.length >= 800) break; // 单次别拉太多，交给下一轮
    }
  } catch (e) { log('扫描目录失败：' + e.message); return; }
  if (!found.length) { log('目录里没找到新文件'); return; }
  log(`扫描到 ${found.length} 个文件`);
  await addFiles(found);
  // 扫完关掉句柄权限由浏览器管理，下次自动重授权需要用户手势，这里主动清掉缓存标记
}

function applyStatus(s) {
  stats = s;
  if (s.wifi && !s.wifi.connected) {
    el.sub.textContent = '已连接 · Mac 未连 WiFi';
  }
  setStat();
}

/* ---------- 绑定 ---------- */
el.picker.addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
el.syncBtn.addEventListener('click', run);
el.stopBtn.addEventListener('click', () => { abort = true; log('正在停止…'); });
el.clearQ.addEventListener('click', () => { queue = []; persist(); render(); });
el.dirBtn.addEventListener('click', pickDir);

// 回到前台 / 网络恢复：自动探活 + 续传
document.addEventListener('visibilitychange', () => { if (!document.hidden) { connect(); maybeAutoSync(); } });
window.addEventListener('online', () => { connect(); maybeAutoSync(); });
window.addEventListener('offline', markOffline);

connect();
render();
initDir();
if (FSA) el.dirBtn.hidden = false;

// PWA：可装到主屏
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
