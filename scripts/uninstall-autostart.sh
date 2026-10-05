#!/bin/bash
# 关闭并移除开机自启
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.phonesync.hub.plist"
UID_NUM="$(id -u)"

launchctl bootout "gui/$UID_NUM/com.phonesync.hub" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null || true
[ -f "$PLIST" ] && rm -f "$PLIST"
echo "✓ 已移除开机自启（照片和索引都保留在原处）"
