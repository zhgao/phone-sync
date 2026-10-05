#!/bin/bash
# 把 Syncthing 注册为 LaunchAgent（登录即启动，崩溃自动重启）
# 比"登录项"可靠：launchd 会监控进程，挂了会拉起来。
set -euo pipefail

APP="/Applications/Syncthing.app"
PLIST="$HOME/Library/LaunchAgents/com.syncthing.syncthing.plist"
BIN="$APP/Contents/Resources/syncthing/syncthing"
LOG_DIR="$HOME/.phonesync"
UID_NUM="$(id -u)"

[ -x "$BIN" ] || { echo "找不到 Syncthing：$BIN"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# quoted heredoc（<<'PLIST_EOF'）避免变量被提前展开，写完再替换占位符
cat > "$PLIST" <<'PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.syncthing.syncthing</string>
  <key>ProgramArguments</key>
  <array>
    <string>__BIN__</string>
    <string>--no-browser</string>
    <string>--no-restart</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>StandardOutPath</key>
  <string>__LOG_DIR__/syncthing.out.log</string>
  <key>StandardErrorPath</key>
  <string>__LOG_DIR__/syncthing.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>__HOME__</string>
  </dict>
</dict>
</plist>
PLIST_EOF

sed -i '' "s|__BIN__|$BIN|g; s|__LOG_DIR__|$LOG_DIR|g; s|__HOME__|$HOME|g" "$PLIST"

launchctl bootout "gui/$UID_NUM/com.syncthing.syncthing" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST" 2>/dev/null || true
sleep 2

IP="$(ipconfig getifaddr en0 2>/dev/null || echo '127.0.0.1')"
echo

if launchctl print "gui/$UID_NUM/com.syncthing.syncthing" >/dev/null 2>&1; then
  echo "  [OK] Syncthing 已注册开机自启并运行"
  echo
  echo "  Web UI:"
  echo "    本机    http://127.0.0.1:8384"
  echo "    手机    http://$IP:8384"
  echo
  echo "  日志: $LOG_DIR/syncthing.out.log"
  echo "  停止: launchctl bootout gui/$UID_NUM/com.syncthing.syncthing"
else
  echo "  [!] plist 已装到 $PLIST，但未能自动拉起"
  echo
  echo "      请手动启动一次，或到「系统设置 → 通用 → 登录项」里添加 Syncthing。"
  echo "      日志: $LOG_DIR/syncthing.err.log"
fi
