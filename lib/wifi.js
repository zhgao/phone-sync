// WiFi 状态监听：告诉前端「你现在是不是在家里 / 有没有连上 WiFi」
// 用 networksetup 轮询，比解析 airport 稳定（后者在新版 macOS 已移除）
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function getWiFiDevice() {
  // 优先 Wi-Fi 硬件接口
  try {
    const { stdout } = await execFileAsync('/usr/sbin/networksetup', ['-listallhardwareports'], { timeout: 8000 });
    const lines = stdout.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/Hardware Port:\s*Wi-?Fi/i.test(lines[i]) && lines[i + 1]) {
        const m = lines[i + 1].match(/Device:\s*(\S+)/i);
        if (m) return m[1];
      }
    }
  } catch { /* fallthrough */ }
  return null;
}

export class WifiWatcher {
  constructor() {
    this.ssid = null;
    this.connected = false;
    this.associated = false;
    this.ssidHidden = false;
    this.device = null;
    this.error = null;
    this.lastCheck = 0;
    this._timer = null;
    this._listeners = new Set();
  }

  async start() {
    this.device = await getWiFiDevice();
    await this.check();
    // 15 秒轮询一次：太密没意义，太疏会错过到家时刻
    this._timer = setInterval(() => this.check().catch(() => {}), 15000);
    this._timer.unref?.();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  async check() {
    if (!this.device) {
      // 没有 Wi-Fi 硬件（有线连接 / 虚拟机），如实反映
      this.connected = false;
      this.ssid = null;
      this.associated = false;
      this.error = '未找到 Wi-Fi 接口（可能用的是网线）';
      this.lastCheck = Date.now();
      this._emit();
      return;
    }
    const prev = { ssid: this.ssid, connected: this.connected, associated: this.associated };
    try {
      const { stdout } = await execFileAsync(
        '/usr/sbin/networksetup',
        ['-getairportnetwork', this.device],
        { timeout: 8000 }
      );
      const m = stdout.match(/Current Wi-?Fi Network:\s*(.+)/i);
      const name = m ? m[1].trim() : '';
      this.ssid = name && !/not associated/i.test(name) ? name : null;
      this.connected = !!this.ssid;
    } catch (e) {
      this.error = e.message;
      this.connected = false;
      this.ssid = null;
    }

    // networksetup 在新版 macOS / 隐藏 SSID 场景下会谎报「未连接」，
    // 用系统配置里的链路状态做二次校验，避免把连着的 WiFi 判成断线
    const assoc = await this._probeAssociated();
    this.associated = assoc.associated;
    if (!this.connected && assoc.associated) {
      this.connected = true;
      this.ssidHidden = true;
    } else if (this.connected) {
      this.ssidHidden = false;
    }

    this.lastCheck = Date.now();
    if (prev.ssid !== this.ssid || prev.connected !== this.connected || prev.associated !== this.associated) this._emit();
  }

  /** 读 en0 的链路状态：有 IP + 是 Wi-Fi 硬件 → 视为已连上 AP */
  async _probeAssociated() {
    try {
      const { stdout } = await execFileAsync('/usr/sbin/ipconfig', ['getsummary', this.device], { timeout: 8000 });
      const hasIPv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(stdout);
      const hasDhcp = /ConfigMethod\s*:\s*DHCP/.test(stdout);
      return { associated: hasIPv4 || hasDhcp };
    } catch {
      return { associated: false };
    }
  }

  _emit() {
    for (const fn of this._listeners) {
      try { fn(this.snapshot()); } catch {}
    }
  }

  snapshot() {
    return {
      ssid: this.ssid,
      connected: this.connected,
      associated: this.associated,
      ssidHidden: this.ssidHidden,
      label: this.ssid || (this.connected ? '已连接（网络名已隐藏）' : null),
      device: this.device,
      error: this.error,
      lastCheck: this.lastCheck,
    };
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
  }
}
