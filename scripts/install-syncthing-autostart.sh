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

# 已注册就先 bootout 再重新装载（配置变了需要重载）
# 但 bootout+bootstrap 在部分环境会失败（launchctl 的 gui domain 限制），
# 所以：只有确实已注册时才 bootout，之后优先 bootstrap，失败再退回 load。
if launchctl print "gui/$UID_NUM/com.syncthing.syncthing" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID_NUM/com.syncthing.syncthing" 2>/dev/null || true
  sleep 1
fi

LOADED=0
if launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
  LOADED=1
elif launchctl load -w "$PLIST" 2>/dev/null; then
  LOADED=1
fi

# 两条路都没成（比如 GUI 版已经在跑占着），退回用 open 拉起，
# 保证「装完之后能用」这个结果，而不是死磕 launchctl。
if [ "$LOADED" -ne 1 ]; then
  open -a Syncthing 2>/dev/null || true
fi

IP="$(ipconfig getifaddr en0 2>/dev/null || echo '127.0.0.1')"
echo

# launchd 注册成功 != 进程活着。Syncthing 冷启动要 10-20 秒
# （测哈希性能、连中继、扫本地设备），只查 launchd 会误报成功。
# 这里轮询等端口真起来，最多等 40 秒。
WAITED=0
LISTENING=0
while [ "$WAITED" -lt 40 ]; do
  if lsof -nP -iTCP:8384 -sTCP:LISTEN 2>/dev/null | grep -qi syncthing; then
    LISTENING=1
    break
  fi
  sleep 2
  WAITED=$((WAITED + 2))
  printf '.'
done
echo

REGISTERED=0
if launchctl print "gui/$UID_NUM/com.syncthing.syncthing" >/dev/null 2>&1; then
  REGISTERED=1
fi

if [ "$REGISTERED" -eq 1 ] && [ "$LISTENING" -eq 1 ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://$IP:8384/" 2>/dev/null)"
  if [ "$CODE" = "200" ]; then
    echo "  [OK] Syncthing 已启动, 开机自启已注册"
  else
    echo "  [!] 端口在监听, 但 HTTP 返回 $CODE (手机可能连不上)"
  fi
  echo
  echo "  Web UI:"
  echo "    本机    http://127.0.0.1:8384"
  echo "    手机    http://$IP:8384"
  echo
  echo "  日志: $LOG_DIR/syncthing.out.log"
  echo "  停止: launchctl bootout gui/$UID_NUM/com.syncthing.syncthing"
else
  if [ "$REGISTERED" -eq 1 ]; then
    echo "  [!] 已注册开机自启, 但进程没起来 (等了 ${WAITED} 秒)"
  else
    echo "  [!] plist 已装到 ${PLIST}, 但未能注册"
  fi
  echo
  echo "      手动启动:  open -a Syncthing"
  echo "      或到「系统设置 -> 通用 -> 登录项」里添加"
  echo "      错误日志: $LOG_DIR/syncthing.err.log"
  echo "      输出日志: $LOG_DIR/syncthing.out.log"
fi

# 注册但没起来时返回非零，让上层脚本能感知
[ "$REGISTERED" -eq 1 ] && [ "$LISTENING" -eq 1 ]

