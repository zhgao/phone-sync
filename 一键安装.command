#!/bin/bash
# PhoneSync 一键安装器 (Mac 端) 
#
# 装好之后: 开机自启, 崩溃自动重启, 照片自动落到 ~/Pictures/手机照片
# 可重复执行, 已装过的部分会跳过
#
# 用法: 双击运行, 或
#   bash 一键安装.command

set -uo pipefail

APP_NAME="Syncthing"
APP="/Applications/${APP_NAME}.app"
RECV_DIR="$HOME/Pictures/手机照片"
STATE_DIR="$HOME/.phonesync"
UID_NUM="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/com.syncthing.syncthing.plist"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1;34m> %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[1;31m[X]\033[0m %s\n' "$*"; exit 1; }

say ""
say "============================================"
say "  PhoneSync 安装器 · Mac 端"
say "============================================"

# ---------------------------------------------------------------- 1. Node
step "检查运行环境"
if command -v node >/dev/null 2>&1 && [ "$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/')" -ge 18 ] 2>/dev/null; then
  ok "Node.js $(node -v)"
  HAVE_NODE=1
else
  HB_NODE=""
  for c in "$HOME"/.workbuddy/binaries/node/versions/*/bin/node; do
    [ -x "$c" ] && HB_NODE="$c" && break
  done
  if [ -n "$HB_NODE" ]; then
    ok "Node.js 托管版本 ${HB_NODE##*/node}"
    HAVE_NODE=1
  else
    warn "未找到 Node.js 18+ (网页版服务需要, Syncthing 不需要) "
    HAVE_NODE=0
  fi
fi

# ---------------------------------------------------------------- 1b. adb
step "安装 adb (手机一键配置需要)"
ADB="$HOME/.local/bin/adb"
if [ -x "$ADB" ]; then
  ok "adb 已就绪"
elif command -v adb >/dev/null 2>&1; then
  ok "adb 已安装 ($ADB)"
else
  say "  下载中 (16MB)..."
  PT_TMP="$(mktemp -d)"
  PT_URL="https://dl.google.com/android/repository/platform-tools_r37.0.1-darwin.zip"
  if curl -sL --noproxy '*' -o "$PT_TMP/pt.zip" "$PT_URL" && [ -s "$PT_TMP/pt.zip" ]; then
    mkdir -p "$HOME/.local"
    unzip -q -o "$PT_TMP/pt.zip" -d "$PT_TMP"
    cp -R "$PT_TMP/platform-tools" "$HOME/.local/"
    mkdir -p "$HOME/.local/bin"
    ln -sf "$HOME/.local/platform-tools/adb" "$ADB"
    ln -sf "$HOME/.local/platform-tools/fastboot" "$HOME/.local/bin/fastboot"
    ok "adb 安装完成"
  else
    warn "adb 下载失败, 手机端将需要手动安装"
  fi
  rm -rf "$PT_TMP" 2>/dev/null || true
fi

# ------------------------------------------------------------ 2. Syncthing
step "安装 Syncthing"
if [ -d "$APP" ]; then
  ok "已安装, 跳过"
else
  DMG="$(ls -t "$HOME"/Library/Caches/Homebrew/downloads/*[Ss]yncthing*.dmg 2>/dev/null | head -1)"
  if [ -n "$DMG" ]; then
    say "  从缓存 DMG 安装..."
    hdiutil attach "$DMG" -nobrowse -quiet
    cp -R "/Volumes/${APP_NAME}/${APP_NAME}.app" /Applications/
    hdiutil detach "/Volumes/${APP_NAME}" -quiet
    [ -d "$APP" ] && ok "安装完成" || die "安装失败"
  elif command -v brew >/dev/null 2>&1; then
    say "  用 Homebrew 安装 (需要几分钟) ..."
    brew install --cask syncthing-app >/dev/null 2>&1
    [ -d "$APP" ] && ok "安装完成" || die "brew 安装失败, 可手动下载: https://syncthing.net/download/"
  else
    die "请手动安装 Syncthing: https://syncthing.net/download/ 装好后重跑本脚本"
  fi
fi

BIN="$APP/Contents/Resources/syncthing/syncthing"
[ -x "$BIN" ] || die "Syncthing 可执行文件不存在: $BIN"

# --------------------------------------------------------- 3. 目录与配置
step "准备目录"
mkdir -p "$RECV_DIR" "$STATE_DIR"
ok "照片接收目录 $RECV_DIR"

step "配置 Syncthing"
# 先确保它跑起来一次以生成 config.xml
if [ ! -f "$HOME/Library/Application Support/Syncthing/config.xml" ]; then
  say "  首次运行, 生成配置..."
  "$BIN" --no-browser --no-restart >/dev/null 2>&1 &
  NEW_PID=$!
  for _ in $(seq 1 20); do
    [ -f "$HOME/Library/Application Support/Syncthing/config.xml" ] && break
    sleep 1
  done
  kill "$NEW_PID" 2>/dev/null || true
  sleep 1
fi

CFG="$HOME/Library/Application Support/Syncthing/config.xml"
[ -f "$CFG" ] || die "Syncthing 配置未生成"

if ! "$SCRIPT_DIR/scripts/setup-syncthing.sh" 2>&1 | sed 's/^/  /'; then
  warn "Syncthing 配置脚本返回非零, 请看上面的输出"
fi

# ------------------------------------------------------------ 4. 开机自启
step "配置开机自启"
if ! "$SCRIPT_DIR/scripts/install-syncthing-autostart.sh" 2>&1 | sed 's/^/  /'; then
  warn "开机自启脚本返回非零, 可稍后手动跑 scripts/install-syncthing-autostart.sh"
fi

# --------------------------------------------- 4b. 创建共享文件夹（核心）
# 必须放在自启之后：要用 REST API 连上正在跑的 Syncthing。
# 这一步是整个项目的中枢——没有共享文件夹，Syncthing 跑着也没地方可传。
step "创建共享文件夹"
sleep 3   # 等 Syncthing 起来
if python3 "$SCRIPT_DIR/scripts/setup-folder-api.py" 2>&1 | sed 's/^/  /'; then
  :
else
  warn "共享文件夹创建失败, 手机端配对了也传不过来"
fi

# ---------------------------------------------------------------- 5. 收尾
step "预下载手机端安装包"
APK_DIR="$STATE_DIR/apk"
mkdir -p "$APK_DIR"
if [ -s "$APK_DIR/syncthing.apk" ]; then
  ok "安装包已缓存 ($(du -h "$APK_DIR/syncthing.apk" | cut -f1))"
else
  say "  下载 Syncthing 安卓版 (51MB)..."
  APK_URL="$(curl -sL "https://api.github.com/repos/syncthing/syncthing-android/releases/latest" 2>/dev/null \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((a['browser_download_url'] for a in d.get('assets',[]) if a['name']=='app-release.apk'),''))" 2>/dev/null)"
  if [ -n "$APK_URL" ]; then
    if curl -sL --noproxy '*' -o "$APK_DIR/syncthing.apk" "$APK_URL" && [ -s "$APK_DIR/syncthing.apk" ]; then
      ok "下载完成, 手机端配置时直接用"
    else
      warn "下载失败, 手机端配置时会重试"
      rm -f "$APK_DIR/syncthing.apk"
    fi
  else
    warn "获取下载地址失败, 手机端配置时会重试"
  fi
fi

DEVICE_ID="$(python3 -c "
import io,re,os
s=io.open(os.path.expanduser('~/Library/Application Support/Syncthing/config.xml'),encoding='utf-8').read()
m=re.search(r'<device id=\"([A-Z0-9-]{40,})\"',s)
print(m.group(1) if m else '')
" 2>/dev/null)"

IP="$(ipconfig getifaddr en0 2>/dev/null || echo '127.0.0.1')"

# ------------------------------------------------------------------ 验证
# 不验证就报"完成"是自欺欺人。下面每项都真查一次。
step "验证安装"
FAILED=0
if launchctl print "gui/$UID_NUM/com.syncthing.syncthing" >/dev/null 2>&1; then
  ok "开机自启已注册"
else
  warn "开机自启未生效"
  FAILED=1
fi
if lsof -nP -iTCP:8384 -sTCP:LISTEN 2>/dev/null | grep -qi syncthing; then
  ok "Syncthing 正在运行, 监听 8384"
else
  warn "Syncthing 未监听 8384"
  FAILED=1
fi
HTTP="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://$IP:8384/" 2>/dev/null)"
if [ "$HTTP" = "200" ]; then
  ok "局域网可访问 (http://$IP:8384 返回 200)"
