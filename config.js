import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// config.js 就在项目根目录，前端资源在同级 public/，
// 不能再往上退一层——退了会导致 publicDir 指向不存在的位置，页面全部 404
// 但 API 测试却全绿。这种故障最难查，前端资源路径必须逐个断言。
const ROOT = __dirname;

const STATE_DIR = path.join(os.homedir(), '.phonesync');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');

const DEFAULTS = {
  port: 8848,
  destDir: path.join(os.homedir(), 'Pictures', '手机照片'),
  cacheDir: path.join(STATE_DIR, 'cache'),
  stateDir: STATE_DIR,
  publicDir: path.join(ROOT, 'public'),
  autostart: false,
};

function ensure() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(DEFAULTS.destDir, { recursive: true });
  fs.mkdirSync(DEFAULTS.cacheDir, { recursive: true });
}

export const CONFIG = { ...DEFAULTS };

export function loadConfig() {
  ensure();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    Object.assign(CONFIG, raw);
    // 目录以本机实际情况为准，避免配置被拷走后指到不存在的盘
    CONFIG.publicDir = DEFAULTS.publicDir;
    CONFIG.stateDir = STATE_DIR;
    if (!fs.existsSync(CONFIG.destDir)) fs.mkdirSync(CONFIG.destDir, { recursive: true });
  } catch {
    saveConfig();
  }
  return CONFIG;
}

export function saveConfig() {
  try {
    const out = { ...CONFIG, publicDir: undefined, stateDir: undefined };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2), 'utf8');
  } catch (e) {
    console.error('[config] 保存失败:', e.message);
  }
}

loadConfig();
