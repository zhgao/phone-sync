#!/bin/bash
# 开机自启：把服务注册为 LaunchAgent（用户级，无需 sudo）
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.phonesync.hub.plist"
LOG_DIR="$HOME/.phonesync"

# Node 路径：优先用 PATH 里的，找不到再退回 WorkBuddy 托管的版本
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for candidate in "$HOME"/.workbuddy/binaries/node/versions/*/bin/node; do
    [ -x "$candidate" ] && NODE_BIN="$candidate" && break
  done
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "找不到 node。请安装 Node.js 18+，或把它加进 PATH。"
  exit 1
fi

mkdir -p "$LOG_DIR" "$HOME/Pictures/来自OPPO手机"
mkdir -p "$(dirname "$PLIST")"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.phonesync.hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/launchd.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST_EOF

# 卸载旧版再装载，确保配置生效
launchctl bootout "gui/$(id -u)/com.phonesync.hub" 2>/dev/null || true
LOAD_OUT="$(launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>&1)" || LOAD_OUT="$(launchctl load -w "$PLIST" 2>&1)"
sleep 1

if launchctl print "gui/$(id -u)/com.phonesync.hub" >/dev/null 2>&1; then
  STARTED="✓ 已注册开机自启并启动"
else
  STARTED="! plist 已就绪，但未能自动启动"
fi

IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '127.0.0.1')"
PORT="$(/usr/libexec/PlistBuddy -c 'Print :port' "$HOME/.phonesync/config.json" 2>/dev/null || echo 8848)"

cat <<EOF

  $STARTED

  手机打开：  http://$IP:$PORT
  在 Chrome 里选「添加到主屏幕」，桌面上就有独立图标了。

  开机自启：  plist 已装到 $PLIST
  停止服务：  launchctl bootout gui/$(id -u)/com.phonesync.hub
EOF

if [ "$STARTED" != "✓ 已注册开机自启并启动" ]; then
  cat <<EOF

  提示：某些环境不允许脚本操作 launchd。plist 已经装好，
        你可以到「系统设置 → 通用 → 登录项」里确认，或手动启动：
           cd $DIR && node server.js
EOF
fi