else
  warn "局域网访问异常 (返回 $HTTP), 手机可能连不上"
  FAILED=1
fi
[ -d "$RECV_DIR" ] && ok "接收目录就绪" || { warn "接收目录不存在"; FAILED=1; }
if [ -n "$DEVICE_ID" ]; then
  ok "设备 ID 可读取"
else
  warn "读不到设备 ID"
  FAILED=1
fi

# 最关键的一项：Syncthing 是否真的加载了共享文件夹。
# 之前的版本漏了这项，导致「5 项全过」但实际没地方可传 —— 假成功。
FOLDER_OK="$(python3 -c "
import http.client, io, os, re, json
cfg = os.path.expanduser('~/Library/Application Support/Syncthing/config.xml')
s = io.open(cfg, encoding='utf-8').read()
k = re.search(r'<apikey>([^<]+)</apikey>', s)
if not k:
    print('nokey'); raise SystemExit
c = http.client.HTTPConnection('127.0.0.1', 8384, timeout=15)
c.request('GET', '/rest/config/folders', headers={'X-API-Key': k.group(1)})
d = json.loads(c.getresponse().read().decode())
good = [f for f in d if f.get('id') == 'phone-photos' and f.get('path')]
print('%d' % len(good))
" 2>/dev/null)"

if [ "$FOLDER_OK" = "1" ]; then
  ok "共享文件夹已创建 (Syncthing 已加载)"
elif [ "$FOLDER_OK" = "0" ]; then
  warn "Syncthing 没加载到共享文件夹 —— 手机端配对了也传不过来"
  warn "  修复: python3 scripts/setup-folder-api.py"
  FAILED=1
else
  warn "无法查询 Syncthing API (apikey 读不到)"
  FAILED=1
fi

printf '\n'
if [ "$FAILED" -ne 0 ]; then
  printf '\033[1;33m  Mac 端已装, 但有项目没通过检查 (见上面的 ! )\033[0m\n\n'
else
  printf '\033[1;32m============================================\033[0m\n'
  printf '\033[1;32m  Mac 端安装完成, 全部检查通过\033[0m\n'
  printf '\033[1;32m============================================\033[0m\n\n'
fi

say "  Web UI (手机也能开):"
say "    http://127.0.0.1:8384"
say "    http://$IP:8384"
say ""
say "  照片存到:"
say "    $RECV_DIR"
say ""
if [ -n "$DEVICE_ID" ]; then
  say "  设备 ID (手机配对用, 可直接复制):"
  printf '    \033[1;33m%s\033[0m\n' "$DEVICE_ID"
  say ""
fi

if [ "$HAVE_NODE" = "1" ]; then
  say "  下一步: 在手机浏览器打开 http://$IP:8384 配对"
else
  say "  下一步: 手机装好 Syncthing 后, 用上面的设备 ID 配对"
fi
say ""
say "  手机端一键配置 (需数据线) : "
say "    bash 一键配置手机.command"
say ""

printf '按回车关闭…'
read -r _ || true

# 退出码必须反映验证结果，否则调用方（脚本/CI）无法判断成功与否。
# 放在 read 之后：双击运行时等用户确认，但退出码照样带出去。
if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
exit 0
